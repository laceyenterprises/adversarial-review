// Remediation git & PR I/O helpers.
//
// Extracted from follow-up-remediation.mjs (ARC-19 wave3). This is a
// self-contained leaf holding the transport-level git/GitHub helpers the
// remediation orchestration depends on:
//   - PR branch-metadata resolution (fetch base/head refs via the REST pulls
//     endpoint and hydrate them onto the durable job record);
//   - transient-retry wrappers for network-bound git/gh commands;
//   - workspace git-state inspection + reset;
//   - the branch-contamination cherry audit that proves a remediated branch
//     carries no already-upstream commits before a rereview.
//
// It imports only node: builtins and ./follow-up-jobs.mjs and MUST NOT import
// ./follow-up-remediation.mjs (that would create a cycle — the monolith imports
// this module, not the other way around). `sleep`, `execFileAsync`, and the
// retry-delay constant are behavior-preserving private copies of trivial
// primitives that also exist in the monolith, per the established
// remediation-oss-readiness.mjs / fast-merge-processing.mjs precedent.

import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { writeFollowUpJob } from './follow-up-jobs.mjs';

const execFileAsync = promisify(execFile);

const WORKSPACE_GIT_RETRY_DELAYS_MS = [250, 750];

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function normalizeBaseBranch(baseBranch) {
  if (typeof baseBranch !== 'string') return null;
  const trimmed = baseBranch.trim();
  return trimmed || null;
}

function normalizePrHeadRef(branch) {
  if (typeof branch !== 'string') return null;
  const trimmed = branch.trim();
  return trimmed || null;
}

// Normalize a PR number to a positive integer before it is interpolated into a
// REST path. A corrupt or malformed durable job must fail fast with a clear
// error rather than build a wrong/misleading `gh api repos/.../pulls/<x>` path.
// Mirrors the same-named helper in github-api.mjs / adversarial-gate-status.mjs.
function normalizePrNumber(prNumber) {
  const normalized = Number(String(prNumber ?? '').trim());
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new TypeError(`Invalid GitHub PR number: ${prNumber}`);
  }
  return normalized;
}

function isTransientWorkspaceNetworkError(err) {
  const detail = [err?.message, err?.stdout, err?.stderr].filter(Boolean).join('\n');
  return /(?:unable to access|could not resolve host|failed to connect|connection (?:reset|timed out)|connection refused|network is unreachable|operation timed out|timed out|timeout|TLS|SSL|HTTP 5\d\d|The requested URL returned error: 5\d\d|remote end hung up unexpectedly|early EOF|RPC failed|temporary failure|temporarily unavailable)/i.test(detail);
}

async function runWorkspaceNetworkCommandWithTransientRetry({
  execFileImpl,
  command,
  args,
  options,
  retryDelaysMs = WORKSPACE_GIT_RETRY_DELAYS_MS,
}) {
  const delays = [0, ...retryDelaysMs];
  let lastError = null;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) {
      await sleep(delays[attempt]);
    }
    try {
      return await execFileImpl(command, args, options);
    } catch (err) {
      lastError = err;
      if (!isTransientWorkspaceNetworkError(err) || attempt === delays.length - 1) {
        throw err;
      }
    }
  }
  throw lastError;
}

async function runWorkspaceGitWithTransientRetry(args, {
  execFileImpl,
  options,
  retryDelaysMs = WORKSPACE_GIT_RETRY_DELAYS_MS,
}) {
  return runWorkspaceNetworkCommandWithTransientRetry({
    execFileImpl,
    command: 'git',
    args,
    options,
    retryDelaysMs,
  });
}

