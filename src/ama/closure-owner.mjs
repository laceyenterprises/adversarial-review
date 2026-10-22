import { launchRequestParked, launchRequestMeaning, withLiveLaunchRetry } from './launch-request-status.mjs';
import { readAmaCloserDispatchRecord } from './dispatch-record-read.mjs';
import { readLaunchRequestStatusFromLedger } from '../session-ledger-read-adapter.mjs';
import { checkPrimaryChange } from './primary-change.mjs';
import { isDaemonMergeReviewAllowed } from './daemon-merge.mjs';
import { SETTLED_SUCCESS_VERDICTS } from './eligibility.mjs';
import { AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS,
  isReclaimablePendingAmaCloserLease, isReclaimableDispatchedAmaCloserLease } from './closer-lease.mjs';
import { ciBlockedHammerReasonsCovered } from './review-cycle-cap-route.mjs';

export const CLOSURE_OWNER_WAIT_MS = 30_000;

// One arbitration rule for an open PR without an operator hold. This chooses
// ownership, never merge authority: execution still runs the live exact-head
// eligibility predicate and lease CAS. Diagnostic labels confer no ownership.
export function decideClosureOwner({ reviewState = {}, currentHead, attested = false,
  closerAuthoredStale = null,
  lease = null, retryExhausted = false, lifetimeExhausted = false,
  mergeable = 'MERGEABLE', checks = 'SUCCESS', roundsLeft = true,
  waitExhausted = false, primaryChange = null, reviewCeilingReached = false,
  diffEmpty = false, followUpJob = null, strictMode = true, strictNonBlockingRemediation = true,
  ciBlockedHammerOwner = false, now = null, processKillImpl = process.kill,
  rootDir = null, launchStatusProbe, readLaunchRequestStatusImpl } = {}) {
  const action = (owner, reason, extra = {}) => ({ owner, reason, ...extra });
  if (diffEmpty) return action('close', 'empty-diff');
  if (primaryChange) {
    const primary = checkPrimaryChange(primaryChange, currentHead, { strictNonBlockingRemediation });
    if (!primary.ok) {
      if (['primary-change-reverted', 'primary-change-unknown'].includes(primary.reason)) return action('page', 'primary-change-needs-operator');
      return waitExhausted ? action('page', primary.reason) : action('wait', primary.reason, { boundedMs: CLOSURE_OWNER_WAIT_MS, retryAfterMs: CLOSURE_OWNER_WAIT_MS });
    }
  }
  // Terminal deferred leases no longer reserve capacity. Their parked receipt
  // still fences every closure path, including the rare inline daemon merge.
  if (rootDir && lease?.lrqId && lease.status === 'terminal' && lease.terminalOutcome === 'deferred') {
    const record = readAmaCloserDispatchRecord(rootDir, { ...lease,
      headSha: lease.rekeyedFromHeadSha || lease.headSha });
    if (record?.launchRequestId === lease.lrqId && launchRequestMeaning(record.lastObservedStatus).parked) {
      if (launchStatusProbe === undefined) {
        try { launchStatusProbe = (readLaunchRequestStatusImpl || readLaunchRequestStatusFromLedger)({
          rootDir, launchRequestId: lease.lrqId, includeRetryChain: true }); }
        catch { launchStatusProbe = null; }
      }
      if (!launchStatusProbe?.ok || launchStatusProbe.retryChainUnreadable
        || !launchRequestMeaning(withLiveLaunchRetry(launchStatusProbe).row).status) {
        launchStatusProbe = { ok: true, row: { status: record.lastObservedStatus } };
      }
    }
  }
  if (lease?.lrqId && launchRequestParked(launchStatusProbe)) {
    return action('wait', `dispatch-status-${withLiveLaunchRetry(launchStatusProbe).row.status.replaceAll('_', '-')}`,
      { retryAfterMs: CLOSURE_OWNER_WAIT_MS });
  }
  // Reclaimability is shared with dispatch; only acquisition mutates the lease.
  if (isReclaimablePendingAmaCloserLease(lease, { now, processKillImpl })
    || isReclaimableDispatchedAmaCloserLease(lease, { now, rootDir, launchStatusProbe, readLaunchRequestStatusImpl })) lease = null;
  if (lease && ['pending', 'dispatched'].includes(lease.status)) {
    return waitExhausted
      ? action('page', 'in-flight-lease-expired')
      : action('wait', `in-flight:${lease.lrqId || lease.watcherPid || 'closer-lease'}`,
        { boundedMs: AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS, retryAfterMs: CLOSURE_OWNER_WAIT_MS });
  }
  // HAMATTEST-02: project the shared verdict-carry decision into ownership
  // (also consumed by rescue), without independently trusting a closer tip.
  if (closerAuthoredStale && currentHead && closerAuthoredStale.currentHead === currentHead
    && closerAuthoredStale.reviewedHead === reviewState.headSha) {
    if (closerAuthoredStale.decision === 'rereview-exact-head') return action('review', 'exact-head-review');
    if (closerAuthoredStale.carryForward === true) attested = true;
  }
  const capped = retryExhausted || lifetimeExhausted;
  const hammer = reason => capped
    ? action('page', lifetimeExhausted ? 'hammer-lifetime-cap' : 'hammer-retry-cap')
    : action('hammer', reason);
  if (!roundsLeft && ciBlockedHammerReasonsCovered(['ci-not-green'], {
    ciBlockedHammerOwner, checksConclusion: checks, remediationPending: reviewState.remediationPending,
  }) && lease?.status !== 'handed-to-review'
    && reviewState.headSha && currentHead
    && reviewState.headSha !== currentHead) {
    return hammer('ci-blocked-remediation-exhausted');
  }
  if (!reviewState.verdict || (reviewState.headSha !== currentHead && (!attested || lease?.status === 'handed-to-review'))) {
    if (reviewCeilingReached && lease?.status !== 'handed-to-review') return hammer('review-ceiling-stale-head');
    return (roundsLeft || (reviewCeilingReached && lease?.status === 'handed-to-review')) ? action('review', 'exact-head-review') : action('page', 'review-rounds-exhausted');
  }
  const clean = SETTLED_SUCCESS_VERDICTS.has(reviewState.verdict)
    && isDaemonMergeReviewAllowed(reviewState, { strictMode });
  if (!clean) {
    if (lease?.status === 'handed-to-review' || !roundsLeft || attested) return hammer('review-findings');
    return action('remediation', 'review-findings');
  }
  if (followUpJob?.status === 'pending' && followUpJob?.clean === true) {
    return action('follow-up-drain', 'clean-review-drain');
  }
  if (mergeable === 'CONFLICTING') {
    const result = hammer('conflict-rebase');
    return result.owner === 'hammer' ? { ...result, owner: 'conflict-rebase' } : result;
  }
  if (checks === 'FAILURE') return hammer('required-checks-red');
  if (mergeable === 'UNKNOWN' || checks !== 'SUCCESS') {
    return waitExhausted ? action('page', 'pending-gate-budget-exhausted')
      : action('wait', mergeable === 'UNKNOWN' ? 'pending-mergeability' : 'pending-required-checks',
        { boundedMs: AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS, retryAfterMs: CLOSURE_OWNER_WAIT_MS });
  }
  return action('daemon-merge', 'clean-exact-head');
}
