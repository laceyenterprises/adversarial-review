import { checkPrimaryChange } from './primary-change.mjs';
import { isDaemonMergeReviewAllowed } from './daemon-merge.mjs';
import { SETTLED_SUCCESS_VERDICTS } from './eligibility.mjs';
import { AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS } from './closer-lease.mjs';
import { ciBlockedHammerReasonsCovered } from './review-cycle-cap-route.mjs';

export const CLOSURE_OWNER_WAIT_MS = 30_000;

// One arbitration rule for an open PR without an operator hold. This chooses
// ownership, never merge authority: execution still runs the live exact-head
// eligibility predicate and lease CAS. Diagnostic labels confer no ownership.
export function decideClosureOwner({ reviewState = {}, currentHead, attested = false,
  lease = null, retryExhausted = false, lifetimeExhausted = false,
  mergeable = 'MERGEABLE', checks = 'SUCCESS', roundsLeft = true,
  waitExhausted = false, primaryChange = null, reviewCeilingReached = false,
  diffEmpty = false, followUpJob = null, strictMode = true, strictNonBlockingRemediation = true,
  ciBlockedHammerOwner = false } = {}) {
  const action = (owner, reason, extra = {}) => ({ owner, reason, ...extra });
  if (diffEmpty) return action('close', 'empty-diff');
  if (primaryChange) {
    const primary = checkPrimaryChange(primaryChange, currentHead, { strictNonBlockingRemediation });
    if (!primary.ok) {
      if (['primary-change-reverted', 'primary-change-unknown'].includes(primary.reason)) return action('page', 'primary-change-needs-operator');
      return waitExhausted ? action('page', primary.reason) : action('wait', primary.reason, { boundedMs: CLOSURE_OWNER_WAIT_MS, retryAfterMs: CLOSURE_OWNER_WAIT_MS });
    }
  }
  if (lease && ['pending', 'dispatched'].includes(lease.status)) {
    return waitExhausted
      ? action('page', 'in-flight-lease-expired')
      : action('wait', `in-flight:${lease.lrqId || lease.watcherPid || 'closer-lease'}`,
        { boundedMs: AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS, retryAfterMs: CLOSURE_OWNER_WAIT_MS });
  }
  const capped = retryExhausted || lifetimeExhausted;
  const hammer = reason => capped
    ? action('page', lifetimeExhausted ? 'hammer-lifetime-cap' : 'hammer-retry-cap')
    : action('hammer', reason);
  if (!roundsLeft && ciBlockedHammerReasonsCovered(['ci-not-green'], {
    ciBlockedHammerOwner, checksConclusion: checks, remediationPending: reviewState.remediationPending,
  }) && lease?.status !== 'handed-to-review'
    && reviewState.headSha && currentHead
    && (reviewState.headSha !== currentHead || !reviewState.verdict)) {
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