async function fetchPRBranchMetadata({
  repo,
  prNumber,
  execFileImpl = execFileAsync,
} = {}) {
  // Resolve PR branch metadata via the REST pulls endpoint instead of
  // `gh pr view --json` (which goes through GraphQL). GraphQL and REST have
  // SEPARATE rate-limit pools; during a heavy throughput push the shared user
  // token's GraphQL budget gets exhausted first, and a GraphQL-based lookup
  // here then fails with "API rate limit already exceeded", wedging every
  // remediation spawn. REST (`gh api repos/{owner}/{repo}/pulls/{n}`) draws
  // from the core pool, which has far more headroom. base.ref / head.ref are
  // first-class fields on the REST PR object.
  const [owner, repoName] = String(repo).split('/');
  if (!owner || !repoName) {
    throw new Error(`Invalid repo slug: ${repo}`);
  }
  const normalizedPrNumber = normalizePrNumber(prNumber);
  const { stdout } = await runWorkspaceNetworkCommandWithTransientRetry({
    execFileImpl,
    command: 'gh',
    args: ['api', `repos/${owner}/${repoName}/pulls/${normalizedPrNumber}`],
    options: { maxBuffer: 2 * 1024 * 1024 },
  });
  const parsed = JSON.parse(String(stdout || '{}'));
  const baseBranch = normalizeBaseBranch(parsed?.base?.ref);
  if (!baseBranch) {
    throw new Error(`Could not resolve baseRefName for ${repo}#${prNumber}`);
  }
  const branch = normalizePrHeadRef(parsed?.head?.ref);
  // head.repo.full_name lets callers tell same-repo PRs (push-back works
  // against origin) from fork PRs (head branch is not on origin).
  const headRepo = parsed?.head?.repo?.full_name || null;
  return { baseBranch, branch, headRepo };
}

async function fetchPRBaseBranch({
  repo,
  prNumber,
  execFileImpl = execFileAsync,
} = {}) {
  const metadata = await fetchPRBranchMetadata({ repo, prNumber, execFileImpl });
  return metadata.baseBranch;
}

async function ensureJobBranchMetadata({
  job,
  jobPath,
  requireBranch = false,
  execFileImpl = execFileAsync,
} = {}) {
  const existing = normalizeBaseBranch(job?.baseBranch);
  const existingBranch = normalizePrHeadRef(job?.branch);
  if (existing && (!requireBranch || existingBranch)) {
    return {
      job: {
        ...job,
        baseBranch: existing,
        branch: existingBranch || null,
      },
      baseBranch: existing,
      branch: existingBranch,
      hydrated: false,
    };
  }

  let metadata;
  try {
    metadata = await fetchPRBranchMetadata({
      repo: job?.repo,
      prNumber: job?.prNumber,
      execFileImpl,
    });
  } catch (err) {
    err.isBaseBranchResolutionError = true;
    throw err;
  }
  const baseBranch = existing || metadata.baseBranch;
  const branch = existingBranch || metadata.branch;
  if (requireBranch && !branch) {
    const err = new Error(`Could not resolve headRefName for ${job?.repo}#${job?.prNumber}`);
    err.isBaseBranchResolutionError = true;
    throw err;
  }
  const nextJob = {
    ...job,
    baseBranch,
    branch: branch || null,
  };
  if (jobPath) {
    writeFollowUpJob(jobPath, nextJob);
  }
  return { job: nextJob, baseBranch, branch, hydrated: true };
}

async function ensureJobBaseBranch({
  job,
  jobPath,
  execFileImpl = execFileAsync,
} = {}) {
  const resolved = await ensureJobBranchMetadata({
    job,
    jobPath,
    requireBranch: false,
    execFileImpl,
  });
  return { job: resolved.job, baseBranch: resolved.baseBranch, hydrated: resolved.hydrated };
}

function requireJobBaseBranch(job) {
  const baseBranch = normalizeBaseBranch(job?.baseBranch);
  if (!baseBranch) {
    throw new Error(`baseBranch is required for ${job?.repo || 'unknown'}#${job?.prNumber || 'unknown'} follow-up job`);
  }
  return baseBranch;
}

function normalizeGitHubRepo(value) {
  return String(value ?? '')
    .trim()
    .replace(/^git@github\.com:/i, '')
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+/, '');
}

