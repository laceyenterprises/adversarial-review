import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { readAmaCloserLease } from './ama/closer-lease.mjs';
import { readAmaCloserDispatchRecord, readAmaCloserDispatchRecordsForPR } from './ama/dispatch-record-read.mjs';
import { operatorNoticeInFlight, operatorNoticeNonRetryableStop,
  operatorNoticePendingRetry, operatorNoticeRetryCapReached } from './ama/operator-notice-route.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { listFollowUpJobsInDir } from './follow-up-jobs.mjs';
import { hasOperatorDecisionRequiredAlerted, markOperatorDecisionRequiredAlerted } from './reviewer-cascade.mjs';

export const OPERATOR_DECISION_NOTICE_BACKSTOP_MS = 45 * 60 * 1000;

function statePath(rootDir, { repo, prNumber }) {
  const key = createHash('sha256').update(`${repo}#${prNumber}`).digest('hex');
  return join(rootDir, 'data', 'operator-decision-notices', `${key}.json`);
}
function readState(rootDir, identity) {
  try { return JSON.parse(readFileSync(statePath(rootDir, identity), 'utf8')); }
  catch { return {}; }
}
function writeState(rootDir, identity, state) {
  writeFileAtomic(statePath(rootDir, identity), JSON.stringify(state));
}

function latestDispatchReviewedSha(rootDir, identity) {
  const attemptedAt = record => Date.parse(record.lastAttemptedAt || record.dispatchedAt) || 0;
  return readAmaCloserDispatchRecordsForPR(rootDir, identity)
    .filter(record => record.reviewedSha)
    .sort((a, b) => attemptedAt(b) - attemptedAt(a))[0]?.reviewedSha;
}

function liveRemediationJob(rootDir, identity) {
  return ['pending', 'inProgress'].some(bucket => listFollowUpJobsInDir(rootDir, bucket, identity)
    .some(({ job }) => job?.repo === identity.repo && Number(job.prNumber) === Number(identity.prNumber)
      && ['pending', 'in-progress', 'in_progress'].includes(job.status)));
}

function remediatorOwns(outcome, headSha) {
  return outcome?.nextAction?.head === headSha ? outcome.nextAction.actor === 'remediator'
    : outcome?.reason === 'remediation-job-missing';
}

function remediationStop(rootDir, identity) {
  const jobs = listFollowUpJobsInDir(rootDir, 'stopped', identity)
    .map(({ job }) => job)
    .filter(job => job?.repo === identity.repo && Number(job.prNumber) === Number(identity.prNumber)
      && [job.headSha, job.revisionRef, job.reviewedHeadSha].includes(identity.headSha))
    .sort((a, b) => (Date.parse(b.stoppedAt || b.updatedAt || b.createdAt) || 0)
      - (Date.parse(a.stoppedAt || a.updatedAt || a.createdAt) || 0));
  return jobs[0]?.remediationPlan?.stop;
}

// Observation only: never alters closer eligibility, ownership, or dispatch.
export function recordOperatorNoticeCloserOutcome(rootDir, identity, result) {
  if (!identity.repo || !identity.prNumber || !identity.headSha) return;
  const state = readState(rootDir, identity);
  writeState(rootDir, identity, { ...state, closer: { headSha: identity.headSha, result } });
}

