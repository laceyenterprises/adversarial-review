import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Environment-only knobs deliberately avoid extending the shared YAML schema.
export const SNAPSHOT_CACHE_CONFIG = Object.freeze({
  maxCount: { env: 'ADVERSARIAL_REVIEWER_SNAPSHOT_MAX_COUNT', default: 8 },
  maxGb: { env: 'ADVERSARIAL_REVIEWER_SNAPSHOT_MAX_GB', default: 4 },
});
export function resolveSnapshotCacheLimits(env = process.env) {
  const value = (key) => {
    const knob = SNAPSHOT_CACHE_CONFIG[key];
    const parsed = Number(env[knob.env]);
    return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : knob.default;
  };
  return { maxCount: value('maxCount'), maxBytes: value('maxGb') * 1024 ** 3 };
}
function snapshotBytes(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, name) => total + snapshotBytes(join(path, name)), 0);
}
function pidInUse(pid) {
  try { process.kill(Number(pid), 0); return true; }
  catch (err) { return err.code !== 'ESRCH'; }
}
function snapshotInUse(repoCacheDir, sha) {
  const leaseDir = join(repoCacheDir, '.leases', sha);
  if (!existsSync(leaseDir)) return false;
  for (const pid of readdirSync(leaseDir)) {
    if (!/^[1-9][0-9]*$/.test(pid)) return true;
    try { process.kill(Number(pid), 0); return true; }
    catch (err) {
      if (err.code !== 'ESRCH') return true;
      unlinkSync(join(leaseDir, pid));
    }
  }
  return false;
}
const AUDIT_DIRNAME = 'reviewer-workspace-audit';
const GIT_AUDIT_MAX_BUFFER = 64 * 1024 * 1024;
const AUDIT_HASH_MAX_BYTES = 8 * 1024 * 1024;
// reviewer.mjs handles one PR per process. A multi-PR process must pass this
// context explicitly per spawn instead of sharing this mutable slot.
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

class ReviewerSnapshotBaseError extends Error {
  constructor(message, {
    linkPath = null,
    linkTarget = null,
    snapshotDir = null,
    repo = null,
    headSha = null,
  } = {}) {
    super(message);
    this.name = 'ReviewerSnapshotBaseError';
    this.failureClass = 'reviewer-snapshot-base-invalid';
    this.linkPath = linkPath;
    this.linkTarget = linkTarget;
    this.snapshotDir = snapshotDir;
    this.repo = repo;
    this.headSha = headSha;
  }
}

function isReviewerSnapshotBaseError(err) {
  return err instanceof ReviewerSnapshotBaseError
    || err?.name === 'ReviewerSnapshotBaseError'
    || err?.failureClass === 'reviewer-snapshot-base-invalid';
}

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

