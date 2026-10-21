import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { findLiveAmaCloserLease, readAmaCloserLease } from './ama/closer-lease.mjs';
import { readAmaCloserDispatchRecord, isActiveAmaCloserDispatchRecord } from './ama/dispatch-closer.mjs';
import { isHammerWorkerClass } from './ama/hammer-worker-class.mjs';
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

// Observation only: never alters closer eligibility, ownership, or dispatch.
export function recordOperatorNoticeCloserOutcome(rootDir, identity, result) {
  if (!identity.repo || !identity.prNumber || !identity.headSha) return;
  const state = readState(rootDir, identity);
  writeState(rootDir, identity, { ...state, closer: { headSha: identity.headSha, result } });
}

export async function maybeDeliverOperatorDecisionNotice({ rootDir, repo, prNumber, headSha,
  decision, reviewRow, terminal = false, handoffAwaitingReview = false,
  now = Date.now(), deliverAlertFn, readLivePR, logger = console }) {
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
  const observationChanged = state.observation?.headSha !== headSha;
  if (observationChanged) {
    state = { ...state, observation: { headSha, startedAt: now } };
  }
  const record = readAmaCloserDispatchRecord(rootDir, identity);
  const lease = readAmaCloserLease(rootDir, identity);
  const outcome = state.closer?.headSha === headSha ? state.closer.result : null;
  const operatorNeeded = outcome?.needsOperator || outcome?.closureOwner?.owner === 'page'
    || ['dispatch-retry-exhausted', 'hammer-retry-cap'].includes(outcome?.reason);
  const ended = Boolean(record?.launchRequestId) && isHammerWorkerClass(record?.workerClass)
    && ['failed', 'failed-without-merge', 'cancelled', 'canceled', 'stopped', 'aborted', 'succeeded', 'completed', 'terminal', 'unverified-terminal-success', 'operator_triage_required', 'reaped_stuck_requested'].includes(record?.lastObservedStatus)
    && !['merged', 'succeeded'].includes(record?.outcome);
  const activeJob = [...listFollowUpJobsInDir(rootDir, 'pending', identity), ...listFollowUpJobsInDir(rootDir, 'inProgress', identity)]
    .some(({ job }) => job?.repo === repo && Number(job.prNumber) === Number(prNumber));
  const held = findLiveAmaCloserLease(rootDir, identity) ? 'live-closer-lease'
    : isActiveAmaCloserDispatchRecord(record, { lease, now: new Date(now).toISOString() }) ? 'closer-in-flight'
    : activeJob ? 'remediation-active'
    : handoffAwaitingReview || (lease?.status === 'handed-to-review'
      && ['pending', 'pending-upstream', 'reviewing'].includes(reviewRow?.review_status)) ? 'handoff-review-active'
    : outcome && !operatorNeeded && ((!ended && outcome.dispatched) || outcome.inFlight
      || outcome.recoveryWait || outcome.retryAfterMs || outcome.backgroundDispatch
      || (['hammer', 'conflict-rebase'].includes(outcome.closureOwner?.owner)
        && now - state.observation.startedAt < OPERATOR_DECISION_NOTICE_BACKSTOP_MS)) ? 'closer-route-available'
    : null;
  const reason = held ? null : operatorNeeded ? 'no-route'
    : ['hammer', 'conflict-rebase'].includes(outcome?.closureOwner?.owner)
      && now - state.observation.startedAt >= OPERATOR_DECISION_NOTICE_BACKSTOP_MS ? 'backstop-45m'
    : ended ? 'hammer-ended-without-merge'
    : now - state.observation.startedAt >= OPERATOR_DECISION_NOTICE_BACKSTOP_MS ? 'backstop-45m' : null;
  if (!reason) {
    const firstHold = !state.heldHeads?.[headSha];
    if (firstHold) {
      state.heldHeads = { ...state.heldHeads, [headSha]: true };
    }
    if (observationChanged || firstHold) writeState(rootDir, identity, state);
    if (firstHold) {
      logger.log(`[watcher] operator-decision notice held for ${repo}#${prNumber}@${headSha}: ${held || 'awaiting-route-outcome'}`);
    }
    return;
  }
  // Persist the observation before yielding to live PR lookup or delivery.
  if (observationChanged) writeState(rootDir, identity, state);
  if (readLivePR) {
    const live = await readLivePR();
    if (String(live?.state).toUpperCase() !== 'OPEN' || live?.headRefOid !== headSha) return;
  }
  await deliverAlertFn(
    `Adversarial review needs an operator decision for ` +
    `${repo}#${prNumber}: ${decision.state || 'unknown state'} ` +
    `(${decision.reason || 'no reason provided'}). Findings are unresolved and ` +
    `remediation will not run again on this head. The PR will not merge ` +
    `until someone remediates or explicitly approves.`,
    { event: 'adversarial_review.operator_decision_required', payload: {
      repo, pr_number: prNumber, head_sha: headSha || null,
      gate_state: decision.state || null, gate_reason: decision.reason || null, reason,
      ...((record?.stopReason || record?.lastError)
        ? { hammer_stop_reason: record.stopReason || record.lastError } : {}),
    } },
  );
  markOperatorDecisionRequiredAlerted(rootDir, { ...identity, reason: decision.reason || null });
}
