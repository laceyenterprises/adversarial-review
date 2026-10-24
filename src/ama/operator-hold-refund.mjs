// Refund only an explicitly hold-only terminal decision on the last charged
// target with explicit no-execution evidence. A hold-only terminal reason
// after genuine remediation must not grant another code-work attempt.
import { OPERATOR_HOLD_LABELS } from '../operator-hold-labels.mjs';
import { creditHammerDispatchBudgets, updateHammerRetryCapLedger } from './hammer-retry-cap.mjs';

const HOLD_ONLY_REASONS = new Set(['operator-skip-label', 'skip-operator-skip',
  ...OPERATOR_HOLD_LABELS.map(label => `label-${label}`)]);

export function refundOperatorHeldHammerStop(rootDir, identity, stop, { now = new Date().toISOString() } = {}) {
  return updateHammerRetryCapLedger(rootDir, identity, ledger => {
    const dispatchedAt = Date.parse(ledger?.updatedAt);
    const stoppedAt = Date.parse(stop?.recordedAt);
    if (!ledger || ledger.__corrupt || ledger.lastDispatchedHeadSha !== stop?.headSha
      || !Number.isFinite(dispatchedAt) || !Number.isFinite(stoppedAt) || dispatchedAt > stoppedAt
      || ![ledger.attemptCount, ledger.lifetimeAttemptCount, ledger.targetAttemptCount]
        .every(value => Number.isInteger(value) && value >= 0) || !ledger.attemptCount) return false;
    const keys = ledger.operatorHoldRefundStopKeys || [];
    const candidates = stop.refundStops || [{ ...stop, auditHead: ledger.jobKey }];
    const refundedLaunches = [...(ledger.unexecutedLaunchRequestIds || []),
      ...(ledger.retryableLaunchRequestIds || []), ...(ledger.deferralLaunches || [])];
    const refundable = [...new Map(candidates.filter(item => item.noExecution === true && item.launchRequestId
      && !refundedLaunches.includes(item.launchRequestId) && item.auditHead === ledger.jobKey
      && HOLD_ONLY_REASONS.has(item.predicate) && Number.isFinite(Date.parse(item.recordedAt))
      && !keys.includes(item.stopKey)).map(item => [item.launchRequestId, item])).values()];
    const refundKeys = [...new Set(refundable.map(item => item.stopKey))].slice(0, ledger.attemptCount);
    if (refundKeys.length === 0) return false;
    const down = value => Math.max(0, value - refundKeys.length);
    for (const item of refundable.filter(item => refundKeys.includes(item.stopKey))) {
      creditHammerDispatchBudgets(ledger, item.launchRequestId, { pr: true, lifetime: true,
        head: ledger.targetRemediationSha === stop.headSha });
    }
    return {
      ...ledger,
      attemptCount: down(ledger.attemptCount),
      lifetimeAttemptCount: down(ledger.lifetimeAttemptCount),
      targetAttemptCount: ledger.targetRemediationSha === stop.headSha ? down(ledger.targetAttemptCount) : ledger.targetAttemptCount,
      // The classifier re-evaluates remaining charges; no new retry is granted.
      suppressed: false, lifetimeSuppressed: false, targetSuppressed: false,
      operatorHoldRefundStopKeys: [...keys, ...refundKeys],
      // Share no-execution identities with ordinary refund consumers. PR 1268
      // also checks these in the bounded exit-refund path.
      unexecutedLaunchRequestIds: [...(ledger.unexecutedLaunchRequestIds || []),
        ...refundable.filter(item => refundKeys.includes(item.stopKey)).map(item => item.launchRequestId)],
      operatorHoldRefundedAt: now,
    };
  });
}