// The review ledger may live under the source checkout for compatibility, but
// immutable snapshots and subprocess audit records must live outside it.
function resolveReviewerWorkspaceStateDir({
  stateDir,
  checkoutDir,
  env = process.env,
  homeDir = homedir(),
} = {}) {
  if (!stateDir || !checkoutDir) throw new Error('reviewer workspace requires stateDir and checkoutDir');
  const configured = String(env.ADVERSARIAL_REVIEW_WORKSPACE_STATE_DIR || '').trim();
  const hqRoot = String(env.HQ_ROOT || '').trim();
  const selected = configured || (!isInside(stateDir, checkoutDir)
    ? stateDir
    : hqRoot
      ? join(hqRoot, 'adversarial-review', 'reviewer-workspace')
      : join(homeDir, '.agent-os', 'adversarial-review', 'reviewer-workspace'));
  if (isInside(selected, checkoutDir)) {
    throw new Error('reviewer workspace state must be outside the source checkout');
  }
  return resolve(selected);
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
    let gitStderr = '';
    let tarStderr = '';
    let gitClosed = false;
    let tarClosed = false;
    let gitStatus = null;
    let tarStatus = null;
    let settled = false;
    const closeStatus = (code, signal) => (signal ? `signal:${signal}` : code);
    const statusLabel = (closed, status) => (closed ? status : 'pending');
    const archiveFailureError = () => {
      const err = new Error(
        `git archive snapshot failed (git=${statusLabel(gitClosed, gitStatus)}, ` +
        `tar=${statusLabel(tarClosed, tarStatus)}): ${gitStderr}${tarStderr}`.trim()
      );
      err.stderr = `${gitStderr}${tarStderr}`;
      return err;
    };
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
    git.stdout.on('error', (err) => {
      if (err?.code === 'EPIPE') rejectOnce(archiveFailureError());
      else rejectOnce(err);
    });
    tar.stdin.on('error', (err) => {
      if (err?.code === 'EPIPE') rejectOnce(archiveFailureError());
      else rejectOnce(err);
    });
    git.stdout.pipe(tar.stdin);
    const finish = () => {
      if (settled || !gitClosed || !tarClosed) return;
      settled = true;
      if (gitStatus === 0 && tarStatus === 0) resolvePromise();
      else reject(archiveFailureError());
    };
    git.on('error', rejectOnce);
    tar.on('error', rejectOnce);
    git.on('close', (code, signal) => {
      gitClosed = true;
      gitStatus = closeStatus(code, signal);
      if (gitStatus !== 0) rejectOnce(archiveFailureError());
      else finish();
    });
    tar.on('close', (code, signal) => {
      tarClosed = true;
      tarStatus = closeStatus(code, signal);
      if (tarStatus !== 0) rejectOnce(archiveFailureError());
      else finish();
    });
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

function touchSnapshot(snapshotDir, nowMs) {
  const now = new Date(nowMs);
  utimesSync(snapshotDir, now, now);
  const markerPath = join(snapshotDir, '.reviewer-snapshot.json');
  if (existsSync(markerPath)) utimesSync(markerPath, now, now);
}

function validateSnapshotLinks(snapshotDir, currentDir = snapshotDir) {
  for (const entry of readdirSync(currentDir)) {
    const path = join(currentDir, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (!isInside(resolve(currentDir, target), snapshotDir)) {
        const linkPath = relative(snapshotDir, path) || entry;
        throw new ReviewerSnapshotBaseError(`snapshot contains link escaping its root: ${linkPath} -> ${target}`, {
          linkPath,
          linkTarget: target,
          snapshotDir,
        });
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
  maxCount = resolveSnapshotCacheLimits().maxCount,
  maxBytes = resolveSnapshotCacheLimits().maxBytes,
  statSyncImpl = statSync,
  log = console,
} = {}) {
  if (!existsSync(repoCacheDir)) return [];
  const removed = [];
  let entries;
  try {
    entries = readdirSync(repoCacheDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') log.warn(`[reviewer] snapshot cache listing failed: ${err.message}`);
    return removed;
  }
  const candidates = [];
  for (const entry of entries) {
    // Recover tombstones left by a collector crash, but never touch one
    // owned by a running collector. Build and lease metadata stay protected.
    const tombstone = /^\.gc-([1-9][0-9]*)-(.+)-[0-9a-f-]{36}$/.exec(entry.name);
    if (!entry.isDirectory()) continue;
    if (tombstone && pidInUse(tombstone[1])) continue;
    if (entry.name.startsWith('.') && !tombstone) continue;
    const entryPath = join(repoCacheDir, entry.name);
    try {
      const entryStat = statSyncImpl(entryPath);
      if (!entryStat.isDirectory()) continue;
      candidates.push({ name: tombstone ? tombstone[2] : entry.name, orphan: Boolean(tombstone), path: entryPath, mtimeMs: entryStat.mtimeMs, bytes: snapshotBytes(entryPath) });
    } catch (err) {
      if (err?.code !== 'ENOENT') log.warn(`[reviewer] snapshot cache cleanup failed path=${entryPath}: ${err.message}`);
    }
  }
  let count = candidates.length;
  let bytes = candidates.reduce((sum, entry) => sum + entry.bytes, 0);
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  for (const entry of candidates) {
    if (entry.name === currentSha) continue;
    if (!entry.orphan && nowMs - entry.mtimeMs <= maxAgeMs && count <= maxCount && bytes <= maxBytes) continue;
    const victim = join(repoCacheDir, `.gc-${process.pid}-${entry.name}-${randomUUID()}`);
    try {
      if (snapshotInUse(repoCacheDir, entry.name)) continue;
      // Rename before the final pin check: a new reader either pins the old
      // tree (which we restore) or observes the missing tree and rebuilds.
      renameSync(entry.path, victim);
      if (snapshotInUse(repoCacheDir, entry.name)) {
        renameSync(victim, entry.path);
        continue;
      }
      makeTreeWritable(victim);
      rmSync(victim, { recursive: true, force: true });
      count -= 1;
      bytes -= entry.bytes;
      removed.push(entry.path);
    } catch (err) {
      if (err?.code !== 'ENOENT') log.warn(`[reviewer] snapshot cache cleanup failed path=${entry.path}: ${err.message}`);
      // Keep failed deletions visible to the next sweep rather than leaking
      // hidden garbage. A concurrent replacement keeps its own path.
      if (existsSync(victim) && !existsSync(entry.path)) {
        try { renameSync(victim, entry.path); }
        catch (restoreErr) { log.warn(`[reviewer] snapshot cache restore failed: ${restoreErr.message}`); }
      }
    }
  }
  return removed;
}

function removeInvalidSnapshot(snapshotDir, headSha) {
  if (validateSnapshot(snapshotDir, headSha)) return false;
  makeTreeWritable(snapshotDir);
  rmSync(snapshotDir, { recursive: true, force: true });
  return true;
}

function promoteSnapshotBuild(buildDir, snapshotDir, headSha) {
  try {
    renameSync(buildDir, snapshotDir);
    return;
  } catch (err) {
    if (!existsSync(snapshotDir) && !['EEXIST', 'ENOTEMPTY'].includes(err?.code)) throw err;
    if (validateSnapshot(snapshotDir, headSha)) return;
    removeInvalidSnapshot(snapshotDir, headSha);
  }

  try {
    renameSync(buildDir, snapshotDir);
  } catch (err) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(err?.code) || !validateSnapshot(snapshotDir, headSha)) throw err;
  }
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
  pinSnapshot = false,
  ...cacheLimits
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
  // Pin before inspecting/building so concurrent collectors cannot remove a
  // snapshot between validation and subprocess startup. Dead PID pins expire.
  const leaseDir = join(repoCacheDir, '.leases', headSha);
  if (pinSnapshot) {
    mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(leaseDir, String(process.pid)), '', { mode: 0o600 });
  }
  const reused = validateSnapshot(snapshotDir, headSha);
  if (!reused) {
    const buildDir = mkdtempSync(join(repoCacheDir, '.build-'));
    try {
      await extractArchiveWithRetries(checkoutDir, buildDir, extractArchiveImpl);
      validateSnapshotLinks(buildDir);
      writeFileSync(join(buildDir, '.reviewer-snapshot.json'), `${JSON.stringify({ schemaVersion: 1, repo, headSha })}\n`, { mode: 0o444 });
      chmodSync(buildDir, 0o555);
      await execFileImpl('chmod', ['-R', 'a-w', buildDir]);
      promoteSnapshotBuild(buildDir, snapshotDir, headSha);
      if (existsSync(buildDir)) {
        makeTreeWritable(buildDir);
        rmSync(buildDir, { recursive: true, force: true });
      }
    } catch (err) {
      if (existsSync(buildDir)) {
        makeTreeWritable(buildDir);
        rmSync(buildDir, { recursive: true, force: true });
      }
      if (isReviewerSnapshotBaseError(err)) {
        err.repo = repo;
        err.headSha = headSha;
        throw err;
      }
      throw new Error(`reviewer snapshot unavailable for ${repo}@${headSha}: ${err.message}`, { cause: err });
    }
  }
  if (!validateSnapshot(snapshotDir, headSha)) throw new Error(`reviewer snapshot validation failed for ${repo}@${headSha}`);
  touchSnapshot(snapshotDir, nowMs);
  garbageCollectSnapshots(repoCacheDir, headSha, { nowMs, maxAgeMs, ...cacheLimits });
  return { checkoutDir: resolve(checkoutDir), headSha, snapshotDir, reused };
}

function configureReviewerWorkspaceAudit(context) {
  activeAuditContext = context ? { ...context, checkoutDir: resolve(context.checkoutDir), stateDir: resolve(context.stateDir) } : null;
}

async function checkoutIndex(checkoutDir) {
  const { stdout } = await execFileAsync('git', [
    '--no-optional-locks', 'ls-files', '-s', '-z',
  ], { cwd: checkoutDir, encoding: 'utf8', maxBuffer: GIT_AUDIT_MAX_BUFFER });
  return String(stdout || '').split('\0').filter(Boolean);
}

function statusPathsFromPorcelainZ(output) {
  const fields = String(output || '').split('\0').filter(Boolean);
  const paths = new Set();
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    paths.add(field.slice(3));
    if (/[RC]/.test(status)) {
      i += 1;
      if (i < fields.length) paths.add(fields[i]);
    }
  }
  return paths;
}

