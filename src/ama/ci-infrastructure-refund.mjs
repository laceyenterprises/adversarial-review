import { creditHammerDispatchBudgets, updateHammerRetryCapLedger } from './hammer-retry-cap.mjs';

// Only named, provably charged launches are refunded. Per-charge budget credits
// survive series changes and cooperate with all other refund consumers.
export function refundCiInfrastructureHammerStops(rootDir, identity, stop, { now } = {}) {
  return updateHammerRetryCapLedger(rootDir, identity, ledger => {
    if (![ledger.attemptCount, ledger.targetAttemptCount, ledger.lifetimeAttemptCount]
      .every(value => Number.isSafeInteger(value) && value >= 0)) return false;
    let changed = false;
    for (const item of stop.refundStops || []) {
      if (!item.ciInfrastructureOnly || !item.launchRequestId) continue;
      const charge = Object.values(ledger.dispatchCharges || {}).find(charge =>
        charge.launchRequestId === item.launchRequestId && charge.headSha === stop.headSha
        && charge.jobKey === item.auditHead);
      if (!charge) continue;
      const credited = charge.refundedBudgets || {};
      const budgets = { pr: !credited.pr && ledger.jobKey === charge.jobKey,
        head: !credited.head && ledger.targetRemediationSha === charge.headSha
          && ledger.targetChargeEpoch === charge.targetEpoch,
        lifetime: !credited.lifetime };
      if (!Object.values(budgets).some(Boolean)) continue;
      if (budgets.pr) ledger.attemptCount = Math.max(0, ledger.attemptCount - 1);
      if (budgets.head) ledger.targetAttemptCount = Math.max(0, ledger.targetAttemptCount - 1);
      if (budgets.lifetime) ledger.lifetimeAttemptCount = Math.max(0, ledger.lifetimeAttemptCount - 1);
      creditHammerDispatchBudgets(ledger, item.launchRequestId, budgets);
      charge.ciInfrastructureRefund = { reason: 'checks-executed-again', stopKey: item.stopKey, refundedAt: now };
      changed = true;
    }
    if (!changed) return false;
    ledger.suppressed = false;
    ledger.targetSuppressed = false;
    ledger.lifetimeSuppressed = false;
    return ledger;
  });
}
