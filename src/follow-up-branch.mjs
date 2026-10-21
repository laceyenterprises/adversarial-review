// REMEDBRANCH-01: synchronous queue writers retain their atomic creation contract.
import { execFileSync } from 'node:child_process';
import { meteredExecFileSync } from './metered-gh.mjs';
import { withGitHubBudgetScope } from './rate-limit-throttle.mjs';
import { parseKnownPrefix } from './adapters/subject/github-pr/title-tagging.mjs';

export function readFollowUpPRHead({ repo, prNumber }) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repo || '') || !Number.isSafeInteger(Number(prNumber)) || Number(prNumber) <= 0) {
    throw new Error('Invalid PR identity for branch resolution');
  }
  const pr = JSON.parse(withGitHubBudgetScope({}, () => meteredExecFileSync(execFileSync, 'gh',
    ['api', `repos/${repo}/pulls/${Number(prNumber)}`],
    { encoding: 'utf8', timeout: 8000, maxBuffer: 2 * 1024 * 1024 })));
  return { branch: pr?.head?.ref, builderTag: parseKnownPrefix(pr?.title)?.tag || null };
}

export function resolveFollowUpBranch(job, { readPRHeadImpl = readFollowUpPRHead, now = new Date().toISOString() } = {}) {
  const branch = typeof job.branch === 'string' ? job.branch.trim() : '';
  if (branch) return { ...job, branch, branchResolution: null };
  try {
    const head = readPRHeadImpl({ repo: job.repo, prNumber: job.prNumber });
    if (typeof head?.branch === 'string' && head.branch.trim()) {
      return { ...job, branch: head.branch.trim(), builderTag: job.builderTag || head.builderTag || null, branchResolution: null };
    }
  } catch { /* Unknown evidence holds the job; the daemon retries without a worker. */ }
  return { ...job, branch: null, branchResolution: {
    state: 'blocked', reason: 'branch-unresolved',
    retryAfter: new Date(Date.parse(now) + 60_000).toISOString(),
  } };
}