async function checkoutStatusZ(checkoutDir) {
  const { stdout } = await execFileAsync('git', [
    '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all',
  ], { cwd: checkoutDir, encoding: 'utf8', maxBuffer: GIT_AUDIT_MAX_BUFFER });
  return String(stdout || '');
}

function pathContentSignature(checkoutDir, path) {
  const absolutePath = join(checkoutDir, path);
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch (err) {
    if (err?.code === 'ENOENT') return 'missing';
    return `stat-error:${err.code || err.message}`;
  }
  if (stat.isSymbolicLink()) {
    try {
      return `symlink:${readlinkSync(absolutePath)}`;
    } catch (err) {
      return `symlink-error:${err.code || err.message}`;
    }
  }
  if (stat.isFile()) {
    if (stat.size > AUDIT_HASH_MAX_BYTES) {
      return `file-large:${stat.mode & 0o7777}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    }
    const hash = createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
    return `file:${stat.mode & 0o7777}:${stat.size}:${hash}`;
  }
  if (stat.isDirectory()) return `dir:${stat.mode & 0o7777}`;
  return `other:${stat.mode & 0o7777}:${stat.size}`;
}

async function checkoutState(checkoutDir) {
  const [indexEntries, statusBody] = await Promise.all([
    checkoutIndex(checkoutDir),
    checkoutStatusZ(checkoutDir),
  ]);
  const state = new Map();
  for (const entry of indexEntries) {
    const tabIndex = entry.indexOf('\t');
    if (tabIndex === -1) continue;
    state.set(entry.slice(tabIndex + 1), [`index:${entry.slice(0, tabIndex)}`]);
  }
  for (const path of statusPathsFromPorcelainZ(statusBody)) {
    const signatures = state.get(path) || [];
    signatures.push(`worktree:${pathContentSignature(checkoutDir, path)}`);
    state.set(path, signatures);
  }
  return state;
}

function changedCheckoutPaths(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => {
    const beforeSignature = (before.get(path) || []).join('\n');
    const afterSignature = (after.get(path) || []).join('\n');
    return beforeSignature !== afterSignature;
  }).sort();
}

function changedStatusPaths(before, after) {
  const beforeSet = new Set(before);
  const changed = after.filter((line) => !beforeSet.has(line));
  return [...new Set(changed.flatMap((line) => {
    const status = line.slice(0, 2);
    const body = line.slice(3);
    return /[RC]/.test(status) && body.includes(' -> ') ? body.split(' -> ') : [body];
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

function recordWorkspaceAuditProbeError({
  context,
  auditDir,
  auditDirReady,
  subprocessPid,
  result,
  startedAt,
  endedAt,
  phase,
  err,
}) {
  const event = {
    event: 'reviewer_workspace_escape_audit_error',
    ts: endedAt,
    repo: context.repo,
    prNumber: context.prNumber,
    reviewerModel: context.reviewerModel,
    headSha: context.headSha,
    subprocessPid,
    agyConversationId: context.agyConversationId || result?.conversationId || result?.conversation_id || null,
    window: { startedAt, endedAt },
    phase,
    error: err?.message || String(err || 'unknown audit probe failure'),
  };
  const line = JSON.stringify(event);
  console.error(line);
  if (auditDirReady) {
    try {
      appendFileSync(join(auditDir, 'reviewer-workspace-audit-errors.jsonl'), `${line}\n`, { mode: 0o600 });
    } catch (writeErr) {
      console.error(`[reviewer] workspace escape audit error durable record failed: ${writeErr.message}`);
    }
  }
}

async function auditReviewerSubprocess(spawnOperation) {
  if (!activeAuditContext) return spawnOperation({ onSpawn: null });
  const context = activeAuditContext;
  let before = null;
  let checkoutHeadBefore = null;
  let beforeProbeError = null;
  try {
    checkoutHeadBefore = await resolveCheckoutHead(context.checkoutDir);
    before = await checkoutState(context.checkoutDir);
  } catch (err) {
    beforeProbeError = err;
    console.error(`[reviewer] workspace escape pre-spawn state probe failed: ${err.message}`);
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
    let after = null;
    let checkoutHeadAfter = null;
    let afterProbeError = null;
    try {
      after = await checkoutState(context.checkoutDir);
      checkoutHeadAfter = await resolveCheckoutHead(context.checkoutDir);
    } catch (err) {
      afterProbeError = err;
      console.error(`[reviewer] workspace escape state probe failed: ${err.message}`);
    }
    const probeError = beforeProbeError || afterProbeError;
    if (probeError) {
      recordWorkspaceAuditProbeError({
        context,
        auditDir,
        auditDirReady,
        subprocessPid,
        result,
        startedAt,
        endedAt,
        phase: beforeProbeError ? 'pre' : 'post',
        err: probeError,
      });
    } else {
      const paths = changedCheckoutPaths(before, after);
      if (paths.length > 0) {
        const ambiguous = checkoutHeadBefore !== checkoutHeadAfter;
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
          checkoutHeadBefore,
          checkoutHeadAfter,
          ambiguous,
          attribution: ambiguous ? 'checkout-head-moved' : 'unattributed',
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
    }
    if (livePath) try { unlinkSync(livePath); } catch {}
  }
}

export {
  SNAPSHOT_MAX_AGE_MS,
  ReviewerSnapshotBaseError,
  auditReviewerSubprocess,
  changedStatusPaths,
  configureReviewerWorkspaceAudit,
  extractArchiveOnce,
  garbageCollectSnapshots,
  isReviewerSnapshotBaseError,
  prepareReviewerSnapshot,
  resolveCheckoutHead,
  resolveReviewerWorkspaceStateDir,
};
