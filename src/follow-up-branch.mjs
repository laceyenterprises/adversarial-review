import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
// REMEDBRANCH-01: synchronous queue writers retain their atomic creation contract.
import { execFileSync } from 'node:child_process';
import { meteredExecFileSync } from './metered-gh.mjs';
import { withGitHubBudgetScope } from './rate-limit-throttle.mjs';
import { parseKnownPrefix } from './adapters/subject/github-pr/title-tagging.mjs';

export const MAX_BRANCH_RESOLUTION_ATTEMPTS = 3;

export function readFollowUpPRHead({ repo, prNumber }) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repo || '') || !Number.isSafeInteger(Number(prNumber)) || Number(prNumber) <= 0) {
    throw new Error('Invalid PR identity for branch resolution');
  }
  const pr = JSON.parse(withGitHubBudgetScope({}, () => meteredExecFileSync(execFileSync, 'gh',
    ['api', `repos/${repo}/pulls/${Number(prNumber)}`],
    { encoding: 'utf8', timeout: loadAwareTimeoutMs(8000), maxBuffer: 2 * 1024 * 1024 })));
  return { branch: pr?.head?.ref, builderTag: parseKnownPrefix(pr?.title)?.tag || null };
}

export function resolveFollowUpBranch(job, { readPRHeadImpl = readFollowUpPRHead, now = new Date().toISOString() } = {}) {
  const branch = typeof job.branch === 'string' ? job.branch.trim() : '';
  if (branch) return { ...job, branch, branchResolution: null };
  // Legacy holds already made one lookup at creation.
  const previousAttempts = Number.isSafeInteger(job.branchResolution?.attempts) && job.branchResolution.attempts >= 0
    ? job.branchResolution.attempts : job.branchResolution?.state === 'blocked' ? 1 : 0;
  if (previousAttempts >= MAX_BRANCH_RESOLUTION_ATTEMPTS) return job;
  try {
    const head = readPRHeadImpl({ repo: job.repo, prNumber: job.prNumber });
    if (typeof head?.branch === 'string' && head.branch.trim()) {
      return { ...job, branch: head.branch.trim(), builderTag: job.builderTag || head.builderTag || null, branchResolution: null };
    }
  } catch { /* Unknown evidence holds the job; the daemon retries without a worker. */ }
  return { ...job, branch: null, branchResolution: {
    state: 'blocked', reason: 'branch-unresolved',
    attempts: previousAttempts + 1,
    retryAfter: new Date(Date.parse(now) + 60_000).toISOString(),
  } };
}