async function inspectWorkspaceState({ workspaceDir, expectedRepo, execFileImpl = execFileAsync }) {
  if (!existsSync(join(workspaceDir, '.git'))) {
    return { reset: false, reason: 'missing' };
  }

  try {
    const [{ stdout: remoteUrl }, { stdout: statusOutput }] = await Promise.all([
      execFileImpl('git', ['config', '--get', 'remote.origin.url'], {
        cwd: workspaceDir,
        maxBuffer: 10 * 1024 * 1024,
      }),
      execFileImpl('git', ['status', '--short'], {
        cwd: workspaceDir,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ]);

    const actualRepo = normalizeGitHubRepo(remoteUrl);
    if (actualRepo !== expectedRepo) {
      return { reset: true, reason: 'repo-mismatch', actualRepo };
    }

    if (String(statusOutput || '').trim()) {
      return { reset: true, reason: 'dirty-worktree' };
    }

    return { reset: false, reason: 'valid', actualRepo };
  } catch (err) {
    return { reset: true, reason: 'invalid-workspace', error: err.message };
  }
}

function resetWorkspaceDir(workspaceDir) {
  rmSync(workspaceDir, { recursive: true, force: true });
}

/**
 * Audit a remediation workspace for branch contamination — commits on HEAD
 * that are patch-equivalent to commits already on `origin/<baseBranch>`.
 *
 * A remediation worker is supposed to rebase against a freshly-fetched
 * `origin/<base>` before remediating; git's cherry-pick detection drops
 * commits whose patch matches upstream. Workers that rebase against a
 * stale local ref, skip the fetch, or apply commits manually can produce
 * a branch whose log shows already-merged commits as if they were the
 * PR's own work — which then confuses the next adversarial reviewer pass
 * because it reviews the entire `origin/<base>...HEAD` diff.
 *
 * This audit runs `git fetch --prune origin <baseBranch>` to refresh the
 * upstream ref, then uses `git cherry origin/<baseBranch> HEAD` to flag
 * every commit on HEAD whose patch already lives upstream. `git cherry`
 * emits only right-side commits and prefixes patch-equivalent ones with
 * `-`, which makes it safe to parse directly. This audit is load-bearing:
 * reconcile must fail closed when fetch/cherry cannot prove cleanliness.
 *
 * Returns `{ suspect: [{ sha, subject }, ...], error: <message|null> }`.
 * Callers use either a non-empty `suspect` list or a non-null `error` to
 * refuse the rereview request and surface a durable failure to the operator.
 */
async function auditWorkspaceForContamination({
  workspaceDir,
  baseBranch,
  execFileImpl = execFileAsync,
}) {
  const resolvedBaseBranch = normalizeBaseBranch(baseBranch);
  if (!workspaceDir || typeof workspaceDir !== 'string') {
    return { suspect: [], error: 'no workspaceDir provided' };
  }
  if (!resolvedBaseBranch) {
    return { suspect: [], error: 'baseBranch is required for branch-contamination audit' };
  }
  if (!existsSync(join(workspaceDir, '.git'))) {
    return { suspect: [], error: 'workspace has no .git' };
  }

  try {
    await execFileImpl('git', ['-C', workspaceDir, 'fetch', '--prune', 'origin', resolvedBaseBranch], {
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    return { suspect: [], error: `git fetch origin ${resolvedBaseBranch} failed: ${err.message}` };
  }

  let stdout = '';
  try {
    const result = await execFileImpl('git', [
      '-C', workspaceDir,
      'cherry',
      `origin/${resolvedBaseBranch}`,
      'HEAD',
    ], { maxBuffer: 10 * 1024 * 1024 });
    stdout = String(result.stdout || '');
  } catch (err) {
    return { suspect: [], error: `git cherry origin/${resolvedBaseBranch} HEAD failed: ${err.message}` };
  }

  const suspectShas = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([+-])\s+([0-9a-f]{7,40})(?:\s|$)/i);
    if (!match || match[1] !== '-') continue;
    suspectShas.push(match[2]);
  }
  if (suspectShas.length === 0) {
    return { suspect: [], error: null };
  }

  try {
    const result = await execFileImpl('git', [
      '-C', workspaceDir,
      'show',
      '--quiet',
      '--format=%H\x1f%s',
      ...suspectShas,
    ], { maxBuffer: 10 * 1024 * 1024 });
    const suspect = String(result.stdout || '')
      .split('\n')
      .map((rawLine) => rawLine.trim())
      .filter(Boolean)
      .map((line) => {
        const fieldSep = line.indexOf('\x1f');
        const sha = fieldSep >= 0 ? line.slice(0, fieldSep) : line;
        const subject = fieldSep >= 0 ? line.slice(fieldSep + 1) : '';
        return sha ? { sha, subject } : null;
      })
      .filter(Boolean);
    return { suspect, error: null };
  } catch (err) {
    return {
      suspect: suspectShas.map((sha) => ({ sha, subject: '' })),
      error: `git show subject lookup failed: ${err.message}`,
    };
  }
}

export {
  fetchPRBranchMetadata,
  ensureJobBranchMetadata,
  ensureJobBaseBranch,
  requireJobBaseBranch,
  runWorkspaceNetworkCommandWithTransientRetry,
  runWorkspaceGitWithTransientRetry,
  inspectWorkspaceState,
  resetWorkspaceDir,
  auditWorkspaceForContamination,
};
