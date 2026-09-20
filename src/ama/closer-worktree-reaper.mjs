import { execFile } from 'node:child_process';
import { existsSync, rmSync, statSync, promises as fsPromises } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { writeFileAtomic } from '../atomic-write.mjs';
import { execGhWithRetry } from '../gh-cli.mjs';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_HQ_PATH = '/Users/airlock/.local/bin/hq';  // cfg-allowlist(account-airlock): oss-readiness-apply-reviewed
const DEFAULT_HQ_ROOT = '/Users/airlock/agent-os-hq';  // cfg-allowlist(account-airlock): oss-readiness-apply-reviewed
const DEFAULT_REAP_LIMIT = 8;
const DEFAULT_REAP_BUDGET_MS = 20_000;
const DEFAULT_SCAN_LIMIT = 64;
const DEFAULT_UNKNOWN_PROBE_LIMIT = 3;
const DEFAULT_PROCESS_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_PROBE_FAILURE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_PROBE_FAILURE_MAX_ENTRIES = 512;
const DEFAULT_CURSOR_PATH = join(ROOT, 'data', 'ama-closer-worktree-reaper-cursor.json');
const HAMMER_WORKER_RE = /^hammer-ama-pr-(\d+)(?:-.+)?$/;

// Dispatch statuses that mean the hammer worker is still executing — most
// importantly its long post-merge "close sequence" (validate/rebase/merge-signal
// steps that run for many minutes AFTER the PR has already merged). Kept in sync
// with `AMA_CLOSER_ACTIVE_STATUSES` in dispatch-closer.mjs. Reaping a worktree
// while its hammer is in any of these states deletes the live worker's cwd out
// from under it — the 2026-08-06 `worker_killed` cascade this gate fixes: every
// killed hammer had merged its PR, then died within seconds of a
// `closer_worktree_reap.reaped reason:"merged"` event while still running its
// close sequence (pr-792 even logged `Working directory ... was deleted`).
const HAMMER_ACTIVE_DISPATCH_STATUSES = new Set(['running', 'starting', 'blocked', 'stalled']);

// Error codes that mean the probe/manifest read momentarily FAILED (busy host,
// fd exhaustion, fork pressure, killed-by-timeout) rather than a definitive
// answer. On any of these — and, fail-safe, on any error we cannot positively
// classify as definitive — the reaper DEFERS instead of reaping, so a transient
// blip under load never deletes a live hammer's cwd. Unknown dispatch probes are
// bounded by `AMA_CLOSER_WORKTREE_UNKNOWN_PROBE_LIMIT`: once the counter is hit,
// the reaper may reap only when a same-UID process cwd probe can positively
// observe that no process is using the worker directory. Cross-UID, timed-out,
// or diagnostic process probes remain unknown and defer.
const TRANSIENT_PROBE_ERROR_CODES = new Set([
  'ETIMEDOUT', 'EAGAIN', 'EIO', 'EMFILE', 'ENFILE', 'EBUSY', 'ENOMEM',
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETXTBSY', 'EINTR',
]);

function isTransientProbeError(err) {
  if (!err) return false;
  // execFile's `timeout` kills the child (killed=true / signal SIGTERM|SIGKILL):
  // the hq process was busy past the deadline, not a terminal read.
  if (err.killed === true) return true;
  if (err.signal === 'SIGTERM' || err.signal === 'SIGKILL') return true;
  return TRANSIENT_PROBE_ERROR_CODES.has(String(err.code || ''));
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseHammerPrNumber(workerName) {
  const match = HAMMER_WORKER_RE.exec(String(workerName || ''));
  return match ? Number.parseInt(match[1], 10) : null;
}

function parseGitWorktreePorcelain(stdout) {
  const records = [];
  let current = null;
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (current) records.push(current);
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { path: line.slice('worktree '.length), prunable: false };
      continue;
    }
    if (!current) continue;
    if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true;
      current.prunableReason = line.slice('prunable'.length).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim();
    }
  }
  if (current) records.push(current);
  return records;
}

