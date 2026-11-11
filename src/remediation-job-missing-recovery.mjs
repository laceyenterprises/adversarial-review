// STRICTSETTLED-01: bounded self-heal for an ownerless remediation lane.
//
// The closer's next-action selects `remediate` (actor remediator) when the
// current-head review still owes findings under merge authority's strict-mode
// predicate. If the PR's remediation job was released as settled before that
// predicate was shared, nothing recreated it: the closer reported
// `remediation-job-missing` on every tick, the hammer wake was skipped because
// the action belonged to the remediator, and the PR stayed without an owner.
//
// This module requeues a settled release once per head, or an ended execution
// once per head/spent round, under the existing budget. Every refusal names its
// reason so the caller can log it; nothing here loops or spawns.
import { join } from 'node:path';

import * as followUpJobs from './follow-up-jobs.mjs';
import { withFollowUpJobLock } from './follow-up-job-write.mjs';
import { findLatestFollowUpJob } from './operator-retrigger-helpers.mjs';
import { isEndedRemediationRound } from './remediation-round-recovery.mjs';
import { recoveryDigest } from './comment-only-recovery-record.mjs';
import { findLiveAmaCloserLease } from './ama/closer-lease.mjs';

export const REMEDIATION_JOB_MISSING_REQUESTED_BY = 'ama-closer:remediation-job-missing';

// Stops that mean "released because the review looked settled". Other stops
// (operator stop, round cap, stale head) keep their own owners.
export const RELEASED_AS_SETTLED_STOP_CODES = Object.freeze([
  'settled-clean',
  'settled-clean-head-moved',
  'no-remediation-required',
  'review-settled',
]);
const RELEASED_AS_SETTLED = new Set(RELEASED_AS_SETTLED_STOP_CODES);

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function skipped(reason, job = null) {
  return { recreated: false, reason, jobId: job?.jobId || null };
}

/**
 * Requeue a settled release once per head, or an ended execution once per
 * head/spent round, without increasing the ordinary round allowance.
 *
 * @param {object} args
 * @param {string} args.rootDir      adversarial-review root holding data/follow-up-jobs
 * @param {string} args.repo
 * @param {number} args.prNumber
 * @param {string} args.headSha      current PR head the closer decided on
 * @param {boolean} [args.strictMode=true] effective merge-authority strict mode
 * @param {string} [args.now]
 * @returns {{recreated: boolean, reason: string, jobId: string|null, jobPath?: string,
 *            previousStopCode?: string}}
 */
export function recreateMissingRemediationJob({
  rootDir,
  repo,
  prNumber,
  headSha,
  strictMode = true,
  now = new Date().toISOString(),
  requeueImpl = followUpJobs.requeueFollowUpJobForNextRound,
  publicationRecovery = null,
  expectedDigest = null,
} = {}) {
  const head = text(headSha);
  if (!rootDir || !text(repo) || !Number.isInteger(Number(prNumber)) || !head) {
    return skipped('recovery-input-incomplete');
  }
  return withFollowUpJobLock(join(rootDir, 'data', 'follow-up-jobs'), () => {
    if (findLiveAmaCloserLease(rootDir, { repo, prNumber })) return skipped('closer-owned');
    const latest = findLatestFollowUpJob(rootDir, { repo, prNumber });
    const job = latest?.job;
    // A newer terminal record must never hide another queued/running owner.
    if (['pending', 'inProgress'].some(key => followUpJobs.listFollowUpJobsInDir(rootDir, key,
      { repo, prNumber, caseInsensitiveRepo: true }).some(({ job: active }) =>
      String(active.repo).toLowerCase() === String(repo).toLowerCase()
      && Number(active.prNumber) === Number(prNumber)))) {
      return skipped(`latest-job-${['pending', 'in_progress'].includes(job?.status) ? job.status : 'active-owner'}`, job);
    }
    if (!job) {
      // The reviewer/reaper owns initial creation: it has the persisted
      // single-review decision and PR-wide budget inputs. An exact-head body
      // alone cannot safely recreate that budget.
      return skipped('no-prior-job');
    }
    if (expectedDigest && recoveryDigest(job) !== expectedDigest) return skipped('job-evidence-changed', job);
    const endedRound = isEndedRemediationRound(job);
    if (job.status !== 'stopped' && !endedRound) return skipped(`latest-job-${text(job.status) || 'unknown'}`, job);
    if (endedRound && job.revisionRef !== head && publicationRecovery?.headSha !== head) {
      return skipped('review-head-moved', job);
    }
    // The once-per-head bound. A requeue keeps this marker, so a job released
    // again on the same head is never recreated a second time.
    if (text(job.remediationJobMissingRecovery?.headSha) === head
      && (!endedRound || job.remediationJobMissingRecovery?.round === job.remediationPlan.currentRound)) {
      return skipped('already-recreated-for-head', job);
    }
    const previousStopCode = text(job.remediationPlan?.stop?.code);
    if (!endedRound && !RELEASED_AS_SETTLED.has(previousStopCode)) {
      return skipped(`stop-code-${previousStopCode || 'unknown'}`, job);
    }
    if (!text(job.reviewBody)) return skipped('review-body-missing', job);
    const classification = followUpJobs.classifyFollowUpCriticality(job.reviewBody);
    if (followUpJobs.isSettledCleanClassification(classification, { strictMode })) {
      return skipped('review-settled-clean', job);
    }
    const currentRound = Number(job.remediationPlan?.currentRound || 0);
    const maxRounds = Number(job.remediationPlan?.maxRounds || 0);
    if (Number.isFinite(maxRounds) && maxRounds > 0 && currentRound >= maxRounds) {
      return skipped('round-budget-exhausted', job);
    }

    let requeued;
    try {
      requeued = requeueImpl({
        rootDir,
        jobPath: latest.jobPath,
        requestedAt: now,
        requestedBy: REMEDIATION_JOB_MISSING_REQUESTED_BY,
        reason: `Closer reported remediation-job-missing on head ${head}; `
          + `the review still owes remediation (stop was ${previousStopCode}).`,
        revisionRef: head,
        ...(endedRound ? { automaticRoundRecovery: { sourceDigest: recoveryDigest(job) } } : {}),
        publicationRecovery,
      });
    } catch (error) {
      return { ...skipped('requeue-refused', job), error: error?.message || String(error) };
    }
    if (requeued?.job?.status !== 'pending') {
      return skipped(`requeue-refused-${text(requeued?.job?.remediationPlan?.stop?.code) || 'unknown'}`, job);
    }
    const marked = {
      ...requeued.job,
      remediationJobMissingRecovery: { headSha: head, recreatedAt: now, previousStopCode,
        ...(endedRound ? { round: currentRound } : {}) },
    };
    followUpJobs.writeFollowUpJob(requeued.jobPath, marked);
    return { recreated: true, reason: 'recreated', jobId: marked.jobId || null,
      jobPath: requeued.jobPath, previousStopCode };
  });
}
