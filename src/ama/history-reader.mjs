import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { immutableSnapshotValue, readClosureImmutable } from '../closure-evaluation-cache.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGhWithRetry, GH_LOOKUP_MAX_BUFFER } from '../gh-cli.mjs';
import { HISTORY_CONTEXT_TIMEOUT_MS, historyReadErrorDetail, historyReadRetryDelayMs } from './history-read-policy.mjs';
import { currentGitHubBudgetScope, withGitHubBudgetScope } from '../rate-limit-throttle.mjs';

const execFileAsync = promisify(execFile);
const commitFields = '{sha, commit: {message: .commit.message, author: .commit.author, committer: .commit.committer}, author, committer, parents: [.parents[] | {sha}]}';

// REST compare files are capped at 300 and cannot be paginated. Read only
// comparison metadata/commit pages, then walk immutable trees (skipping equal
// subtrees) and diff one changed blob pair at a time. Never buffer a compare's
// patches, and never treat a server cap as a complete protected file list.
export function createHistoryReader(options = {}) {
  const { execGhWithRetryImpl = execGhWithRetry, diffImpl = execFileAsync,
    contextTimeoutMs = loadAwareTimeoutMs(HISTORY_CONTEXT_TIMEOUT_MS), nowMs = () => performance.now(), ...ghOptions } = options;
  let deadline;
  const remainingMs = () => {
    ghOptions.signal?.throwIfAborted();
    deadline ??= nowMs() + contextTimeoutMs;
    const remaining = Math.floor(deadline - nowMs());
    if (remaining <= 0) throw new Error('history read context budget exhausted');
    return remaining;
  };
  const cache = new Map();
  const json = async (path, jq = '.') => {
    try {
      // Only object-addressed evidence is immutable. Keep PR metadata, refs,
      // reviews and cost/label provenance live even on the same PR head.
      const immutable = /\/(?:git\/(?:trees|blobs)|commits)\/[0-9a-f]{40}(?:\?|$)/i.test(path)
        || /\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}(?:\?|$)/i.test(path);
      const execute = async () => {
        const run = () => execGhWithRetryImpl({ ...ghOptions,
          // Include response headers so failed rate-limit reads retain the
          // server's Retry-After; strip headers before parsing successful JSON.
          args: ['api', path, '--jq', jq, '--include'], timeoutMs: loadAwareTimeoutMs(15000),
          retries: 2, retryDelayMs: historyReadRetryDelayMs, totalTimeoutMs: remainingMs(), nowMs });
        // CLI reads must defer an exhausted shared quota instead of entering an
        // unbounded throttle sleep. Daemon callers retain their existing scope.
        const { stdout } = await (currentGitHubBudgetScope() ? run() : withGitHubBudgetScope({}, run));
        return immutableSnapshotValue(JSON.parse(stdout.replace(/^HTTP\/[\s\S]*?\r?\n\r?\n/, '')));
      };
      const env = ghOptions.env || process.env;
      return await (immutable
        ? readClosureImmutable(execGhWithRetryImpl, [path, jq, env.GH_TOKEN, env.GITHUB_TOKEN,
          env.GH_HOST, env.GH_CONFIG_DIR], execute, ghOptions.execFileImpl || execFileAsync, ghOptions.signal)
        : execute());
    } catch (cause) {
      const limit = cause.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || cause.code === 'ENOBUFS'
        ? ` (output limit ${GH_LOOKUP_MAX_BUFFER} bytes exceeded)` : '';
      const error = new Error(historyReadErrorDetail(`history read failed: ${path}${limit}: ${historyReadErrorDetail(cause)}`), { cause });
      error.primaryChangeReadFailed = true;
      throw error;
    }
  };
  const cached = (path, jq) => {
    const key = `${path}:${jq}`;
    if (!cache.has(key)) {
      const pending = json(path, jq);
      cache.set(key, pending);
      pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
    }
    return cache.get(key);
  };
  const tree = async (repo, ref) => {
    const data = await cached(`repos/${repo}/git/trees/${ref}`, '{tree: [.tree[] | {path, mode, type, sha}], truncated}');
    if (data.truncated || !Array.isArray(data.tree)) throw new Error(`incomplete tree ${ref}`);
    return new Map(data.tree.map(entry => [entry.path, entry]));
  };
  const filesBetween = async (repo, base, head) => {
    const changed = [];
    const walk = async (beforeRef, afterRef, prefix = '') => {
      if (beforeRef && beforeRef === afterRef) return;
      const [before, after] = await Promise.all([
        beforeRef ? tree(repo, beforeRef) : new Map(),
        afterRef ? tree(repo, afterRef) : new Map(),
      ]);
      for (const name of new Set([...before.keys(), ...after.keys()])) {
        const a = before.get(name), b = after.get(name);
        if (a?.sha === b?.sha && a?.mode === b?.mode) continue;
        const path = `${prefix}${name}`;
        if (a?.type === 'tree' || b?.type === 'tree') {
          if (a && a.type !== 'tree') changed.push({ path, a });
          if (b && b.type !== 'tree') changed.push({ path, b });
          await walk(a?.type === 'tree' ? a.sha : null, b?.type === 'tree' ? b.sha : null, `${path}/`);
        } else changed.push({ path, a, b });
      }
    };
    await walk(base, head);
    const files = new Array(changed.length);
    const dir = await mkdtemp(join(tmpdir(), 'ham-history-'));
    const blob = async entry => {
      // Gitlinks have no file contents; type transitions diff the blob side
      // against empty bytes without attempting to fetch a submodule commit.
      if (!entry || entry.type === 'commit') return Buffer.alloc(0);
      if (entry.type !== 'blob') throw new Error(`unsupported changed object ${entry.type}`);
      const data = await cached(`repos/${repo}/git/blobs/${entry.sha}`, '{encoding, content, size}');
      if (data.encoding !== 'base64' || typeof data.content !== 'string') throw new Error(`unreadable blob ${entry.sha}`);
      const bytes = Buffer.from(data.content, 'base64');
      if (bytes.length !== data.size) throw new Error(`incomplete blob ${entry.sha}`);
      return bytes;
    };
    try {
      let cursor = 0;
      const worker = async () => {
        while (cursor < changed.length) {
          const index = cursor++;
          const { path, a, b } = changed[index];
          const beforePath = `before-${index}`, afterPath = `after-${index}`;
          const file = { filename: path, status: !a ? 'added' : !b ? 'removed' : 'modified', sha: b?.sha || a.sha };
          if (a?.type === 'commit' && b?.type === 'commit') {
            file.additions = 0; file.deletions = 0; files[index] = file; continue;
          }
          await Promise.all([
            blob(a).then(bytes => writeFile(join(dir, beforePath), bytes)),
            blob(b).then(bytes => writeFile(join(dir, afterPath), bytes)),
          ]);
          let patch;
          try {
            ({ stdout: patch } = await diffImpl('git', ['-c', 'core.autocrlf=false', '-c', 'core.attributesFile=/dev/null', 'diff', '--diff-algorithm=myers', '--no-indent-heuristic', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', '--', beforePath, afterPath],
              { cwd: dir, encoding: 'utf8', timeout: Math.min(loadAwareTimeoutMs(15000), remainingMs()), maxBuffer: GH_LOOKUP_MAX_BUFFER, ...(ghOptions.signal ? { signal: ghOptions.signal } : {}) }));
          } catch (error) {
            if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error.code === 'ENOBUFS') {
              throw new Error(`history diff output limit ${GH_LOOKUP_MAX_BUFFER} bytes exceeded for ${path}`, { cause: error });
            }
            if (error.code !== 1 || typeof error.stdout !== 'string') throw error;
            patch = error.stdout;
          }
          if (patch.includes('\n@@')) file.patch = patch.slice(patch.indexOf('@@'));
          file.additions = (file.patch || '').split('\n').filter(line => line.startsWith('+')).length;
          file.deletions = (file.patch || '').split('\n').filter(line => line.startsWith('-')).length;
          files[index] = file;
        }
      };
      // Bound GitHub and child concurrency without serializing every blob.
      // Settle all workers before deleting their temporary files on failure.
      const settled = await Promise.allSettled(Array.from({ length: Math.min(8, changed.length) }, () => worker().catch(error => { cursor = changed.length; throw error; })));
      const failed = settled.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      // Preserve pure-rename identity; edited renames remain conservative
      // add/delete evidence, never an authorization to discard old hunks.
      for (const removed of [...files].filter(file => file.status === 'removed')) {
        const added = files.find(file => file.status === 'added' && file.sha === removed.sha);
        if (added) {
          added.status = 'renamed';
          added.previous_filename = removed.filename;
          delete added.patch;
          added.additions = 0;
          added.deletions = 0;
          files.splice(files.indexOf(removed), 1);
        }
      }
      return files;
    } finally { await rm(dir, { recursive: true, force: true }); }
  };
  const reader = async path => {
    try {
      const compare = /^repos\/(.+\/[^/]+)\/compare\/([^?]+)$/.exec(path);
      if (compare) {
        const [, repo, range] = compare;
        const head = range.split('...')[1];
        const commits = [];
        let result;
        const fields = `{status, total_commits, merge_base_commit: {sha: .merge_base_commit.sha}, commits: [.commits[] | ${commitFields}]}`;
        result = await json(`${path}?per_page=100&page=1`, fields);
        if (!Number.isSafeInteger(result.total_commits) || result.total_commits < 0) throw new Error('missing compare commit count');
        const batches = [result];
        const pageCount = Math.max(1, Math.ceil(result.total_commits / 100));
        let nextPage = 2;
        const workers = await Promise.allSettled(Array.from({ length: Math.min(4, pageCount - 1) }, async () => {
          while (nextPage <= pageCount) {
            const page = nextPage++;
            batches[page - 1] = await json(`${path}?per_page=100&page=${page}`, fields);
          }
        }));
        const failed = workers.find(entry => entry.status === 'rejected');
        if (failed) throw failed.reason;
        for (const batch of batches) {
          if (batch.total_commits !== result.total_commits || !Array.isArray(batch.commits)
            || batch.status !== result.status || batch.merge_base_commit?.sha !== result.merge_base_commit?.sha) throw new Error('inconsistent compare pagination');
          commits.push(...batch.commits);
        }
        if (commits.length !== result.total_commits) throw new Error('incomplete compare pagination');
        if (new Set(commits.map(commit => commit.sha)).size !== commits.length) throw new Error('duplicate compare commit page');
        if (!/^[0-9a-f]{40}$/i.test(result.merge_base_commit?.sha || '')) throw new Error('missing compare merge base');
        return { ...result, commits, filesComplete: true, files: await filesBetween(repo, result.merge_base_commit.sha, head) };
      }
      if (/\/commits\/[0-9a-f]{40}$/i.test(path)) {
        let result;
        const files = [];
        for (let page = 1; ; page++) {
          const batch = await json(`${path}?per_page=100&page=${page}`,
            `${commitFields.slice(0, -1)}, files: [.files[] | {filename, previous_filename, status, sha, patch, additions, deletions}]}`);
          result ??= batch;
          if (!Array.isArray(batch.files)) throw new Error('missing commit files');
          files.push(...batch.files);
          if (batch.files.length < 100) break;
          // The commit API caps files at 3000. Use the same uncapped tree path.
          if (files.length >= 3000) return { ...result, filesComplete: true, files: await filesBetween(path.split('/commits/')[0].slice(6), result.parents[0]?.sha, result.sha) };
        }
        return { ...result, filesComplete: true, files };
      }
      if (/\/pulls\/\d+\/files\?/.test(path)) return json(path, '[.[] | {filename, previous_filename, status, sha}]');
      return json(path);
    } catch (error) {
      error.primaryChangeReadFailed = true;
      throw error;
    }
  };
  // Cost/ancestry consumers need metadata, not reconstructed per-file patches.
  reader.metadata = path => json(path, '{status, total_commits, merge_base_commit: {sha: .merge_base_commit.sha}}');
  // Provenance proofs request compact web-flow verification separately; avoid
  // buffering signature payloads in every history and commit-file page.
  reader.commitVerification = path => json(path, '{sha, verification: .commit.verification}');
  reader.persistPrimaryChange = true;
  return reader;
}
