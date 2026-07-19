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
const DEFAULT_CURSOR_PATH = join(ROOT, 'data', 'ama-closer-worktree-reaper-cursor.json');
const HAMMER_WORKER_RE = /^hammer-ama-pr-(\d+)(?:-.+)?$/;

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
      };
    }
  } catch (err) {
    if (err?.code !== 'ENOENT' && !(err instanceof SyntaxError)) {
      logger?.warn?.(`[closer-worktree-reap] cursor-read-failed: ${err?.message || err}`);
    }
  }
  return { repo: null, worker: null, evaluation: null };
}

function persistScanCursor(cursorPath, cursor, logger = console) {
  try {
    writeFileAtomic(cursorPath, `${JSON.stringify({
      schemaVersion: 1,
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

async function listHqRepoPaths(hqRoot, {
  scanLimit,
  lastName,
  readdirImpl = fsPromises.readdir,
  logger = console,
} = {}) {
  const reposDir = join(hqRoot, 'repos');
  const entries = await readdirImpl(reposDir, { withFileTypes: true }).catch((err) => {
    if (recoverableDiscoveryError(err)) {
      if (err?.code !== 'ENOENT') {
        logger?.warn?.(`[closer-worktree-reap] repo-discovery-skipped path=${reposDir} code=${err.code}`);
      }
      return [];
    }
    throw err;
  });
  const discovery = pageAfterCursor(
    entries.filter((entry) => entry.isDirectory()),
    lastName,
    scanLimit,
  );
  return {
    paths: discovery.page.map((entry) => join(reposDir, entry.name)),
    nextCursor: discovery.nextCursor,
  };
}

async function listHammerWorkerDirs(hqRoot, {
  scanLimit,
  lastName,
  readdirImpl = fsPromises.readdir,
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
  return {
    entries: discovery.page
      .map((entry) => {
        const workerDir = join(workersDir, entry.name);
        const worktreePath = join(workerDir, 'agent-os');
        return {
          workerId: entry.name,
          workerDir,
          worktreePath,
          prNumber: parseHammerPrNumber(entry.name),
          diskPresent: existsSync(worktreePath),
        };
      }),
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

async function removeHammerWorktree({
  entry,
  hqRoot,
  hqPath,
  execFileImpl,
  logger = console,
}) {
  const errors = [];
  let pruned = false;
  // When the worktree directory is already physically gone, `git worktree
  // remove` can only fail validation ("'.git' does not exist" / "is not a
  // working tree") on every tick, leaving stale registry metadata behind that
  // spams remove-incomplete and historically pinned branch-holder leases.
  // Reconcile those with `git worktree prune` instead of erroring forever. A
  // directory that is still present (e.g. "Directory not empty") is untouched
  // and stays on the real teardown path below.
  let treeAlreadyGone = Boolean(entry.registered && entry.repoPath && entry.diskPresent === false);
  let removePhysicalInvalidTree = false;
  if (entry.registered && entry.repoPath && !treeAlreadyGone) {
    try {
      await execGit({
        repoPath: entry.repoPath,
        args: ['worktree', 'remove', '--force', entry.path || entry.worktreePath],
        execFileImpl,
        timeout: 60_000,
      });
    } catch (err) {
      const detail = String(err?.stderr || err?.message || err);
      if (gitWorktreeRemoveIndicatesGone(detail)) {
        // The tree is already physically gone; prune the stale entry below.
        treeAlreadyGone = true;
        removePhysicalInvalidTree = entry.diskPresent !== false;
      } else {
        errors.push(`git-worktree-remove:${detail}`);
      }
    }
  }

  if (treeAlreadyGone) {
    const stalePhysicalPath = entry.worktreePath || entry.path;
    if (removePhysicalInvalidTree && stalePhysicalPath) {
      try {
        rmSync(stalePhysicalPath, { recursive: true, force: true });
      } catch (err) {
        errors.push(`worktree-rm:${String(err?.message || err)}`);
      }
    }
    try {
      await execGit({
        repoPath: entry.repoPath,
        args: ['worktree', 'prune'],
        execFileImpl,
        timeout: 60_000,
      });
      pruned = true;
    } catch (err) {
      errors.push(`git-worktree-prune:${String(err?.stderr || err?.message || err)}`);
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

  if (!entry.registered && entry.workerDir && existsSync(entry.workerDir)) {
    try {
      const stat = statSync(entry.workerDir);
      if (stat.isDirectory() && HAMMER_WORKER_RE.test(basename(entry.workerDir))) {
        rmSync(entry.workerDir, { recursive: true, force: true });
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
  const seen = new Set();

  for (const diskEntry of diskEntries) {
    const pathKey = resolve(diskEntry.worktreePath);
    const registeredEntry = registered.get(pathKey);
    entries.push({
      ...diskEntry,
      ...(registeredEntry || {}),
      path: registeredEntry?.path || pathKey,
      registered: Boolean(registeredEntry),
      halfRegistered: !registeredEntry,
    });
    seen.add(pathKey);
  }
  for (const [pathKey, registeredEntry] of registered.entries()) {
    if (seen.has(pathKey)) continue;
    entries.push({ ...registeredEntry, diskPresent: existsSync(pathKey), halfRegistered: false });
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
    limit,
    scanLimit,
  };

  const prStateCache = new Map();
  const reapStartedAt = Date.now();
  summary.budgetMs = budgetMs;
  summary.budgetExceeded = false;
  let evaluationCursor = cursor.evaluation;
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

    const removal = await removeHammerWorktree({
      entry,
      hqRoot,
      hqPath,
      execFileImpl,
      logger,
    });
    if (removal.ok) {
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
  }, logger);

  return summary;
}

export {
  classifyPrTerminal,
  parseGitHubRepoFromRemote,
  parseGitWorktreePorcelain,
  parseHammerPrNumber,
  reapCloserHammerWorktrees,
};
