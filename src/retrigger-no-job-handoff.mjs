// NOOWNER-01 (SEV1) — `retrigger-remediation` on a PR with no follow-up job
// does something.
//
// agent-os PR 8007, 2026-10-10 20:37:32: the operator applied the label and
// the watcher logged "retrigger-remediation label on ...#8007: no-job (no
// follow-up job exists for this PR yet)". The label stayed on the PR, nothing
// told the operator, and nothing ran. On 8007 the job had existed: the CI
// admission guard's requeue of the `stopped:max-rounds-reached` job deleted its
// file (`ci-regression-no-job`), and the row was parked `ci-blocked`.
//
// With no job to requeue, the label now picks the action the PR's state calls
// for:
//   - a `ci-blocked` row (red external CI, no remediation job left) goes to the
//     hammer through the CIBLOCKHAM-01 owner route;
//   - otherwise, the latest posted adversarial review becomes a new follow-up
//     job, pinned to the live head the same way the requeue path pins it. A PR
//     whose rounds are already spent gets a job that stops at
//     `max-rounds-reached`, where the round-cap hammer handoff owns it;
//   - with no posted review there is nothing to remediate.
// The label handler removes the label and posts an acknowledgement naming the
// action and its outcome in every case.

import { maybeRouteCiBlockedToHammer } from './ci-blocked-hammer.mjs';
import { REREVIEW_CI_BLOCKED_STATUS } from './review-statuses.mjs';
import { queueFollowUpForRecoveredPostedReview } from './reviewer-pass-reaper.mjs';

export const RETRIGGER_NO_JOB_CI_BLOCKED_REASON = 'retrigger-remediation-no-job';

const POSTED_PASS_SQL = (orderBy) => `SELECT *
    FROM reviewer_passes
   WHERE repo = ?
     AND pr_number = ?
     AND pass_kind IN ('first-pass', 'rereview')
     AND body_md IS NOT NULL AND TRIM(body_md) <> ''
     AND gh_comment_id IS NOT NULL AND TRIM(CAST(gh_comment_id AS TEXT)) <> ''
   ORDER BY ${orderBy} DESC, pass_id DESC
   LIMIT 1`;

// The latest adversarial review that was actually posted to the PR.
export function latestPostedReviewPass({ db, repoPath, prNumber } = {}) {
  for (const orderBy of ['COALESCE(body_captured_at, ended_at, started_at)', 'COALESCE(ended_at, started_at)']) {
    try {
      const row = db?.prepare(POSTED_PASS_SQL(orderBy)).get(repoPath, prNumber);
      return row || null;
    } catch {
      // Older review DBs lack body_captured_at; retry without it.
    }
  }
  return null;
}

/**
 * @returns {Promise<{ action: 'hammer'|'job'|'none', outcome: string, detail: string|null }>}
 */
export async function handOffRetriggerWithoutJob({
  rootDir,
  db,
  repoPath,
  prNumber,
  existing,
  subjectRef = null,
  currentRevisionRef = null,
  labelNames = [],
  execFileImpl,
  routeCiBlockedImpl = maybeRouteCiBlockedToHammer,
  findPostedPassImpl = latestPostedReviewPass,
  queueFollowUpImpl = queueFollowUpForRecoveredPostedReview,
} = {}) {
  if (existing?.review_status === REREVIEW_CI_BLOCKED_STATUS) {
    const route = await routeCiBlockedImpl({
      ciAdmission: { hammerOwner: true, reason: RETRIGGER_NO_JOB_CI_BLOCKED_REASON },
      rootDir, db, repoPath, prNumber, existing, subjectRef, currentRevisionRef, labelNames, execFileImpl,
    });
    return {
      action: 'hammer',
      outcome: route?.outcome || (route?.error ? 'hammer-route-error' : 'hammer-route-not-handled'),
      detail: route?.error ? String(route.error?.message || route.error) : (route?.reason || null),
    };
  }
  const pass = findPostedPassImpl({ db, repoPath, prNumber });
  if (!pass) {
    return {
      action: 'none',
      outcome: 'no-posted-review',
      detail: 'no posted adversarial review exists to remediate; apply retrigger-review for a fresh review',
    };
  }
  // Pin the job to the live head, as the requeue path does: a job pinned to an
  // older reviewed head is stopped as `stale-review-head` before it runs.
  const queued = queueFollowUpImpl({
    rootDir,
    row: { ...pass, head_sha: currentRevisionRef || pass.head_sha },
    reviewRow: existing,
    reviewPostedAt: pass.body_captured_at || pass.ended_at || pass.started_at || new Date().toISOString(),
  });
  return queued?.queued
    ? { action: 'job', outcome: 'job-created', detail: queued.jobPath || null }
    : { action: 'job', outcome: `job-not-created:${queued?.reason || 'unknown'}`, detail: queued?.duplicateOf || null };
}
