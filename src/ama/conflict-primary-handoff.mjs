import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { createFollowUpJob, getFollowUpJobDir, readFollowUpJob } from '../follow-up-jobs.mjs';
import { parseKnownPrefix } from '../adapters/subject/github-pr/title-tagging.mjs';
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { remediationJobOwnership } from '../remediation-job-ownership.mjs';
import { findFollowUpForJob } from '../follow-up-review-claim.mjs';
import { meteredExecFile } from '../metered-gh.mjs';

export const CONFLICT_PRIMARY_HANDOFF_REASON = 'conflict-primary-unproven';
const execFileAsync = promisify(execFile);
const MAX_CONTEXT_ENTRIES = 50;
const MAX_CONTEXT_BODY_CHARS = 2000;
const MAX_CONTEXT_URL_CHARS = 2048;

function boundedReviewContext(entries) {
  // Sort across all three sources. Undated entries retain their source order
  // before dated entries; stable sorting also preserves equal-time ordering.
  const timestamp = entry => Date.parse(entry.updated_at || entry.updatedAt
    || entry.submittedAt || entry.created_at || entry.createdAt || '') || 0;
  return entries
    .filter(entry => typeof entry.body === 'string' && entry.body.trim())
    .sort((a, b) => timestamp(a) - timestamp(b))
    .slice(-MAX_CONTEXT_ENTRIES)
    .map(entry => {
      const url = entry.html_url || entry.url;
      return {
        body: entry.body.length > MAX_CONTEXT_BODY_CHARS
          ? `${entry.body.slice(0, MAX_CONTEXT_BODY_CHARS - 1)}…` : entry.body,
        url: typeof url === 'string' ? url.slice(0, MAX_CONTEXT_URL_CHARS) : null,
      };
    });
}

function existingJob(rootDir, duplicate) {
  if (!duplicate?.jobId) return null;
  for (const bucket of ['pending', 'inProgress', 'completed', 'failed', 'stopped']) {
    try {
      return readFollowUpJob(join(getFollowUpJobDir(rootDir, bucket), `${duplicate.jobId}.json`));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  // Preserve the archived record's execution metadata without granting custody.
  if (duplicate.status === 'stopped-archived') {
    const archiveDir = getFollowUpJobDir(rootDir, 'stoppedArchived');
    for (const entry of readdirSync(archiveDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const job = readFollowUpJob(join(archiveDir, entry.name, `${duplicate.jobId}.json`));
        return { ...job, status: 'stopped-archived' };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  throw new Error('conflict-primary-handoff-job-unavailable');
}

function handoffReceipt(job, headSha, now) {
  if (!job?.jobId) throw new Error('conflict-primary-handoff-enqueue-unconfirmed');
  return {
    action: 'hold',
    hammerStop: { headSha, predicate: CONFLICT_PRIMARY_HANDOFF_REASON,
      owner: 'remediator', remediationJobId: job.jobId,
      remediationStatus: job.status, deterministic: true },
    remediation: { jobId: job.jobId, status: job.status,
      live: remediationJobOwnership(job, { now }).live,
      createdAt: job.createdAt, claimedAt: job.claimedAt, lastHeartbeatAt: job.lastHeartbeatAt,
      remediationWorker: job.remediationWorker,
      headSha, closureHandoff: { reason: CONFLICT_PRIMARY_HANDOFF_REASON, headSha, review: 'full' } },
  };
}

// The existing cross-process review claim keys this work order by PR/head/reason,
// including terminal and archived jobs. A crash after enqueue needs no new job.
export function conflictPrimaryWorkOrder(headSha) {
  return `## Blocking issues
- [P1] Resolve the base conflict on PR head ${headSha} through builder remediation.
  Rebase or merge onto the current base and resolve conflicts preserving both
  sides' intent. Read the PR's review comments and address all open findings.
  Run full-range validation and push a new head for a normal full adversarial
  review. This is not a patch-equivalent replay; do not carry forward the old
  review or publish an unproven closer replay.

## Non-blocking issues
- None.

## Verdict
Request changes

Work-order reason: ${CONFLICT_PRIMARY_HANDOFF_REASON}
`;
}

export async function handoffConflictPrimary({
  rootDir, repo, prNumber, headSha, now,
  execFileImpl = execFileAsync, createJobImpl = createFollowUpJob,
}) {
  headSha = headSha.toLowerCase();
  const identity = { repo, prNumber, revisionRef: headSha,
    closureHandoff: { reason: CONFLICT_PRIMARY_HANDOFF_REASON, headSha } };
  const existing = findFollowUpForJob(rootDir, identity);
  if (existing) return handoffReceipt(existingJob(rootDir, existing), headSha, now);
  // Re-read branch and builder provenance, and fence a moved/closed PR before
  // enqueue. This read runs in the watcher, never inside a restricted worker.
  const { stdout } = await meteredExecFile(execFileImpl, 'gh', ['pr', 'view', String(prNumber),
    '--repo', repo, '--json', 'state,headRefOid,headRefName,baseRefName,title,reviews,comments'], {
    encoding: 'utf8', timeout: loadAwareTimeoutMs(15_000),
  });
  const pr = JSON.parse(stdout);
  if (pr.state !== 'OPEN' || pr.headRefOid?.toLowerCase() !== headSha.toLowerCase()) {
    return { action: 'none', reason: 'conflict-primary-handoff-head-changed' };
  }
  const builderTag = parseKnownPrefix(pr.title)?.tag;
  if (!builderTag || !pr.headRefName || !pr.baseRefName) {
    throw new Error('conflict-primary-handoff-provenance-unavailable');
  }
  // gh pr view does not expose inline review comments as a JSON field.
  const { stdout: inlineComments } = await meteredExecFile(execFileImpl, 'gh',
    ['api', `repos/${repo}/pulls/${prNumber}/comments?per_page=100`, '--paginate', '--slurp'], {
      encoding: 'utf8', timeout: loadAwareTimeoutMs(15_000),
    });
  const reviewComments = JSON.parse(inlineComments).flat();
  const result = createJobImpl({
    rootDir, repo, prNumber, revisionRef: headSha,
    branch: pr.headRefName, baseBranch: pr.baseRefName, builderTag,
    reviewBody: conflictPrimaryWorkOrder(headSha), reviewPostedAt: now,
    closureHandoff: { reason: CONFLICT_PRIMARY_HANDOFF_REASON, headSha, review: 'full',
      reviewContext: boundedReviewContext([...(pr.reviews || []), ...(pr.comments || []), ...reviewComments]) },
  });
  const job = result.job || existingJob(rootDir, result.duplicateOf);
  return handoffReceipt(job, headSha, now);
}
