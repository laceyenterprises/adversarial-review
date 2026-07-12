import { execFile } from 'node:child_process';
import { existsSync, rmSync, statSync, promises as fsPromises } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { execGhWithRetry } from '../gh-cli.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_HQ_PATH = '/Users/airlock/.local/bin/hq';
const DEFAULT_HQ_ROOT = '/Users/airlock/agent-os-hq';
const DEFAULT_REAP_LIMIT = 8;
const DEFAULT_REAP_BUDGET_MS = 20_000;
const DEFAULT_SCAN_LIMIT = 500;
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

async function listHqRepoPaths(hqRoot, { scanLimit = DEFAULT_SCAN_LIMIT } = {}) {
  const reposDir = join(hqRoot, 'repos');
  if (!existsSync(reposDir)) return [];
  const entries = await fsPromises.readdir(reposDir, { withFileTypes: true }).catch((err) => {
    if (err?.code === 'ENOENT') return [];
    throw err;
  });
  return entries
    .slice(0, scanLimit)
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(reposDir, entry.name));
}

async function listHammerWorkerDirs(hqRoot, { scanLimit = DEFAULT_SCAN_LIMIT, now = Date.now(), recencyMs = 14 * 24 * 60 * 60 * 1000 } = {}) {
  const workersDir = join(hqRoot, 'workers');
  if (!existsSync(workersDir)) return [];
  const entries = await fsPromises.readdir(workersDir, { withFileTypes: true }).catch((err) => {
    if (err?.code === 'ENOENT') return [];
    throw err;
  });
  const cutoff = now - recencyMs;
  const workerEntries = [];
  for (const entry of entries.slice(0, scanLimit)) {
    if (!entry.isDirectory() || !HAMMER_WORKER_RE.test(entry.name)) continue;
    const workerDir = join(workersDir, entry.name);
    try {
      const stat = await fsPromises.stat(workerDir);
      if (stat.mtimeMs < cutoff) continue;
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    workerEntries.push(entry);
  }
  return workerEntries
    .filter((entry) => entry.isDirectory() && HAMMER_WORKER_RE.test(entry.name))
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
    });
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

async function removeHammerWorktree({
  entry,
  hqRoot,
  hqPath,
  execFileImpl,
  logger = console,
}) {
  const errors = [];
  if (entry.registered && entry.repoPath) {
    try {
      await execGit({
        repoPath: entry.repoPath,
        args: ['worktree', 'remove', '--force', entry.path || entry.worktreePath],
        execFileImpl,
        timeout: 60_000,
      });
    } catch (err) {
      errors.push(`git-worktree-remove:${String(err?.stderr || err?.message || err)}`);
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
  return { ok: errors.length === 0, errors };
}

async function reapCloserHammerWorktrees({
  hqRoot = process.env.HQ_ROOT || process.env.AGENT_OS_HQ_ROOT || DEFAULT_HQ_ROOT,
  hqPath = process.env.HQ_PATH || DEFAULT_HQ_PATH,
  limit = normalizePositiveInteger(process.env.AMA_CLOSER_WORKTREE_REAP_LIMIT, DEFAULT_REAP_LIMIT),
  budgetMs = normalizePositiveInteger(process.env.AMA_CLOSER_WORKTREE_REAP_BUDGET_MS, DEFAULT_REAP_BUDGET_MS),
  scanLimit = normalizePositiveInteger(process.env.AMA_CLOSER_WORKTREE_SCAN_LIMIT, DEFAULT_SCAN_LIMIT),
  repoPaths = null,
  execFileImpl = execFileAsync,
  execGhWithRetryImpl = execGhWithRetry,
  env = process.env,
  logger = console,
} = {}) {
  const effectiveRepoPaths = Array.isArray(repoPaths) ? repoPaths : await listHqRepoPaths(hqRoot, { scanLimit });
  const registered = await registeredWorktreesByPath({
    repoPaths: effectiveRepoPaths,
    execFileImpl,
    logger,
  });
  const diskEntries = await listHammerWorkerDirs(hqRoot, { scanLimit });
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

  const summary = {
    scanned: entries.length,
    reaped: 0,
    skipped: 0,
    errors: 0,
    terminal: 0,
    prunable: 0,
    halfRegistered: 0,
    open: 0,
    unknown: 0,
    limit,
  };

  const prStateCache = new Map();
  const reapStartedAt = Date.now();
  summary.budgetMs = budgetMs;
  summary.budgetExceeded = false;
  for (const entry of entries) {
    if (Date.now() - reapStartedAt > budgetMs) {
      // Wall-clock budget: never let the reap phase monopolize the follow-up
      // tick and starve remediation `consume`. Remaining worktrees are
      // deferred to the next tick.
      summary.budgetExceeded = true;
      break;
    }
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
      logger?.info?.(JSON.stringify({
        event: 'closer_worktree_reap.reaped',
        workerId: entry.workerId,
        prNumber: entry.prNumber,
        repo: entry.githubRepo || null,
        reason: reapReason,
      }));
    } else {
      summary.errors += 1;
    }
  }

  return summary;
}

export {
  classifyPrTerminal,
  parseGitHubRepoFromRemote,
  parseGitWorktreePorcelain,
  parseHammerPrNumber,
  reapCloserHammerWorktrees,
};
