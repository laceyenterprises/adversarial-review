import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const AUDIT_DIRNAME = 'reviewer-workspace-audit';
let activeAuditContext = null;
const GIT_TRANSIENT_MAX_ATTEMPTS = 3;
const GIT_TRANSIENT_BASE_DELAY_MS = 100;
const TRANSIENT_GIT_ERROR_CODES = new Set([
  'EAGAIN',
  'EBUSY',
  'ECONNABORTED',
  'ECONNRESET',
  'EIO',
  'EMFILE',
  'ENFILE',
  'ETIMEDOUT',
]);
const TRANSIENT_GIT_ERROR_PATTERNS = [
  /\bEIO\b/i,
  /Input\/output error/i,
  /Operation timed out/i,
  /Resource temporarily unavailable/i,
  /Connection reset/i,
  /early EOF/i,
  /RPC failed/i,
  /remote end hung up unexpectedly/i,
  /fatal: unable to access/i,
  /(?:could not|unable to) (?:create|lock).*\.lock/i,
  /index\.lock/i,
];

function safeRepoName(repo) {
  const value = String(repo || 'unknown');
  const label = value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `${label}-${digest}`;
}

function isInside(candidate, parent) {
  const resolvedCandidate = resolve(candidate);
  const resolvedParent = resolve(parent);
  const relativePath = relative(resolvedParent, resolvedCandidate);
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function gitErrorText(err) {
  return [
    err?.code,
    err?.message,
    err?.stderr,
    err?.stdout,
  ].filter(Boolean).map(String).join('\n');
}

function isTransientGitError(err) {
  if (TRANSIENT_GIT_ERROR_CODES.has(String(err?.code || ''))) return true;
  const text = gitErrorText(err);
  return TRANSIENT_GIT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

async function sleep(ms) {
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}

async function withTransientGitRetries(operation, label) {
  let lastErr = null;
  for (let attempt = 1; attempt <= GIT_TRANSIENT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (attempt >= GIT_TRANSIENT_MAX_ATTEMPTS || !isTransientGitError(err)) throw err;
      await sleep(GIT_TRANSIENT_BASE_DELAY_MS * attempt);
    }
  }
  throw new Error(`${label} failed after ${GIT_TRANSIENT_MAX_ATTEMPTS} attempts`, { cause: lastErr });
}

async function resolveCheckoutHead(checkoutDir, execFileImpl = execFileAsync) {
  const { stdout } = await withTransientGitRetries(
    () => execFileImpl('git', ['--no-optional-locks', 'rev-parse', '--verify', 'HEAD'], {
      cwd: checkoutDir,
      encoding: 'utf8',
    }),
    'git rev-parse HEAD',
  );
  const sha = String(stdout || '').trim();
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new Error(`invalid HEAD returned for ${checkoutDir}`);
  return sha;
}

function extractArchive(checkoutDir, destination) {
  return withTransientGitRetries(() => extractArchiveOnce(checkoutDir, destination), 'git archive snapshot');
}

function extractArchiveOnce(checkoutDir, destination) {
  return new Promise((resolvePromise, reject) => {
    const git = spawn('git', ['--no-optional-locks', 'archive', '--format=tar', 'HEAD'], {
      cwd: checkoutDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tar = spawn('tar', ['-x', '-C', destination], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    git.stdout.pipe(tar.stdin);
    let gitStderr = '';
    let tarStderr = '';
    let gitCode = null;
    let tarCode = null;
    let settled = false;
    const rejectOnce = (err) => {
      if (settled) return;
      settled = true;
      try { git.kill('SIGTERM'); } catch {}
      try { tar.kill('SIGTERM'); } catch {}
      try { tar.stdin.destroy(); } catch {}
      reject(err);
    };
    git.stderr.on('data', (chunk) => { gitStderr += chunk; });
    tar.stderr.on('data', (chunk) => { tarStderr += chunk; });
    const finish = () => {
      if (settled || gitCode === null || tarCode === null) return;
      settled = true;
      if (gitCode === 0 && tarCode === 0) resolvePromise();
      else {
        const err = new Error(`git archive snapshot failed (git=${gitCode}, tar=${tarCode}): ${gitStderr}${tarStderr}`.trim());
        err.stderr = `${gitStderr}${tarStderr}`;
        reject(err);
      }
    };
    git.on('error', rejectOnce);
    tar.on('error', rejectOnce);
    git.on('close', (code) => { gitCode = code; finish(); });
    tar.on('close', (code) => { tarCode = code; finish(); });
  });
}

function extractArchiveWithRetries(checkoutDir, destination, extractArchiveImpl) {
  if (extractArchiveImpl === extractArchive) return extractArchive(checkoutDir, destination);
  return withTransientGitRetries(() => extractArchiveImpl(checkoutDir, destination), 'git archive snapshot');
}

function validateSnapshot(snapshotDir, expectedSha) {
  const markerPath = join(snapshotDir, '.reviewer-snapshot.json');
  if (!existsSync(snapshotDir) || !statSync(snapshotDir).isDirectory() || !existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    return marker.headSha === expectedSha && marker.schemaVersion === 1;
  } catch {
    return false;
  }
}

function validateSnapshotLinks(snapshotDir, currentDir = snapshotDir) {
  for (const entry of readdirSync(currentDir)) {
    const path = join(currentDir, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (!isInside(resolve(currentDir, target), snapshotDir)) {
        throw new Error(`snapshot contains link escaping its root: ${path} -> ${target}`);
      }
    } else if (stat.isDirectory()) {
      validateSnapshotLinks(snapshotDir, path);
    }
  }
}

function makeTreeWritable(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) makeTreeWritable(join(path, entry));
  } else {
    chmodSync(path, 0o600);
  }
}

function garbageCollectSnapshots(repoCacheDir, currentSha, {
  nowMs = Date.now(),
  maxAgeMs = SNAPSHOT_MAX_AGE_MS,
} = {}) {
  if (!existsSync(repoCacheDir)) return [];
  const removed = [];
  for (const entry of readdirSync(repoCacheDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === currentSha) continue;
    const entryPath = join(repoCacheDir, entry.name);
    if (nowMs - statSync(entryPath).mtimeMs <= maxAgeMs) continue;
    makeTreeWritable(entryPath);
    rmSync(entryPath, { recursive: true, force: true });
    removed.push(entryPath);
  }
  return removed;
}

async function prepareReviewerSnapshot({
  repo,
  checkoutDir,
  stateDir,
  expectedHeadSha = null,
  execFileImpl = execFileAsync,
  extractArchiveImpl = extractArchive,
  nowMs = Date.now(),
  maxAgeMs = SNAPSHOT_MAX_AGE_MS,
} = {}) {
  if (!checkoutDir || !stateDir) throw new Error('reviewer snapshot requires checkoutDir and stateDir');
  const headSha = await resolveCheckoutHead(checkoutDir, execFileImpl);
  if (expectedHeadSha && headSha !== expectedHeadSha) {
    throw new Error(`reviewer snapshot HEAD mismatch: checkout=${headSha} requested=${expectedHeadSha}`);
  }
  const cacheRoot = join(resolve(stateDir), 'reviewer-snapshots');
  if (isInside(cacheRoot, checkoutDir)) throw new Error('reviewer snapshot cache must be outside the source checkout');
  const repoCacheDir = join(cacheRoot, safeRepoName(repo));
  const snapshotDir = join(repoCacheDir, headSha);
  mkdirSync(repoCacheDir, { recursive: true, mode: 0o700 });
  const reused = validateSnapshot(snapshotDir, headSha);
  if (!reused) {
    const buildDir = mkdtempSync(join(repoCacheDir, '.build-'));
    try {
      await extractArchiveWithRetries(checkoutDir, buildDir, extractArchiveImpl);
      validateSnapshotLinks(buildDir);
      writeFileSync(join(buildDir, '.reviewer-snapshot.json'), `${JSON.stringify({ schemaVersion: 1, repo, headSha })}\n`, { mode: 0o444 });
      chmodSync(buildDir, 0o555);
      await execFileImpl('chmod', ['-R', 'a-w', buildDir]);
      try {
        renameSync(buildDir, snapshotDir);
      } catch (err) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(err?.code) || !validateSnapshot(snapshotDir, headSha)) throw err;
        makeTreeWritable(buildDir);
        rmSync(buildDir, { recursive: true, force: true });
      }
    } catch (err) {
      if (existsSync(buildDir)) {
        makeTreeWritable(buildDir);
        rmSync(buildDir, { recursive: true, force: true });
      }
      throw new Error(`reviewer snapshot unavailable for ${repo}@${headSha}: ${err.message}`, { cause: err });
    }
  }
  if (!validateSnapshot(snapshotDir, headSha)) throw new Error(`reviewer snapshot validation failed for ${repo}@${headSha}`);
  garbageCollectSnapshots(repoCacheDir, headSha, { nowMs, maxAgeMs });
  return { checkoutDir: resolve(checkoutDir), headSha, snapshotDir, reused };
}