export async function maybeDeliverOperatorDecisionNotice({ rootDir, repo, prNumber, headSha,
  decision, reviewRow, terminal = false, handoffAwaitingReview = false,
  now = Date.now(), deliverAlertFn, readLivePR, logger = console,
  readLaunchRequestStatusImpl, timeoutOptions = {} }) {
  const identity = { repo, prNumber, headSha };
  // Keep observation cleanup on non-alerting polls without blocking the watcher
  // on synchronous file reads (including the usual missing-state lookup).
  if (terminal || !decision?.operatorDecisionRequired) {
    let observed;
    try { observed = JSON.parse(await readFile(statePath(rootDir, identity), 'utf8')); }
    catch { return; }
    if (observed.observation) {
      // A closer outcome may have arrived during the async read. Preserve that
      // latest state when clearing the observation, without yielding again.
      const state = readState(rootDir, identity);
      if (state.observation) writeState(rootDir, identity, { ...state, observation: null });
    }
    return;
  }
  let state = readState(rootDir, identity);
  if (hasOperatorDecisionRequiredAlerted(rootDir, identity)) return;
  const inFlight = await operatorNoticeInFlight(rootDir, identity, { readLaunchRequestStatusImpl, now });
  // A dispatch outcome may have settled while the launch read yielded.
  state = readState(rootDir, identity);
  const observationChanged = state.observation?.headSha !== headSha;
  if (observationChanged) {
    state = { ...state, observation: { headSha, startedAt: now } };
  }
  const record = readAmaCloserDispatchRecord(rootDir, identity);
  const lease = readAmaCloserLease(rootDir, identity);
  const outcome = state.closer?.headSha === headSha ? state.closer.result : null;
  const retryCap = operatorNoticeRetryCapReached(rootDir, identity, outcome,
    reviewRow?.reviewer_head_sha || record?.reviewedSha || latestDispatchReviewedSha(rootDir, identity));
  const operatorNeeded = outcome?.needsOperator || outcome?.closureOwner?.owner === 'page'
    || retryCap;
  const nonRetryable = operatorNoticeNonRetryableStop(record);
  const backstopMs = loadAwareTimeoutMs(OPERATOR_DECISION_NOTICE_BACKSTOP_MS,
    { maxMs: Infinity, ...timeoutOptions });
  const pendingRetry = !operatorNeeded && operatorNoticePendingRetry(outcome, record);
  const activeJob = liveRemediationJob(rootDir, identity);
  const remediationOwned = remediatorOwns(outcome, headSha);
  const remediationMissing = remediationOwned && !activeJob;
  const active = activeJob ? 'remediation-active' : remediationOwned ? null : inFlight || (
    handoffAwaitingReview || (lease?.status === 'handed-to-review'
      && ['pending', 'pending-upstream', 'reviewing'].includes(reviewRow?.review_status)) ? 'handoff-review-active'
    : pendingRetry ? 'closer-route-available'
    : null);
  // Only an idle route accrues backstop age. Keep legacy observations readable.
  const idleSince = active ? null : state.observation.idleSince === null
    ? now : state.observation.idleSince ?? state.observation.startedAt;
  const idleChanged = state.observation.idleSince !== idleSince
    && (active || Object.hasOwn(state.observation, 'idleSince'));
  if (idleChanged) state.observation = { ...state.observation, idleSince };
  const backstopDue = !active && now - idleSince >= backstopMs;
  const routeAvailable = outcome && !operatorNeeded && !remediationOwned
    && ['hammer', 'conflict-rebase'].includes(outcome.closureOwner?.owner);
  const held = active || (!remediationOwned && !backstopDue && (routeAvailable || (record?.outcome && !nonRetryable))
    && !operatorNeeded ? 'closer-route-available' : null);
  const reason = held ? null : retryCap ? 'retry-cap' : operatorNeeded || remediationMissing ? 'no-route'
    : nonRetryable && !routeAvailable ? `non-retryable: ${nonRetryable}`
    : backstopDue ? 'backstop' : null;
  if (!reason) {
    const firstHold = !state.heldHeads?.[headSha];
    if (firstHold) {
      state.heldHeads = { ...state.heldHeads, [headSha]: true };
    }
    if (observationChanged || idleChanged || firstHold) writeState(rootDir, identity, state);
    if (firstHold) {
      logger.log(`[watcher] operator-decision notice held for ${repo}#${prNumber}@${headSha}: ${held || 'awaiting-route-outcome'}`);
    }
    return;
  }
  // Persist the observation before yielding to live PR lookup or delivery.
  if (observationChanged || idleChanged) writeState(rootDir, identity, state);
  if (readLivePR) {
    const live = await readLivePR();
    if (String(live?.state).toUpperCase() !== 'OPEN' || live?.headRefOid !== headSha) return;
    // Live lookup yields: a replacement launch admitted meanwhile holds delivery.
    const latestInFlight = await operatorNoticeInFlight(rootDir, identity, { readLaunchRequestStatusImpl, now });
    const latest = readState(rootDir, identity);
    const latestOutcome = latest.closer?.headSha === headSha ? latest.closer.result : null;
    const latestRemediationOwned = remediatorOwns(latestOutcome, headSha);
    const restoredRoute = latestOutcome && !latestOutcome.needsOperator && !latestRemediationOwned
      && ['hammer', 'conflict-rebase'].includes(latestOutcome.closureOwner?.owner)
      && JSON.stringify(latest.closer) !== JSON.stringify(state.closer);
    if (liveRemediationJob(rootDir, identity) || (!latestRemediationOwned && latestInFlight) || restoredRoute
      || operatorNoticePendingRetry(latestOutcome, readAmaCloserDispatchRecord(rootDir, identity))) {
      if (latest.observation?.headSha === headSha) {
        writeState(rootDir, identity, { ...latest, observation: { ...latest.observation, idleSince: null } });
      }
      return;
    }
  }
  if (hasOperatorDecisionRequiredAlerted(rootDir, identity)) return;
  const stop = remediationMissing ? remediationStop(rootDir, identity) : null;
  const remediationDetail = remediationMissing
    ? ` Remediation stop: ${stop?.code || 'remediation-job-missing'}. Decision needed: ` +
      `${stop?.reason || decision.description || 'Inspect the unresolved review findings and decide how remediation may resume.'}`
    : '';
  await deliverAlertFn(
    `Adversarial review needs an operator decision for ` +
    `${repo}#${prNumber}: ${decision.state || 'unknown state'} ` +
    `(${decision.reason || 'no reason provided'}). Reason: ${reason}. Findings are unresolved and ` +
    `no closer route is currently making progress. Inspect the closure outcome ` +
    `and restore a closer route or resolve the blockers.${remediationDetail}`,
    { event: 'adversarial_review.operator_decision_required', payload: {
      repo, pr_number: prNumber, head_sha: headSha || null,
      gate_state: decision.state || null, gate_reason: decision.reason || null, reason,
      ...(remediationMissing ? { remediation_stop_code: stop?.code || 'remediation-job-missing',
        remediation_stop_reason: stop?.reason || decision.description || null } : {}),
      ...((record?.stopReason || record?.lastError)
        ? { hammer_stop_reason: record.stopReason || record.lastError } : {}),
    } },
  );
  markOperatorDecisionRequiredAlerted(rootDir, { ...identity, reason: decision.reason || null });
}
