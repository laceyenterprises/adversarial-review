import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { apiStatusFromError, recordApiCall } from './api-telemetry.mjs';
import { getCachedDiff, putCachedDiff } from './diff-cache.mjs';
import { GH_LOOKUP_TIMEOUT_MS, execGhWithRetry } from './gh-cli.mjs';
import { awaitThrottleIfNeeded } from './rate-limit-throttle.mjs';
import { buildGhErrorDetail } from './reviewer-util.mjs';

const execFileAsync = promisify(execFile);
const GITHUB_BLOB_MAX_BUFFER_BYTES = 100 * 1024 * 1024;
const RAW_ADDED_FILE_FETCH_CONCURRENCY = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPullRequestDiffTooLargeError(err) {
  const detail = buildGhErrorDetail(err);
  return (
    /pullrequest\.diff too_large/.test(detail) ||
    /maxbuffer length exceeded/i.test(detail) ||
    (/http\s+406/.test(detail) && /diff exceeded|maximum number of lines|too_large/.test(detail))
  );
}

function parseGhApiArrayPages(stdout) {
  const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '');
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // `gh api --paginate` can concatenate one JSON array per page. Split those
    // top-level arrays without interpreting brackets inside strings.
  }

  const pages = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (ch === ']') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const page = JSON.parse(text.slice(start, index + 1));
        if (Array.isArray(page)) pages.push(...page);
        start = -1;
      }
    }
  }
  return pages;
}

function isLikelyBinaryBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function concatPatchParts(parts) {
  return Buffer.concat(parts.map((part) => Buffer.isBuffer(part) ? part : Buffer.from(String(part))));
}

async function runWithConcurrency(tasks, concurrency) {
  if (!tasks.length) return;
  let nextIndex = 0;
  const workerCount = Math.min(tasks.length, Math.max(1, Number(concurrency) || 1));
  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= tasks.length) return;
      await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

function diffHeaderForFile(file) {
  const filename = String(file?.filename || '').trim();
  const previous = String(file?.previous_filename || '').trim();
  const oldPath = file?.status === 'added' ? '/dev/null' : `a/${previous || filename}`;
  const newPath = file?.status === 'removed' ? '/dev/null' : `b/${filename}`;
  const diffOld = previous || filename;
  const diffNew = filename;
  const sha = String(file?.sha || '').slice(0, 7) || '0000000';
  const lines = [`diff --git a/${diffOld} b/${diffNew}`];
  // The PR files API does not expose file modes, so added/removed modes are synthetic.
  if (file?.status === 'added') lines.push('new file mode 100644');
  if (file?.status === 'removed') lines.push('deleted file mode 100644');
  if (file?.status === 'renamed' && previous && previous !== filename) {
    lines.push(`rename from ${previous}`);
    lines.push(`rename to ${filename}`);
  }
  if (file?.status === 'added') {
    lines.push(`index 0000000..${sha}`);
  } else if (file?.status === 'removed') {
    lines.push(`index ${sha}..0000000`);
  }
  lines.push(`--- ${oldPath}`);
  lines.push(`+++ ${newPath}`);
  return lines;
}

function synthesizeAddedFilePatch(file, content) {
  const header = diffHeaderForFile(file);
  if (isLikelyBinaryBuffer(content)) {
    return `${header.slice(0, 3).join('\n')}\nBinary files /dev/null and b/${file.filename} differ\n`;
  }
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  const hasTrailingNewline = bytes.at(-1) === 0x0a;
  const bodyEnd = hasTrailingNewline ? bytes.length - 1 : bytes.length;
  const lines = [];
  if (bytes.length > 0) {
    let lineStart = 0;
    for (;;) {
      const newlineIndex = bytes.indexOf(0x0a, lineStart);
      if (newlineIndex === -1 || newlineIndex >= bodyEnd) {
        lines.push(bytes.subarray(lineStart, bodyEnd));
        break;
      }
      lines.push(bytes.subarray(lineStart, newlineIndex));
      lineStart = newlineIndex + 1;
    }
  }
  const hunkSpan = lines.length;
  if (hunkSpan === 0) {
    return `${header.slice(0, 3).join('\n')}\n`;
  }
  const patchParts = [
    Buffer.from(`${header.join('\n')}\n@@ -0,0 +1,${hunkSpan} @@\n`),
  ];
  for (const line of lines) {
    patchParts.push(Buffer.from('+'));
    patchParts.push(line);
    patchParts.push(Buffer.from('\n'));
  }
  if (!hasTrailingNewline && bytes.length > 0) {
    patchParts.push(Buffer.from('\\ No newline at end of file\n'));
  }
  return concatPatchParts(patchParts);
}