function parseGitHubRepoFromRemote(remoteUrl) {
  const value = String(remoteUrl || '').trim();
  const match = value.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:[#?].*)?$/i);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

function pageAfterCursor(entries, lastName, limit, nameOf = (entry) => entry.name) {
  const sorted = [...entries].sort((left, right) => nameOf(left).localeCompare(nameOf(right)));
  const afterCursor = lastName
    ? sorted.filter((entry) => nameOf(entry).localeCompare(lastName) > 0)
    : sorted;
  const wrapped = Boolean(lastName) && afterCursor.length === 0;
  const page = (wrapped ? sorted : afterCursor).slice(0, limit);
  return {
    page,
    nextCursor: page.length > 0 ? nameOf(page.at(-1)) : lastName || null,
    wrapped,
  };
}

async function readScanCursor(cursorPath, logger = console) {
  try {
    const parsed = JSON.parse(await fsPromises.readFile(cursorPath, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      return {
        repo: typeof parsed.repo === 'string' ? parsed.repo : null,
        worker: typeof parsed.worker === 'string' ? parsed.worker : null,
        evaluation: typeof parsed.evaluation === 'string' ? parsed.evaluation : null,
        probeFailures: parsed.probeFailures && typeof parsed.probeFailures === 'object'
          ? parsed.probeFailures
          : {},
      };
    }
  } catch (err) {
    if (err?.code !== 'ENOENT' && !(err instanceof SyntaxError)) {
      logger?.warn?.(`[closer-worktree-reap] cursor-read-failed: ${err?.message || err}`);
    }
  }
  return { repo: null, worker: null, evaluation: null, probeFailures: {} };
}

function persistScanCursor(cursorPath, cursor, logger = console) {
  try {
    writeFileAtomic(cursorPath, `${JSON.stringify({
      schemaVersion: 2,
      ...cursor,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch (err) {
    logger?.warn?.(`[closer-worktree-reap] cursor-write-failed: ${err?.message || err}`);
    return false;
  }
}

function recoverableDiscoveryError(err) {
  return ['ENOENT', 'EACCES', 'ENOTDIR'].includes(String(err?.code || ''));
}

function pruneProbeFailures(probeFailures, {
  currentWorkerIds = null,
  maxAgeMs = DEFAULT_PROBE_FAILURE_TTL_MS,
  maxEntries = DEFAULT_PROBE_FAILURE_MAX_ENTRIES,
  nowMs = Date.now(),
} = {}) {
  if (!probeFailures || typeof probeFailures !== 'object') return {};
  for (const [workerId, failure] of Object.entries(probeFailures)) {
    const lastFailureMs = Date.parse(failure?.lastFailureAt || '');
    const stale = !Number.isFinite(lastFailureMs) || nowMs - lastFailureMs > maxAgeMs;
    if (currentWorkerIds instanceof Set && !currentWorkerIds.has(workerId)) {
      delete probeFailures[workerId];
    } else if (stale) {
      delete probeFailures[workerId];
    }
  }
  const entries = Object.entries(probeFailures);
  if (entries.length <= maxEntries) return probeFailures;
  entries
    .sort((left, right) => Date.parse(left[1]?.lastFailureAt || '') - Date.parse(right[1]?.lastFailureAt || ''))
    .slice(0, entries.length - maxEntries)
    .forEach(([workerId]) => {
      delete probeFailures[workerId];
    });
  return probeFailures;
}

async function listCurrentHammerWorkerIds(hqRoot, {
  registeredByWorker = new Map(),
  readdirImpl = fsPromises.readdir,
  logger = console,
} = {}) {
  const workersDir = join(hqRoot, 'workers');
  try {
    const entries = await readdirImpl(workersDir, { withFileTypes: true });
    const workerIds = new Set(
      entries
        .filter((entry) => entry.isDirectory() && HAMMER_WORKER_RE.test(entry.name))
        .map((entry) => entry.name),
    );
    for (const workerId of registeredByWorker.keys()) workerIds.add(workerId);
    return workerIds;
  } catch (err) {
    if (recoverableDiscoveryError(err)) {
      if (err?.code !== 'ENOENT') {
        logger?.warn?.(`[closer-worktree-reap] probe-failure-gc-discovery-skipped path=${workersDir} code=${err.code}`);
      }
      return null;
    }
    throw err;
  }
}

async function listHqRepoPaths(hqRoot, {
  scanLimit,
  lastName,
  readdirImpl = fsPromises.readdir,
  logger = console,
} = {}) {
  const entries = [];
  for (const rootName of ['repos', 'worker-base']) {
    const reposDir = join(hqRoot, rootName);
    const rootEntries = await readdirImpl(reposDir, { withFileTypes: true }).catch((err) => {
      if (recoverableDiscoveryError(err)) {
        if (err?.code !== 'ENOENT') {
          logger?.warn?.(`[closer-worktree-reap] repo-discovery-skipped path=${reposDir} code=${err.code}`);
        }
        return [];
      }
      throw err;
    });
    entries.push(...rootEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: `${rootName}/${entry.name}`,
        path: join(reposDir, entry.name),
      })));
  }
  const discovery = pageAfterCursor(
    entries,
    lastName,
    scanLimit,
  );
  return {
    paths: discovery.page.map((entry) => entry.path),
    nextCursor: discovery.nextCursor,
  };
}

function manifestWorktreePath(workerDir, manifest) {
  const rawPath = manifest?.workspacePath || manifest?.worktreePath;
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const candidate = rawPath.startsWith('/')
    ? resolve(rawPath)
    : resolve(workerDir, rawPath);
  return pathTextEquals(dirname(candidate), workerDir) ? candidate : null;
}

async function resolveHammerWorktreePath(workerDir, {
  readdirImpl = fsPromises.readdir,
  readFileImpl = fsPromises.readFile,
  logger = console,
} = {}) {
  const manifestPath = join(workerDir, 'workspace.json');
  try {
    const manifest = JSON.parse(await readFileImpl(manifestPath, 'utf8'));
    const worktreePath = manifestWorktreePath(workerDir, manifest);
    if (worktreePath) return worktreePath;

    const declaredPath = manifest?.workspacePath || manifest?.worktreePath;
    if (typeof declaredPath === 'string' && declaredPath.trim()) {
      // A present-but-invalid path is a security boundary violation. Do not
      // replace it with a guessed child directory.
      logger?.warn?.(`[closer-worktree-reap] manifest-workspace-invalid path=${manifestPath}`);
      return null;
    }
    // V1 manifests did not always persist either path field. Fall through to
    // the single-child legacy discovery below instead of leaking those
    // half-registered worker directories forever.
    logger?.warn?.(`[closer-worktree-reap] manifest-workspace-legacy-fallback path=${manifestPath}`);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      logger?.warn?.(`[closer-worktree-reap] manifest-read-failed path=${manifestPath}: ${err?.message || err}`);
      return null;
    }
  }

  const children = await readdirImpl(workerDir, { withFileTypes: true }).catch((err) => {
    if (!recoverableDiscoveryError(err)) throw err;
    return [];
  });
  const candidates = children
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => resolve(workerDir, entry.name));
  return candidates.length === 1 ? candidates[0] : null;
}

async function listHammerWorkerDirs(hqRoot, {
  scanLimit,
  lastName,
  readdirImpl = fsPromises.readdir,
  readFileImpl = fsPromises.readFile,
  logger = console,
} = {}) {
  const workersDir = join(hqRoot, 'workers');
  const entries = await readdirImpl(workersDir, { withFileTypes: true }).catch((err) => {
    if (recoverableDiscoveryError(err)) {
      if (err?.code !== 'ENOENT') {
        logger?.warn?.(`[closer-worktree-reap] worker-discovery-skipped path=${workersDir} code=${err.code}`);
      }
      return [];
    }
    throw err;
  });
  const discovery = pageAfterCursor(
    entries.filter((entry) => entry.isDirectory() && HAMMER_WORKER_RE.test(entry.name)),
    lastName,
    scanLimit,
  );
  const resolvedEntries = [];
  for (const entry of discovery.page) {
    const workerDir = join(workersDir, entry.name);
    const worktreePath = await resolveHammerWorktreePath(workerDir, {
      readdirImpl,
      readFileImpl,
      logger,
    });
    resolvedEntries.push({
      workerId: entry.name,
      workerDir,
      worktreePath,
      prNumber: parseHammerPrNumber(entry.name),
      diskPresent: Boolean(worktreePath) && existsSync(worktreePath),
      unresolvable: !worktreePath,
    });
  }
  return {
    entries: resolvedEntries,
    nextCursor: discovery.nextCursor,
  };
}

async function execGit({ repoPath, args, execFileImpl = execFileAsync, timeout = 30_000 }) {
  return execFileImpl('git', ['-C', repoPath, ...args], {
    env: process.env,
    maxBuffer: 5 * 1024 * 1024,
    timeout,
    killSignal: 'SIGTERM',
  });
}

async function remoteRepoForPath(repoPath, execFileImpl) {
  try {
    const { stdout } = await execGit({
      repoPath,
      args: ['remote', 'get-url', 'origin'],
      execFileImpl,
      timeout: 10_000,
    });
    return parseGitHubRepoFromRemote(stdout);
  } catch {
    return null;
  }
}

async function registeredWorktreesByPath({ repoPaths, execFileImpl, logger = console }) {
  const byPath = new Map();
  for (const repoPath of repoPaths) {
    try {
      const [{ stdout }, githubRepo] = await Promise.all([
        execGit({ repoPath, args: ['worktree', 'list', '--porcelain'], execFileImpl }),
        remoteRepoForPath(repoPath, execFileImpl),
      ]);
      for (const record of parseGitWorktreePorcelain(stdout)) {
        const workerId = basename(dirname(record.path));
        const prNumber = parseHammerPrNumber(workerId);
        if (prNumber === null) continue;
        byPath.set(resolve(record.path), {
          ...record,
          path: resolve(record.path),
          workerId,
          workerDir: dirname(record.path),
          prNumber,
          repoPath,
          githubRepo,
          registered: true,
        });
      }
    } catch (err) {
      logger?.warn?.(
        `[closer-worktree-reap] worktree-list-failed repoPath=${repoPath}: ${err?.message || err}`
      );
    }
  }
  return byPath;
}

function classifyPrTerminal(pr) {
  const state = String(pr?.state || '').toUpperCase();
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return pr?.mergedAt ? 'merged' : 'closed';
  return null;
}

async function fetchPrState({ repo, prNumber, execGhWithRetryImpl = execGhWithRetry, env = process.env }) {
  const { stdout } = await execGhWithRetryImpl({
    args: ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'state,mergedAt,closedAt'],
    env,
    retries: 1,
    timeoutMs: 20_000,
  });
  return JSON.parse(stdout || '{}');
}

function gitWorktreeRemoveIndicatesGone(detail) {
  return /(?:is not a working tree|does not exist)\s*$/i.test(String(detail || '').trim());
}

function pathTextEquals(leftPath, rightPath) {
  const left = resolve(leftPath);
  const right = resolve(rightPath);
  return process.platform === 'darwin' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function pathTextStartsWith(childPath, parentPath) {
  const child = resolve(childPath);
  const parent = `${resolve(parentPath)}/`;
  return process.platform === 'darwin'
    ? child.toLowerCase().startsWith(parent.toLowerCase())
    : child.startsWith(parent);
}

function physicalRemovalTargetForEntry({ hqRoot, entry }) {
  if (!HAMMER_WORKER_RE.test(String(entry?.workerId || ''))) return { refusalReason: 'invalid-worker-id' };

  const expectedWorkerDir = join(hqRoot, 'workers', entry.workerId);
  if (!entry.workerDir || !pathTextEquals(entry.workerDir, expectedWorkerDir)) {
    return { refusalReason: 'outside-worker-dir', target: expectedWorkerDir };
  }
  return { refusalReason: null, target: expectedWorkerDir };
}

async function removeHammerWorktree({
  entry,
  hqRoot,
  hqPath,
  execFileImpl,
  rmSyncImpl = rmSync,
  logger = console,
}) {
  const errors = [];
  let pruned = false;
  const registeredWorktrees = Array.isArray(entry.registeredWorktrees)
    ? entry.registeredWorktrees
    : (entry.registered && entry.repoPath ? [entry] : []);
  // When the worktree directory is already physically gone, `git worktree
  // remove` can only fail validation ("'.git' does not exist" / "is not a
  // working tree") on every tick, leaving stale registry metadata behind that
  // spams remove-incomplete and historically pinned branch-holder leases.
  // Reconcile those with `git worktree prune` instead of erroring forever. A
  // directory that is still present (e.g. "Directory not empty") is untouched
  // and stays on the real teardown path below.
  for (const registration of registeredWorktrees) {
    let treeAlreadyGone = registration.diskPresent === false || !existsSync(registration.path);
    let removePhysicalInvalidTree = false;
    if (registration.repoPath && !treeAlreadyGone) {
      try {
        await execGit({
          repoPath: registration.repoPath,
          args: ['worktree', 'remove', '--force', registration.path],
          execFileImpl,
          timeout: 60_000,
        });
      } catch (err) {
        const detail = String(err?.stderr || err?.message || err);
        if (gitWorktreeRemoveIndicatesGone(detail)) {
          // The tree is already physically gone; prune the stale entry below.
          treeAlreadyGone = true;
          removePhysicalInvalidTree = registration.diskPresent !== false;
        } else {
          errors.push(`git-worktree-remove:${detail}`);
        }
      }
    }

    if (treeAlreadyGone) {
      let physicalRemovalSucceeded = true;
      if (removePhysicalInvalidTree) {
        // Each registration carries its own repo/worktree path. Validate its
        // worker ownership explicitly, while deliberately deleting the shared
        // hammer sandbox once: sibling worktrees are direct children of that
        // same validated worker directory.
        const registrationEntry = { ...entry, ...registration };
        const { refusalReason, target } = physicalRemovalTargetForEntry({
          hqRoot,
          entry: registrationEntry,
        });
        if (refusalReason) {
          physicalRemovalSucceeded = false;
          errors.push(`worktree-rm-refused:${refusalReason}:${registration.path || target}`);
        } else {
          try {
            rmSyncImpl(target, { recursive: true, force: true });
          } catch (err) {
            physicalRemovalSucceeded = false;
            errors.push(`worktree-rm:${String(err?.message || err)}`);
          }
        }
      }
      if (physicalRemovalSucceeded && registration.repoPath) {
        try {
          await execGit({
            repoPath: registration.repoPath,
            args: ['worktree', 'prune'],
            execFileImpl,
            timeout: 60_000,
          });
          pruned = true;
        } catch (err) {
          errors.push(`git-worktree-prune:${String(err?.stderr || err?.message || err)}`);
        }
      }
    }
  }

  try {
    await execFileImpl(hqPath, ['worker', 'tear-down', entry.workerId, '--force', '--root', hqRoot], {
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
      killSignal: 'SIGTERM',
    });
  } catch (err) {
    const detail = String(err?.stderr || err?.message || err);
    if (!/worker not found|worker does not exist|no worker with id|no such worker|service not found|could not find service|not loaded|no such process/i.test(detail)) {
      errors.push(`hq-worker-tear-down:${detail}`);
    }
  }

  const mayRemoveDiskFallback = !entry.registered
    || (entry.registrationMismatch && errors.length === 0);
  if (mayRemoveDiskFallback && entry.workerDir && existsSync(entry.workerDir)) {
    try {
      const stat = statSync(entry.workerDir);
      if (stat.isDirectory() && HAMMER_WORKER_RE.test(basename(entry.workerDir))) {
        rmSyncImpl(entry.workerDir, { recursive: true, force: true });
      }
    } catch (err) {
      errors.push(`disk-remove:${String(err?.message || err)}`);
    }
  }

  if (errors.length) {
    logger?.warn?.(
      `[closer-worktree-reap] remove-incomplete workerId=${entry.workerId} errors=${JSON.stringify(errors)}`
    );
  }
  return { ok: errors.length === 0, errors, pruned };
}

function isPidAliveLocal(pid, processKillImpl = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    processKillImpl(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    if (err?.code === 'EPERM') return true;
    return null;
  }
}

async function resolveEntryLaunchRequestId(entry, { readFileImpl = fsPromises.readFile } = {}) {
  const workerDir = entry?.workerDir;
  if (!workerDir) return { launchRequestId: null, defer: false, reason: 'no-worker-dir' };
  let body;
  try {
    body = await readFileImpl(join(workerDir, 'workspace.json'), 'utf8');
  } catch (err) {
    if (String(err?.code || '') === 'ENOENT') {
      // Genuinely untracked (no manifest) → safe to fall through to the ordinary
      // reap path (the half-registered / legacy leak-prevention case).
      return { launchRequestId: null, defer: false, reason: 'manifest-absent' };
    }
    // Transient I/O reading the manifest (EIO / EMFILE / EAGAIN / EACCES under
    // load, ...). Do NOT null-and-reap: a momentary read failure must not delete
    // a live hammer's tree. DEFER; the next tick re-reads.
    return { launchRequestId: null, defer: true, reason: `manifest-read-error:${err?.code || 'unknown'}` };
  }
  let manifest;
  try {
    manifest = JSON.parse(body);
  } catch {
    // Definitively malformed JSON — a stable property of the file, not a
    // transient condition → treat as untracked (safe reap).
    return { launchRequestId: null, defer: false, reason: 'manifest-malformed' };
  }
  const raw = manifest?.launchRequestId || manifest?.dispatchId;
  const launchRequestId = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  return {
    launchRequestId,
    defer: false,
    reason: launchRequestId ? 'resolved' : 'no-launch-request-id',
  };
}

async function probeHammerWorkerActivity({
  hqPath,
  launchRequestId,
  execFileImpl = execFileAsync,
  env = process.env,
  processKillImpl = process.kill,
  maxAttempts = 2,
} = {}) {
  if (!hqPath || !launchRequestId) {
    return { state: 'inactive', active: false, defer: false, status: null, reason: 'no-launch-request-id' };
  }
  let lastReason = 'probe-unreadable';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let stdout;
    try {
      ({ stdout } = await execFileImpl(
        hqPath,
        ['dispatch', 'status', launchRequestId, '--json'],
        { env: { ...env }, maxBuffer: 1024 * 1024, timeout: 5_000 },
      ));
    } catch (err) {
      // Could not run/complete the probe (timeout kill, EAGAIN fork failure, EIO,
      // EMFILE, spawn error, non-zero hq under a busy/locked ledger, ...). This is
      // NOT a definitive terminal read, so we must never reap on it. Retry once on
      // a recognized-transient failure, then DEFER (fail-safe for everything else).
      lastReason = `probe-error:${err?.code || err?.signal || 'unknown'}`;
      if (attempt < maxAttempts && isTransientProbeError(err)) continue;
      return { state: 'unknown', active: false, defer: true, status: null, reason: lastReason };
    }
    let parsed;
    try {
      parsed = JSON.parse(String(stdout || ''));
    } catch {
      // Non-JSON / empty body: a busy or locked hq emitting a partial or
      // human-readable error, NOT a definitive terminal state. Retry once, DEFER.
      lastReason = 'probe-nonjson';
      if (attempt < maxAttempts) continue;
      return { state: 'unknown', active: false, defer: true, status: null, reason: lastReason };
    }
    const status = typeof parsed?.status === 'string' ? parsed.status.trim().toLowerCase() : null;
    if (status && HAMMER_ACTIVE_DISPATCH_STATUSES.has(status)) {
      // Active dispatch row. Confirm the process is really alive before deferring
      // so a phantom (active row, dead pid) cannot pin the worktree forever — the
      // closer reconcile will flip it to failed, but we reap here rather than wait.
      const pid = Number(parsed?.pid);
      if (Number.isInteger(pid) && pid > 0 && isPidAliveLocal(pid, processKillImpl) === false) {
        return { state: 'inactive', active: false, defer: false, status, reason: 'phantom' };
      }
      return {
        state: 'active',
        active: true,
        defer: false,
        status,
        reason: 'active',
        pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      };
    }
    // Positively read a terminal/absent status from a successful JSON parse — the
    // ONLY path that permits a reap.
    return { state: 'inactive', active: false, defer: false, status, reason: status ? 'terminal' : 'status-absent' };
  }
  return { state: 'unknown', active: false, defer: true, status: null, reason: lastReason };
}

async function probeWorkerDirectoryUse({
  workerDir,
  execFileImpl = execFileAsync,
  env = process.env,
  pid = null,
  timeoutMs = normalizePositiveInteger(
    env.AMA_CLOSER_WORKTREE_PROCESS_PROBE_TIMEOUT_MS,
    DEFAULT_PROCESS_PROBE_TIMEOUT_MS,
  ),
  statSyncImpl = statSync,
  getuidImpl = () => (typeof process.getuid === 'function' ? process.getuid() : null),
} = {}) {
  if (!workerDir) return { state: 'unknown', reason: 'no-worker-dir' };
  let stat;
  try {
    stat = statSyncImpl(workerDir);
  } catch (err) {
    return { state: 'unknown', reason: `worker-dir-stat-error:${err?.code || 'unknown'}` };
  }
  const callerUid = getuidImpl();
  if (!Number.isInteger(callerUid)) {
    return { state: 'unknown', reason: 'caller-uid-unobservable' };
  }
  if (Number.isInteger(stat?.uid) && stat.uid !== callerUid) {
    return { state: 'unknown', reason: 'cross-uid-unobservable', ownerUid: stat.uid, callerUid };
  }
  const scopedPid = parseOptionalPositiveInteger(pid);
  const args = ['-a', '-d', 'cwd', '-Fn'];
  if (scopedPid !== null) args.push('-p', String(scopedPid));
  try {
    const { stdout } = await execFileImpl(
      'lsof',
      args,
      { env: { ...env }, maxBuffer: 1024 * 1024, timeout: timeoutMs },
    );
    const workerPath = resolve(workerDir);
    const matches = String(stdout || '').split(/\r?\n/).filter((line) => {
      if (!line.startsWith('n')) return false;
      const cwd = resolve(line.slice(1));
      return pathTextEquals(cwd, workerPath) || pathTextStartsWith(cwd, workerPath);
    });
    return matches.length > 0
      ? { state: 'active', reason: 'cwd-in-worker-dir', matches: matches.length }
      : { state: 'inactive', reason: 'no-cwd-in-worker-dir', matches: 0 };
  } catch (err) {
    // lsof also exits 1 for diagnostics such as permission failures. Trust it
    // as a negative only when the same-UID scan completed without diagnostics.
    if (Number(err?.code) === 1 && !err?.killed && !err?.signal && !String(err?.stderr || '').trim()) {
      return { state: 'inactive', reason: 'no-cwd-in-worker-dir', matches: 0 };
    }
    return {
      state: 'unknown',
      reason: `process-probe-error:${err?.code || err?.signal || 'unknown'}`,
    };
  }
}

async function reapCloserHammerWorktrees({
  hqRoot = process.env.HQ_ROOT || process.env.AGENT_OS_HQ_ROOT || DEFAULT_HQ_ROOT,
  hqPath = process.env.HQ_PATH || DEFAULT_HQ_PATH,
  limit = normalizePositiveInteger(process.env.AMA_CLOSER_WORKTREE_REAP_LIMIT, DEFAULT_REAP_LIMIT),
  budgetMs = normalizePositiveInteger(process.env.AMA_CLOSER_WORKTREE_REAP_BUDGET_MS, DEFAULT_REAP_BUDGET_MS),
  scanLimit = normalizePositiveInteger(process.env.AMA_CLOSER_WORKTREE_SCAN_LIMIT, DEFAULT_SCAN_LIMIT),
  cursorPath = process.env.AMA_CLOSER_WORKTREE_CURSOR_PATH || DEFAULT_CURSOR_PATH,
  repoPaths = null,
  readdirImpl = fsPromises.readdir,
  execFileImpl = execFileAsync,
  execGhWithRetryImpl = execGhWithRetry,
  rmSyncImpl = rmSync,
  readFileImpl = fsPromises.readFile,
  probeWorkerActivityImpl = probeHammerWorkerActivity,
  probeWorkerDirectoryUseImpl = probeWorkerDirectoryUse,
  unknownProbeLimit = normalizePositiveInteger(
    process.env.AMA_CLOSER_WORKTREE_UNKNOWN_PROBE_LIMIT,
    DEFAULT_UNKNOWN_PROBE_LIMIT,
  ),
  processProbeTimeoutMs = normalizePositiveInteger(
    process.env.AMA_CLOSER_WORKTREE_PROCESS_PROBE_TIMEOUT_MS,
    DEFAULT_PROCESS_PROBE_TIMEOUT_MS,
  ),
  probeFailureTtlMs = normalizePositiveInteger(
    process.env.AMA_CLOSER_WORKTREE_PROBE_FAILURE_TTL_MS,
    DEFAULT_PROBE_FAILURE_TTL_MS,
  ),
  probeFailureMaxEntries = normalizePositiveInteger(
    process.env.AMA_CLOSER_WORKTREE_PROBE_FAILURE_MAX_ENTRIES,
    DEFAULT_PROBE_FAILURE_MAX_ENTRIES,
  ),
  env = process.env,
  logger = console,
} = {}) {
  const cursor = await readScanCursor(cursorPath, logger);
  const repoDiscovery = Array.isArray(repoPaths)
    ? { paths: repoPaths, nextCursor: cursor.repo }
    : await listHqRepoPaths(hqRoot, {
        scanLimit,
        lastName: cursor.repo,
        readdirImpl,
        logger,
      });
  const effectiveRepoPaths = repoDiscovery.paths;
  const registered = await registeredWorktreesByPath({
    repoPaths: effectiveRepoPaths,
    execFileImpl,
    logger,
  });
  const workerDiscovery = await listHammerWorkerDirs(hqRoot, {
    scanLimit,
    lastName: cursor.worker,
    readdirImpl,
    logger,
  });
  const diskEntries = workerDiscovery.entries;
  const entries = [];
  const seenWorkers = new Set();
  const registeredByWorker = new Map();
  for (const registeredEntry of registered.values()) {
    const workerRegistrations = registeredByWorker.get(registeredEntry.workerId) || [];
    workerRegistrations.push({
      ...registeredEntry,
      diskPresent: existsSync(registeredEntry.path),
    });
    registeredByWorker.set(registeredEntry.workerId, workerRegistrations);
  }

  for (const diskEntry of diskEntries) {
    const pathKey = diskEntry.worktreePath ? resolve(diskEntry.worktreePath) : null;
    const registeredEntry = pathKey ? registered.get(pathKey) : null;
    const workerRegistrations = registeredByWorker.get(diskEntry.workerId) || [];
    // One non-exact registration is enough to establish the owning PR while
    // retaining both the registered path and manifest path for terminal
    // cleanup. Multiple non-exact registrations are ambiguous and remain
    // fail-closed until a later tick can establish an exact primary path.
    const legacyPrimaryRegistration = !pathKey
      ? workerRegistrations.find((registration) => basename(registration.path) === 'agent-os')
        || workerRegistrations[0]
      : null;
    const relatedRegistration = !registeredEntry
      ? (workerRegistrations.length === 1 ? workerRegistrations[0] : legacyPrimaryRegistration)
      : null;
    const stateRegistration = registeredEntry || relatedRegistration;
    entries.push({
      ...diskEntry,
      ...(stateRegistration || {}),
      path: stateRegistration?.path || pathKey || diskEntry.workerDir,
      worktreePath: diskEntry.worktreePath,
      diskPresent: diskEntry.diskPresent,
      registered: Boolean(stateRegistration),
      registeredWorktrees: workerRegistrations,
      halfRegistered: workerRegistrations.length === 0,
      registrationMismatch: !registeredEntry && workerRegistrations.length > 0
        ? {
            registeredPaths: workerRegistrations.map((registration) => registration.path),
            manifestPath: pathKey,
            ambiguous: Boolean(pathKey) && workerRegistrations.length > 1,
          }
        : null,
    });
    seenWorkers.add(diskEntry.workerId);
  }
  for (const [workerId, workerRegistrations] of registeredByWorker.entries()) {
    if (seenWorkers.has(workerId)) continue;
    const registeredEntry = workerRegistrations.find(
      (registration) => basename(registration.path) === 'agent-os'
    ) || workerRegistrations[0];
    entries.push({
      ...registeredEntry,
      diskPresent: existsSync(registeredEntry.path),
      registeredWorktrees: workerRegistrations,
      halfRegistered: false,
    });
    seenWorkers.add(workerId);
  }

  const evaluation = pageAfterCursor(entries, cursor.evaluation, scanLimit, (entry) => entry.workerId);
  const evaluationEntries = evaluation.page;
  const summary = {
    scanned: evaluationEntries.length,
    reaped: 0,
    pruned: 0,
    skipped: 0,
    errors: 0,
    terminal: 0,
    prunable: 0,
    halfRegistered: 0,
    open: 0,
    unknown: 0,
    deferredActiveWorker: 0,
    deferredUnknownWorker: 0,
    limit,
    scanLimit,
  };

  const prStateCache = new Map();
  const reapStartedAt = Date.now();
  summary.budgetMs = budgetMs;
  summary.budgetExceeded = false;
  let evaluationCursor = cursor.evaluation;
  const probeFailures = { ...cursor.probeFailures };
  const currentWorkerIds = await listCurrentHammerWorkerIds(hqRoot, {
    registeredByWorker,
    readdirImpl,
    logger,
  });
  pruneProbeFailures(probeFailures, {
    currentWorkerIds,
    maxAgeMs: probeFailureTtlMs,
    maxEntries: probeFailureMaxEntries,
  });
  for (const entry of evaluationEntries) {
    if (Date.now() - reapStartedAt > budgetMs) {
      // Wall-clock budget: never let the reap phase monopolize the follow-up
      // tick and starve remediation `consume`. Remaining worktrees are
      // deferred to the next tick.
      summary.budgetExceeded = true;
      break;
    }
    evaluationCursor = entry.workerId;
    if (summary.reaped >= limit) {
      summary.skipped += 1;
      continue;
    }

    let reapReason = null;
    if (entry.halfRegistered) {
      reapReason = 'half-registered';
      summary.halfRegistered += 1;
    } else if (entry.prunable) {
      reapReason = 'prunable';
      summary.prunable += 1;
    } else if (entry.githubRepo) {
      const cacheKey = `${entry.githubRepo}#${entry.prNumber}`;
      let pr = prStateCache.get(cacheKey);
      if (!prStateCache.has(cacheKey)) {
        try {
          pr = await fetchPrState({
            repo: entry.githubRepo,
            prNumber: entry.prNumber,
            execGhWithRetryImpl,
            env,
          });
        } catch (err) {
          pr = { lookupError: String(err?.message || err) };
        }
        prStateCache.set(cacheKey, pr);
      }
      const terminal = classifyPrTerminal(pr);
      if (terminal) {
        reapReason = terminal;
        summary.terminal += 1;
      } else if (String(pr?.state || '').toUpperCase() === 'OPEN') {
        summary.open += 1;
      } else {
        summary.unknown += 1;
      }
    } else {
      summary.unknown += 1;
    }

    if (!reapReason) {
      summary.skipped += 1;
      continue;
    }

    // Liveness gate (2026-08-06 hammer worker_killed cascade fix): a hammer keeps
    // running its long post-merge close sequence AFTER its PR merges. Reaping its
    // worktree here deletes the live worker's cwd and kills it before it records
    // an exit. Defer while the hammer's dispatch is still active; the next tick
    // reaps once it terminalizes. Trees with no resolvable dispatch, or whose
    // dispatch is terminal/unreadable/phantom, reap now — and the worker-pool
    // orphan reaper is the independent backstop for any tree that later leaks.
    const manifestProbe = await resolveEntryLaunchRequestId(entry, { readFileImpl });
    const deferReap = (deferReason, launchRequestId, evidence = {}) => {
      summary.deferredActiveWorker += 1;
      if (evidence.livenessState === 'unknown') summary.deferredUnknownWorker += 1;
      logger?.info?.(JSON.stringify({
        event: 'closer_worktree_reap.deferred_active_worker',
        workerId: entry.workerId,
        prNumber: entry.prNumber,
        repo: entry.githubRepo || null,
        reason: reapReason,
        launchRequestId: launchRequestId || null,
        dispatchStatus: deferReason,
        ...evidence,
      }));
    };
    if (manifestProbe.defer) {
      // Transient failure reading the worker manifest — cannot prove the hammer
      // is gone, so defer rather than delete a possibly-live tree.
      deferReap(manifestProbe.reason, null, { livenessState: 'unknown' });
      continue;
    }
    if (manifestProbe.launchRequestId) {
      const activity = await probeWorkerActivityImpl({
        hqPath,
        launchRequestId: manifestProbe.launchRequestId,
        execFileImpl,
        env,
      });
      const activityState = activity?.state || (activity?.active ? 'active' : activity?.defer ? 'unknown' : 'inactive');
      if (activityState === 'active') {
        delete probeFailures[entry.workerId];
        deferReap(activity.status || activity.reason || null, manifestProbe.launchRequestId, {
          livenessState: 'active',
        });
        continue;
      }
      if (activityState === 'unknown') {
        const previous = probeFailures[entry.workerId] || {};
        const failureCount = Number(previous.failureCount || 0) + 1;
        const failure = {
          failureCount,
          firstFailureAt: previous.firstFailureAt || new Date().toISOString(),
          lastFailureAt: new Date().toISOString(),
          lastReason: activity.reason || 'probe-unreadable',
        };
        probeFailures[entry.workerId] = failure;
        if (failureCount < unknownProbeLimit) {
          deferReap(activity.reason, manifestProbe.launchRequestId, {
            livenessState: 'unknown',
            probeFailureCount: failureCount,
            probeFailureLimit: unknownProbeLimit,
            processState: 'not-probed',
          });
          continue;
        }
        const processProbe = await probeWorkerDirectoryUseImpl({
          workerDir: entry.workerDir,
          pid: activity.pid || null,
          timeoutMs: processProbeTimeoutMs,
          execFileImpl,
          env,
        });
        if (processProbe?.state !== 'inactive') {
          deferReap(activity.reason, manifestProbe.launchRequestId, {
            livenessState: 'unknown',
            probeFailureCount: failureCount,
            probeFailureLimit: unknownProbeLimit,
            processState: processProbe?.state || 'unknown',
            processReason: processProbe?.reason || null,
          });
          continue;
        }
        logger?.info?.(JSON.stringify({
          event: 'closer_worktree_reap.unknown_probe_resolved',
          workerId: entry.workerId,
          prNumber: entry.prNumber,
          repo: entry.githubRepo || null,
          reason: reapReason,
          launchRequestId: manifestProbe.launchRequestId,
          livenessState: 'unknown',
          dispatchStatus: activity.reason || null,
          probeFailureCount: failureCount,
          probeFailureLimit: unknownProbeLimit,
          processState: 'inactive',
          processReason: processProbe.reason || null,
          decision: 'reap',
        }));
      } else {
        delete probeFailures[entry.workerId];
      }
    }

    const removal = await removeHammerWorktree({
      entry,
      hqRoot,
      hqPath,
      execFileImpl,
      rmSyncImpl,
      logger,
    });
    if (removal.ok) {
      delete probeFailures[entry.workerId];
      summary.reaped += 1;
      if (removal.pruned) summary.pruned += 1;
      logger?.info?.(JSON.stringify({
        event: 'closer_worktree_reap.reaped',
        workerId: entry.workerId,
        prNumber: entry.prNumber,
        repo: entry.githubRepo || null,
        reason: reapReason,
        pruned: removal.pruned,
      }));
    } else {
      summary.errors += 1;
    }
  }

  summary.cursorPersisted = persistScanCursor(cursorPath, {
    repo: repoDiscovery.nextCursor,
    worker: workerDiscovery.nextCursor,
    evaluation: evaluationCursor,
    probeFailures,
  }, logger);

  return summary;
}

export {
  classifyPrTerminal,
  parseGitHubRepoFromRemote,
  parseGitWorktreePorcelain,
  parseHammerPrNumber,
  probeHammerWorkerActivity,
  probeWorkerDirectoryUse,
  reapCloserHammerWorktrees,
  resolveEntryLaunchRequestId,
};
