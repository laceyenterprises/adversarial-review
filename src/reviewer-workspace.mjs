import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
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
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { withTransientGitRetries } from './reviewer-git-retries.mjs';
import { materializeReviewerHead, reviewerGitEnv } from './reviewer-repo-checkout.mjs';
import { createEmptyReviewerCwd, pidInUse, withReviewerCwdProcess } from './reviewer-harness-cwd.mjs';
import { recordReviewerWorkspaceMode } from './reviewer-workspace-telemetry.mjs';

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
function snapshotInUse(repoCacheDir, sha) {
  const leaseDir = join(repoCacheDir, '.leases', sha);
  if (!existsSync(leaseDir)) return false;
  for (const pid of readdirSync(leaseDir)) {
    const group = /^group-([1-9][0-9]*)$/.exec(pid);
    if (!group && !/^[1-9][0-9]*$/.test(pid)) return true;
    if (pidInUse(group ? -Number(group[1]) : pid)) return true;
    rmSync(join(leaseDir, pid), { force: true });
  }
  return false;
}
const AUDIT_DIRNAME = 'reviewer-workspace-audit';
const GIT_AUDIT_TIMEOUT_MS = 15_000;
const GIT_AUDIT_MAX_BUFFER = 64 * 1024 * 1024;
const AUDIT_HASH_MAX_BYTES = 8 * 1024 * 1024;
const PROJECT_HARNESS_INPUTS = [
  'AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md', '.mcp.json',
  '.claude', '.codex', '.gemini',
];
// reviewer.mjs handles one PR per process. A multi-PR process must pass this
// context explicitly per spawn instead of sharing this mutable slot.
let activeAuditContext = null;

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

function canonicalPath(path) {
  try { return realpathSync.native(path); }
  catch (err) {
    if (err.code !== 'ENOENT' || lstatSync(path, { throwIfNoEntry: false })) throw err;
    return join(canonicalPath(dirname(path)), basename(path));
  }
}

function hasGitAncestor(path) {
  for (let current = path; ; current = dirname(current)) {
    if (lstatSync(join(current, '.git'), { throwIfNoEntry: false })) return true;
    if (dirname(current) === current) return false;
  }
}

// The review ledger may live under the source checkout for compatibility, but
// immutable snapshots and subprocess audit records must live outside it.
function resolveReviewerWorkspaceStateDir({
  stateDir,
  checkoutDir,
  serviceCheckoutDir,
  env = process.env,
  homeDir = homedir(),
} = {}) {
  if (!stateDir) throw new Error('reviewer workspace requires stateDir');
  const sourceCheckouts = checkoutDir ? [checkoutDir] : [];
  if (serviceCheckoutDir) {
    sourceCheckouts.push(serviceCheckoutDir);
    const superprojectDir = resolve(serviceCheckoutDir, '..', '..');
    if (existsSync(join(superprojectDir, '.git'))) sourceCheckouts.push(superprojectDir);
  }
  const sourcePaths = sourceCheckouts.map(source => canonicalPath(resolve(source)));
  const insideSourceCheckout = (path) => hasGitAncestor(path) || sourcePaths.some(source => isInside(path, source));
  const configured = String(env.ADVERSARIAL_REVIEW_WORKSPACE_STATE_DIR || '').trim();
  const hqRoot = String(env.HQ_ROOT || '').trim();
  const standardState = canonicalPath(resolve(stateDir));
  const selected = canonicalPath(resolve(configured || (!insideSourceCheckout(standardState)
    ? standardState
    : hqRoot
      ? join(hqRoot, 'adversarial-review', 'reviewer-workspace')
      : join(homeDir, '.agent-os', 'adversarial-review', 'reviewer-workspace'))));
  if (insideSourceCheckout(selected)) {
    throw new Error('reviewer workspace state must be outside the source checkout');
  }
  return selected;
}