async function fetchRawAddedFileForDiff(repo, prNumber, file, {
  execFileImpl,
  execGhWithRetryImpl,
  recordApiCallImpl,
  apiStatusFromErrorImpl,
  ghRetrySleepImpl,
  awaitThrottleIfNeededImpl,
}) {
  const startedAt = Date.now();
  const blobSha = String(file?.sha || '').trim();
  try {
    await awaitThrottleIfNeededImpl('core');
    const { stdout } = await execGhWithRetryImpl({
      execFileImpl: async (command, args, options) => execFileImpl(
        command,
        args,
        { ...options, encoding: 'buffer', maxBuffer: GITHUB_BLOB_MAX_BUFFER_BYTES }
      ),
      args: [
        'api',
        '--method',
        'GET',
        `repos/${repo}/git/blobs/${blobSha}`,
        '-H',
        'Accept: application/vnd.github.raw',
      ],
      timeoutMs: Math.max(GH_LOOKUP_TIMEOUT_MS, 60_000),
      sleep: ghRetrySleepImpl,
    });
    recordApiCallImpl({
      category: 'diff_fetch_raw_file',
      repo,
      prNumber,
      status: 200,
      durationMs: Date.now() - startedAt,
    });
    return stdout;
  } catch (err) {
    recordApiCallImpl({
      category: 'diff_fetch_raw_file',
      repo,
      prNumber,
      status: apiStatusFromErrorImpl(err),
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}

async function fetchPRDiffFromFilesApi(repo, prNumber, headSha, {
  execFileImpl,
  execGhWithRetryImpl,
  recordApiCallImpl,
  apiStatusFromErrorImpl,
  ghRetrySleepImpl,
  awaitThrottleIfNeededImpl = awaitThrottleIfNeeded,
  log,
}) {
  const startedAt = Date.now();
  let files;
  try {
    const { stdout } = await execGhWithRetryImpl({
      execFileImpl: async (command, args, options) => execFileImpl(
        command,
        args,
        { ...options, encoding: 'buffer', maxBuffer: GITHUB_BLOB_MAX_BUFFER_BYTES }
      ),
      args: [
        'api',
        '--method',
        'GET',
        '--paginate',
        `repos/${repo}/pulls/${prNumber}/files`,
        '-f',
        'per_page=100',
      ],
      timeoutMs: Math.max(GH_LOOKUP_TIMEOUT_MS, 60_000),
      sleep: ghRetrySleepImpl,
    });
    files = parseGhApiArrayPages(stdout);
    recordApiCallImpl({
      category: 'diff_fetch_files_api',
      repo,
      prNumber,
      status: 200,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    recordApiCallImpl({
      category: 'diff_fetch_files_api',
      repo,
      prNumber,
      status: apiStatusFromErrorImpl(err),
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }

  const patches = new Array(files.length).fill(null);
  const rawFetchTasks = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const filename = String(file?.filename || '').trim();
    if (!filename) continue;
    if (typeof file.patch === 'string' && file.patch.trim()) {
      patches[index] = `${diffHeaderForFile(file).join('\n')}\n${file.patch}\n`;
      continue;
    }
    if (file.status === 'added') {
      rawFetchTasks.push(async () => {
        try {
          const raw = await fetchRawAddedFileForDiff(repo, prNumber, file, {
            execFileImpl,
            execGhWithRetryImpl,
            recordApiCallImpl,
            apiStatusFromErrorImpl,
            ghRetrySleepImpl,
            awaitThrottleIfNeededImpl,
          });
          patches[index] = synthesizeAddedFilePatch(file, raw);
        } catch (err) {
          log.warn?.(`[reviewer] WARN: PR files API raw blob fetch failed for ${repo}#${prNumber} ${filename}: ${err?.message || err}; adding metadata-only diff entry`);
          patches[index] = `${diffHeaderForFile(file).join('\n')}\n`;
        }
      });
      continue;
    }
    log.warn?.(`[reviewer] WARN: PR files API omitted patch for ${repo}#${prNumber} ${filename} status=${file.status || 'unknown'}; adding metadata-only diff entry`);
    patches[index] = `${diffHeaderForFile(file).join('\n')}\n`;
  }
  await runWithConcurrency(rawFetchTasks, RAW_ADDED_FILE_FETCH_CONCURRENCY);
  return concatPatchParts(patches.filter(Boolean));
}

async function fetchPRDiff(repo, prNumber, headSha, {
  execFileImpl = execFileAsync,
  execGhWithRetryImpl = execGhWithRetry,
  getCachedDiffImpl = getCachedDiff,
  putCachedDiffImpl = putCachedDiff,
  recordApiCallImpl = recordApiCall,
  apiStatusFromErrorImpl = apiStatusFromError,
  ghRetrySleepImpl = sleep,
  awaitThrottleIfNeededImpl = awaitThrottleIfNeeded,
  log = console,
} = {}) {
  const cacheLookupStartedAt = Date.now();
  const cached = headSha ? getCachedDiffImpl(repo, prNumber, headSha) : null;
  if (cached) {
    recordApiCallImpl({
      category: 'cache_hit_diff_fetch',
      repo,
      prNumber,
      status: 'hit',
      durationMs: Date.now() - cacheLookupStartedAt,
    });
    return cached.bytes;
  }

  let stdout;
  try {
    ({ stdout } = await execGhWithRetryImpl({
      execFileImpl: async (command, args, options) => {
        const attemptStartedAt = Date.now();
        try {
          const result = await execFileImpl(
            command,
            args,
            { ...options, encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 }
          );
          recordApiCallImpl({
            category: 'diff_fetch',
            repo,
            prNumber,
            status: 200,
            durationMs: Date.now() - attemptStartedAt,
          });
          return result;
        } catch (err) {
          recordApiCallImpl({
            category: 'diff_fetch',
            repo,
            prNumber,
            status: apiStatusFromErrorImpl(err),
            durationMs: Date.now() - attemptStartedAt,
          });
          throw err;
        }
      },
      args: ['pr', 'diff', String(prNumber), '--repo', repo],
      timeoutMs: Math.max(GH_LOOKUP_TIMEOUT_MS, 60_000),
      sleep: ghRetrySleepImpl,
    }));
  } catch (err) {
    if (!headSha || !isPullRequestDiffTooLargeError(err)) throw err;
    log.warn?.(`[reviewer] WARN: gh pr diff too large for ${repo}#${prNumber}; falling back to PR files API`);
    stdout = await fetchPRDiffFromFilesApi(repo, prNumber, headSha, {
      execFileImpl,
      execGhWithRetryImpl,
      recordApiCallImpl,
      apiStatusFromErrorImpl,
      ghRetrySleepImpl,
      awaitThrottleIfNeededImpl,
      log,
    });
  }
  if (headSha) {
    try {
      putCachedDiffImpl(repo, prNumber, headSha, stdout);
    } catch (err) {
      log.warn?.(`[reviewer] WARN: failed to write diff cache for ${repo}#${prNumber}@${headSha}: ${err?.message || err}`);
    }
  }
  return stdout;
}

export {
  fetchPRDiff,
  fetchPRDiffFromFilesApi,
};