function configureReviewerWorkspaceAudit(context) {
  activeAuditContext = context ? { ...context, checkoutDir: resolve(context.checkoutDir), stateDir: resolve(context.stateDir) } : null;
}

async function checkoutStatus(checkoutDir) {
  const { stdout } = await execFileAsync('git', [
    '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all',
  ], { cwd: checkoutDir, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return String(stdout || '').split('\n').filter(Boolean);
}

function changedStatusPaths(before, after) {
  const beforeSet = new Set(before);
  const changed = after.filter((line) => !beforeSet.has(line));
  return [...new Set(changed.flatMap((line) => {
    const body = line.slice(3);
    return body.includes(' -> ') ? body.split(' -> ') : [body];
  }))].sort();
}

function liveReviewerPids(auditDir, currentPid) {
  const pids = [];
  for (const name of existsSync(auditDir) ? readdirSync(auditDir) : []) {
    const match = name.match(/^live-(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === currentPid) continue;
    try {
      process.kill(pid, 0);
      pids.push(pid);
    } catch (err) {
      if (err?.code === 'EPERM') {
        pids.push(pid);
      } else {
        try { unlinkSync(join(auditDir, name)); } catch {}
      }
    }
  }
  return pids.sort((a, b) => a - b);
}

async function auditReviewerSubprocess(spawnOperation) {
  if (!activeAuditContext) return spawnOperation({ onSpawn: null });
  const context = activeAuditContext;
  let before = [];
  try { before = await checkoutStatus(context.checkoutDir); } catch (err) {
    console.error(`[reviewer] workspace escape pre-spawn status probe failed: ${err.message}`);
  }
  const startedAt = new Date().toISOString();
  const auditDir = join(context.stateDir, AUDIT_DIRNAME);
  let auditDirReady = false;
  try {
    mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    auditDirReady = true;
  } catch (err) {
    console.error(`[reviewer] workspace escape audit directory unavailable: ${err.message}`);
  }
  let subprocessPid = null;
  let livePath = null;
  let result;
  try {
    result = await spawnOperation({
      onSpawn(child) {
        subprocessPid = child?.pid || null;
        if (subprocessPid && auditDirReady) {
          livePath = join(auditDir, `live-${subprocessPid}`);
          try {
            writeFileSync(livePath, `${JSON.stringify({ ...context, startedAt, subprocessPid })}\n`, { mode: 0o600 });
          } catch (err) {
            livePath = null;
            console.error(`[reviewer] workspace escape live-pid record failed: ${err.message}`);
          }
        }
      },
    });
    return result;
  } finally {
    const endedAt = new Date().toISOString();
    let after = [];
    try { after = await checkoutStatus(context.checkoutDir); } catch (err) {
      console.error(`[reviewer] workspace escape status probe failed: ${err.message}`);
    }
    const paths = changedStatusPaths(before, after);
    if (paths.length > 0) {
      const event = {
        event: 'reviewer_workspace_escape',
        ts: endedAt,
        repo: context.repo,
        prNumber: context.prNumber,
        reviewerModel: context.reviewerModel,
        headSha: context.headSha,
        subprocessPid,
        agyConversationId: context.agyConversationId || result?.conversationId || result?.conversation_id || null,
        window: { startedAt, endedAt },
        otherLiveReviewerPids: auditDirReady ? liveReviewerPids(auditDir, subprocessPid) : [],
        paths,
      };
      const line = JSON.stringify(event);
      console.error(line);
      if (auditDirReady) {
        try {
          appendFileSync(join(auditDir, 'reviewer-workspace-escapes.jsonl'), `${line}\n`, { mode: 0o600 });
        } catch (err) {
          console.error(`[reviewer] workspace escape durable record failed: ${err.message}`);
        }
      }
    }
    if (livePath) try { unlinkSync(livePath); } catch {}
  }
}

export {
  SNAPSHOT_MAX_AGE_MS,
  auditReviewerSubprocess,
  changedStatusPaths,
  configureReviewerWorkspaceAudit,
  garbageCollectSnapshots,
  prepareReviewerSnapshot,
  resolveCheckoutHead,
};