function ownedWorkspaceChild(parent, name, mode = 0o700) {
  const path = join(parent, name);
  mkdirSync(path, { recursive: true, mode });
  if (realpathSync.native(path) !== path || hasGitAncestor(path)) {
    throw new Error('reviewer workspace directory must be owned and outside git worktrees');
  }
  const stat = lstatSync(path);
  if (stat.uid !== process.getuid() || (stat.mode & 0o022)) {
    throw new Error('reviewer workspace directory must be owned and private to writes');
  }
  return path;
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

function extractArchive(checkoutDir, destination, headSha) {
  return withTransientGitRetries(() => extractArchiveOnce(checkoutDir, destination, headSha), 'git archive snapshot');
}

function extractArchiveOnce(checkoutDir, destination, headSha) {
  return new Promise((resolvePromise, reject) => {
    const git = spawn('git', ['--no-optional-locks', '--no-replace-objects', 'archive', '--format=tar', headSha], {
      cwd: checkoutDir,
      env: reviewerGitEnv(),
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

function extractArchiveWithRetries(checkoutDir, destination, headSha, extractArchiveImpl) {
  if (extractArchiveImpl === extractArchive) return extractArchive(checkoutDir, destination, headSha);
  return withTransientGitRetries(() => extractArchiveImpl(checkoutDir, destination, headSha), 'git archive snapshot');
}

function readSnapshotMarker(snapshotDir, expectedSha) {
  const markerPath = join(snapshotDir, '.reviewer-snapshot.json');
  try {
    if (!lstatSync(snapshotDir).isDirectory()) return null;
    const stat = lstatSync(markerPath);
    if (!stat.isFile() || stat.size > 4096 || stat.uid !== process.getuid() || (stat.mode & 0o222)) return null;
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (marker.headSha !== expectedSha || marker.schemaVersion !== 2) return null;
    return { marker, markerBytes: stat.size };
  } catch {
    return null;
  }
}

function validateSnapshot(snapshotDir, expectedSha) {
  return readSnapshotMarker(snapshotDir, expectedSha) !== null;
}

function cachedSnapshotBytes(path, headSha) {
  const metadata = readSnapshotMarker(path, headSha);
  const treeBytes = metadata?.marker.treeBytes;
  if (Number.isSafeInteger(treeBytes) && treeBytes >= 0 && treeBytes <= Number.MAX_SAFE_INTEGER - metadata.markerBytes) {
    return treeBytes + metadata.markerBytes;
  }
  return snapshotBytes(path);
}

function touchSnapshot(snapshotDir, nowMs) {
  const now = new Date(nowMs);
  utimesSync(snapshotDir, now, now);
  const markerPath = join(snapshotDir, '.reviewer-snapshot.json');
  if (existsSync(markerPath)) utimesSync(markerPath, now, now);
}

function validateSnapshotLinks(snapshotDir, currentDir = snapshotDir) {
  let bytes = 0;
  for (const entry of readdirSync(currentDir)) {
    const path = join(currentDir, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      let escapes = !isInside(resolve(currentDir, target), snapshotDir);
      if (!escapes) {
        try { escapes = !isInside(realpathSync.native(path), realpathSync.native(snapshotDir)); }
        catch (err) { if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(err.code)) throw err; }
      }
      if (escapes) {
        const linkPath = relative(snapshotDir, path) || entry;
        throw new ReviewerSnapshotBaseError(`snapshot contains link escaping its root: ${linkPath} -> ${target}`, {
          linkPath,
          linkTarget: target,
          snapshotDir,
        });
      }
    }
    bytes += stat.isDirectory() ? validateSnapshotLinks(snapshotDir, path) : stat.size;
  }
  return bytes;
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
      const name = tombstone ? tombstone[2] : entry.name;
      candidates.push({ name, orphan: Boolean(tombstone), path: entryPath, mtimeMs: entryStat.mtimeMs, bytes: cachedSnapshotBytes(entryPath, name) });
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
  const headSha = expectedHeadSha?.toLowerCase() ?? await resolveCheckoutHead(checkoutDir, execFileImpl);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headSha)) throw new Error('reviewer snapshot requires a full commit SHA');
  const cacheRoot = join(canonicalPath(resolve(stateDir)), 'reviewer-snapshots');
  if (isInside(cacheRoot, checkoutDir)) throw new Error('reviewer snapshot cache must be outside the source checkout');
  const repoCacheDir = ownedWorkspaceChild(ownedWorkspaceChild(dirname(cacheRoot), basename(cacheRoot)), safeRepoName(repo));
  const snapshotDir = join(repoCacheDir, headSha);
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
      try {
        await extractArchiveWithRetries(checkoutDir, buildDir, headSha, extractArchiveImpl);
      } catch (cause) {
        throw Object.assign(new Error(`reviewer snapshot unavailable for ${repo}@${headSha}: ${cause.message}`, { cause }), { archiveUnavailable: true });
      }
      const markerPath = join(buildDir, '.reviewer-snapshot.json');
      // Replace a reserved archive entry without following a PR-authored link.
      const treeBytesWithReservedEntry = validateSnapshotLinks(buildDir);
      const reservedEntry = lstatSync(markerPath, { throwIfNoEntry: false });
      if (reservedEntry?.isDirectory()) {
        throw Object.assign(new Error('reviewer snapshot marker path is a directory'), { archiveUnavailable: true });
      }
      if (reservedEntry) unlinkSync(markerPath);
      const treeBytes = treeBytesWithReservedEntry - (reservedEntry?.size ?? 0);
      writeFileSync(markerPath, `${JSON.stringify({ schemaVersion: 2, repo, headSha, treeBytes })}\n`, { flag: 'wx', mode: 0o444 });
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
      if (err.archiveUnavailable) throw err;
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

export async function prepareReviewerWorkspace({
  repo, checkoutDir, serviceCheckoutDir, stateDir, headSha, execFileImpl, extractArchiveImpl,
  checkoutUnavailable = 'no-checkout', env = process.env, homeDir = homedir(), pinSnapshot = true, log = console,
}) {
  const workspaceStateDir = resolveReviewerWorkspaceStateDir({ stateDir, checkoutDir, serviceCheckoutDir, env, homeDir });
  let snapshot;
  let cause = checkoutDir ? 'head-fetch-failed' : checkoutUnavailable;
  if (await materializeReviewerHead(checkoutDir, headSha, execFileImpl, env, log)) {
    try {
      snapshot = await prepareReviewerSnapshot({ repo, checkoutDir, stateDir: workspaceStateDir, expectedHeadSha: headSha,
        pinSnapshot, extractArchiveImpl, ...resolveSnapshotCacheLimits(env) });
      cause = null;
    } catch (err) {
      if (!err.archiveUnavailable && !isReviewerSnapshotBaseError(err)) throw err;
      cause = isReviewerSnapshotBaseError(err) ? 'escaping-link' : 'archive-unavailable';
    }
  }
  const pinGroup = snapshot && pinSnapshot
    ? pgid => writeFileSync(join(dirname(snapshot.snapshotDir), '.leases', snapshot.headSha, `group-${pgid}`), '', { mode: 0o600 })
    : undefined;
  const { cwd: subprocessCwd } = prepareReviewerHarnessCwd(workspaceStateDir, { log, pinGroup });
  let telemetry;
  try {
    const auditDir = ownedWorkspaceChild(workspaceStateDir, AUDIT_DIRNAME);
    ownedWorkspaceChild(auditDir, 'modes');
    telemetry = recordReviewerWorkspaceMode({ auditDir, repoKey: safeRepoName(repo.toLowerCase()), cause });
  } catch (err) {
    log.warn(`[reviewer] workspace mode telemetry unavailable: ${err.code || 'unknown'}`);
  }
  if (cause) {
    const event = telemetry?.degraded ? 'reviewer_workspace_degraded' : 'reviewer_workspace_diff_only';
    const message = `[reviewer] ${event} repo=${repo} cause=${cause} count=${telemetry?.diffOnlyCount ?? 'unknown'}`;
    if (telemetry?.degraded || telemetry?.diffOnlyCount === 1 || !log.info) log.warn(message);
    else log.info(message);
  }
  return {
    ...snapshot, checkoutDir: snapshot?.checkoutDir ?? null, headSha: snapshot?.headSha ?? headSha,
    snapshotDir: snapshot?.snapshotDir ?? subprocessCwd, subprocessCwd, stateDir: workspaceStateDir,
    diffOnly: cause !== null, diffOnlyCause: cause, alertDegradation: telemetry?.alert ?? false,
  };
}

export function prepareReviewerHarnessCwd(workspaceStateDir, options) {
  const sharedTraversal = options?.sharedTraversal;
  const parent = canonicalPath(resolve(workspaceStateDir));
  const name = sharedTraversal ? `agy-reviewer-harness-${process.getuid()}` : 'reviewer-harness-cwds';
  const root = ownedWorkspaceChild(parent, name, sharedTraversal ? 0o711 : 0o700);
  if (sharedTraversal) chmodSync(root, 0o711);
  const ownerHome = canonicalPath(resolve(homedir()));
  for (let directory = root; ; directory = dirname(directory)) {
    for (const name of PROJECT_HARNESS_INPUTS) {
      // These home-level directories are the harnesses' trusted user settings.
      if (directory === ownerHome && ['.claude', '.codex', '.gemini'].includes(name)) continue;
      if (lstatSync(join(directory, name), { throwIfNoEntry: false })) {
        throw new Error('reviewer harness cwd must be outside project settings and instructions');
      }
    }
    if (dirname(directory) === directory) break;
  }
  return createEmptyReviewerCwd(root, options);
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

async function explainedCheckoutPaths(checkoutDir, beforeHead, afterHead, afterState) {
  const diffPaths = async (revisions, ignoreSubmodules) => {
    const { stdout } = await withTransientGitRetries(() => execFileAsync('git', [
      '--no-optional-locks', 'diff', '--no-ext-diff', '--no-renames', `--ignore-submodules=${ignoreSubmodules}`, '--name-only', '-z', ...revisions, '--',
    ], {
      cwd: checkoutDir, encoding: 'utf8', maxBuffer: GIT_AUDIT_MAX_BUFFER, timeout: loadAwareTimeoutMs(GIT_AUDIT_TIMEOUT_MS),
    }), 'git diff');
    return new Set(String(stdout || '').split('\0').filter(Boolean));
  };
  const [commitPaths, dirtyPaths] = await Promise.all([
    // Keep committed gitlink changes visible so checkout advances explain them.
    diffPaths([beforeHead, afterHead], 'none'),
    // Compare against the captured new HEAD, including staged changes. A clean
    // index alone cannot establish that the working tree matches the deploy.
    // Match checkoutStatusZ: submodule worktrees are outside the dirt probe.
    diffPaths([afterHead], 'all'),
  ]);
  return new Set([...commitPaths].filter((path) => !dirtyPaths.has(path)
    // Includes untracked recreations of paths deleted by the deploy, which git
    // diff against HEAD cannot see, and dirt observed by the post-spawn probe.
    && !(afterState.get(path) || []).some((signature) => signature.startsWith('worktree:'))));
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

async function auditReviewerSubprocess(spawnOperation, cwd) {
  return withReviewerCwdProcess(cwd, onCwdSpawn => auditCheckoutSubprocess(({ onSpawn }) =>
    spawnOperation({ onSpawn: onCwdSpawn || onSpawn ? child => {
      onCwdSpawn?.(child);
      onSpawn?.(child);
    } : null })));
}

async function auditCheckoutSubprocess(spawnOperation) {
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
      let paths = changedCheckoutPaths(before, after);
      let ambiguous = false;
      if (checkoutHeadBefore !== checkoutHeadAfter) {
        try {
          const explained = await explainedCheckoutPaths(context.checkoutDir, checkoutHeadBefore, checkoutHeadAfter, after);
          const unexplained = paths.filter((path) => !explained.has(path));
          if (unexplained.length === 0) {
            console.error(JSON.stringify({
              event: 'reviewer_workspace_head_moved',
              ts: endedAt,
              repo: context.repo,
              prNumber: context.prNumber,
              reviewerModel: context.reviewerModel,
              headSha: context.headSha,
              subprocessPid,
              window: { startedAt, endedAt },
              checkoutHeadBefore,
              checkoutHeadAfter,
              explainedPathCount: paths.length,
            }));
          }
          paths = unexplained;
        } catch (err) {
          // Missing/pruned objects, timeouts or unreadable evidence must retain
          // the original changed set and the conservative ambiguous attribution.
          ambiguous = true;
          console.error(`[reviewer] workspace escape HEAD diff failed: ${err.message}`);
        }
      }
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
