// operator-retrigger-helpers.mjs — shared helpers for the operator-driven
// off-cycle retrigger surfaces (`retrigger-review`, `retrigger-remediation`).
//
// Why this exists: the watcher's natural budget loop is the canonical path —
// risk-tier round budgets, cascade-suppression, attempt counters all do the
// right thing under normal operation. But there are real cases where an
// operator (or a session that just substantially rewrote the PR) needs to
// force a fresh cycle outside that loop. Without these helpers, "force a
// fresh cycle" became "edit the SQLite file by hand" — the LAC-439 footgun
// that produced silent no-ops because the watcher gates on review_status,
// not on rereview_requested_at alone.
//
// The two operations:
//
//   bumpRemediationBudget(...) — find the latest terminal follow-up job for
//     a PR and increase its `remediationPlan.maxRounds` by N. Watcher's
//     `summarizePRRemediationLedger` reads `latestMaxRounds` from this same
//     field, so the next pass sees a higher cap and re-arms the gate.
//     Audit row appended to `operatorRetriggerAudit[]` on the same job
//     record so the override is reconstructable.
//
//   (re-arming the review row itself stays in retrigger-review.mjs via the
//    existing `requestReviewRereview` atomic transition.)

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  FOLLOW_UP_JOB_DIRS,
  ROUND_BUDGET_BY_RISK_CLASS,
  getFollowUpJobDir,
  readFollowUpJob,
  writeFollowUpJob,
} from './follow-up-jobs.mjs';

const DEFAULT_RISK_CLASS = 'medium';

/**
 * Find the latest follow-up job for (repo, prNumber) across every directory
 * the watcher reads. "Latest" = the row with the largest of
 * (completedAt | failedAt | stoppedAt | claimedAt | createdAt).
 *
 * Mirrors `summarizePRRemediationLedger`'s scan exactly so the bump targets
 * the same row the gate will read on its next pass. If no job exists, the
 * gate has no `latestMaxRounds` to read either, and a bump is a no-op
 * relative to the budget calculation — we surface that explicitly so the
 * operator knows the bump did not take effect.
 */
function findLatestJobForPR(rootDir, { repo, prNumber }) {
  const targetRepo = String(repo ?? '');
  const targetPr = Number(prNumber);
  if (!targetRepo || !Number.isFinite(targetPr)) {
    return null;
  }

  let latestJob = null;
  let latestJobPath = null;
  let latestJobKey = null;
  let latestTimestamp = '';

  for (const key of Object.keys(FOLLOW_UP_JOB_DIRS)) {
    const dir = getFollowUpJobDir(rootDir, key);
    if (!existsSync(dir)) continue;

    let names;
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.json'));
    } catch {
      continue;
    }

    for (const name of names) {
      const jobPath = join(dir, name);
      let job;
      try {
        job = readFollowUpJob(jobPath);
      } catch {
        continue;
      }
      if (!job) continue;
      if (job.repo !== targetRepo) continue;
      if (Number(job.prNumber) !== targetPr) continue;

      const ts = job.completedAt
        || job.failedAt
        || job.stoppedAt
        || job.claimedAt
        || job.createdAt
        || '';
      if (ts > latestTimestamp) {
        latestTimestamp = ts;
        latestJob = job;
        latestJobPath = jobPath;
        latestJobKey = key;
      }
    }
  }

  if (!latestJob) return null;
  return { job: latestJob, jobPath: latestJobPath, jobKey: latestJobKey };
}

/**
 * Bump the latest job's `remediationPlan.maxRounds` by `bumpBy` (default 1).
 * Atomic-write the updated job back. Append an entry to
 * `operatorRetriggerAudit[]` capturing prior/new values, reason, actor, and
 * timestamp.
 *
 * Returns:
 *   { bumped: true, jobPath, jobKey, priorMaxRounds, newMaxRounds, bumpBy }
 *     — the bump took effect.
 *   { bumped: false, reason: 'no-job-found' }
 *     — there is no follow-up job for this PR yet (no remediation has ever
 *       been planned). Operator should retrigger review first; the resulting
 *       remediation cycle will create the first job, and any subsequent
 *       budget bump can land on it.
 *   { bumped: false, reason: 'invalid-bump-by', bumpBy }
 *     — bumpBy is not a positive integer.
 */
function bumpRemediationBudget({
  rootDir,
  repo,
  prNumber,
  bumpBy = 1,
  reason,
  by = 'operator',
}) {
  if (!Number.isInteger(bumpBy) || bumpBy <= 0) {
    return { bumped: false, reason: 'invalid-bump-by', bumpBy };
  }
  if (!reason || !String(reason).trim()) {
    return { bumped: false, reason: 'reason-required' };
  }

  const found = findLatestJobForPR(rootDir, { repo, prNumber });
  if (!found) {
    return { bumped: false, reason: 'no-job-found' };
  }

  const { job, jobPath, jobKey } = found;

  const persistedMax = Number(job?.remediationPlan?.maxRounds);
  const priorMaxRounds = Number.isInteger(persistedMax) && persistedMax > 0
    ? persistedMax
    : (ROUND_BUDGET_BY_RISK_CLASS[String(job?.riskClass ?? '').trim().toLowerCase()]
       || ROUND_BUDGET_BY_RISK_CLASS[DEFAULT_RISK_CLASS]);

  const newMaxRounds = priorMaxRounds + bumpBy;

  const updated = {
    ...job,
    remediationPlan: {
      ...(job?.remediationPlan || {}),
      maxRounds: newMaxRounds,
    },
    operatorRetriggerAudit: [
      ...(Array.isArray(job?.operatorRetriggerAudit) ? job.operatorRetriggerAudit : []),
      {
        at: new Date().toISOString(),
        by: String(by),
        reason: String(reason).trim(),
        priorMaxRounds,
        newMaxRounds,
        bumpBy,
        operation: 'bump-remediation-budget',
      },
    ],
  };

  writeFollowUpJob(jobPath, updated);

  return {
    bumped: true,
    jobPath,
    jobKey,
    priorMaxRounds,
    newMaxRounds,
    bumpBy,
  };
}

export {
  findLatestJobForPR,
  bumpRemediationBudget,
};
