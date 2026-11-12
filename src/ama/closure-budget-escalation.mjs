import { observeClosureWait } from './closure-wait.mjs';
import { readHammerRetryCapLedger, refundCloserSelfError } from './hammer-retry-cap.mjs';
import { CLOSER_INCONCLUSIVE_RETRY_OWNER, closerInconclusiveLaunchIds,
  readCloserInconclusiveRetries } from './closer-inconclusive-retry.mjs';

export const CLOSURE_BUDGET_NEXT_ACTION = 'inspect the latest closer audit for this head, then push a fix '
  + 'for the refused condition (a reviewed new head re-arms the budget) or grant an operator re-drive';

// INCONCLUSIVERETRY-01b: a budget spent only by launches the owner recorded as
// inconclusive was never spent. Refund those charges in full so the ordinary
// closer path, with every merge check, resumes. Any real charge keeps it spent.
export function refundInconclusiveExhaustion({ rootDir, repo, prNumber, now = Date.now(), readLedgerImpl = readHammerRetryCapLedger,
  refundImpl = refundCloserSelfError, readRetriesImpl = readCloserInconclusiveRetries } = {}) {
  const identity = { repo, prNumber };
  const ledger = readLedgerImpl(rootDir, identity);
  if (!ledger || ledger.__corrupt) return { recovered: false, reason: 'ledger-unavailable' };
  const charges = Object.values(ledger.dispatchCharges || {}).filter(charge => charge?.jobKey === ledger.jobKey
    && !Object.values(charge.refundedBudgets || {}).some(Boolean));
  const inconclusive = closerInconclusiveLaunchIds(readRetriesImpl(rootDir, identity));
  const real = charges.filter(charge => !inconclusive.has(charge.launchRequestId));
  if (!charges.length || real.length) {
    return { recovered: false, reason: charges.length ? 'real-attempts-spent-budget' : 'no-open-charge',
      realAttempts: real.length };
  }
  const refunds = charges.map(charge => {
    try {
      return refundImpl(rootDir, identity, { jobKey: charge.jobKey, headSha: charge.headSha,
        launchRequestId: charge.launchRequestId, now: new Date(now).toISOString() });
    } catch (error) { return { refunded: false, reason: error?.code || 'refund-failed' }; }
  });
  const refunded = refunds.filter(refund => refund.refunded).length;
  return { recovered: refunded === charges.length, reason: refunded === charges.length
    ? 'inconclusive-only' : 'refund-incomplete', refunded, charges: charges.length };
}

// A spent budget has no automatic executor. Give it a named escalation owner;
// the wait store reserves one page atomically and refunds failed delivery.
export async function escalateClosureBudget({ result, rootDir, repo, prNumber,
  now = Date.now(), env = process.env, observeWaitImpl = observeClosureWait,
  refundInconclusiveImpl = refundInconclusiveExhaustion }) {
  // CAPREHEAD has an automatic executor for this pass, including known live
  // closer/builder custody. Refusals and unknown custody retain the normal page.
  if (result?.capRehead?.dispatched || result?.capRehead?.custody === true) return result;
  const decision = result?.nextAction;
  if (decision?.row !== 'R07-stop'
    || !['retry-exhausted', 'lifetime-exhausted'].includes(decision.reason)) return result;
  const reason = `closure-${decision.reason}`;
  const owned = { owner: CLOSER_INCONCLUSIVE_RETRY_OWNER, reason, recommendedAction: CLOSURE_BUDGET_NEXT_ACTION };
  let inconclusive;
  try { inconclusive = refundInconclusiveImpl({ rootDir, repo, prNumber, now }); }
  catch (error) { inconclusive = { recovered: false, reason: `refund-check-failed:${error?.message || error}` }; }
  // Inconclusive-only exhaustion is not exhaustion: the owner retries next pass.
  if (inconclusive.recovered || inconclusive.reason === 'refund-incomplete') {
    return { ...result, needsOperator: false, recoveryWait: true,
      ownedRetry: { ...owned, reason: 'closure-budget-inconclusive-only', deadline: new Date(now).toISOString() },
      inconclusiveExhaustion: inconclusive };
  }
  const escalation = await observeWaitImpl({ rootDir, repo, prNumber,
    headSha: decision.head, waitClass: reason, immediate: true, now, env,
    reason: `${reason}; real closer attempts spent the budget; owner ${owned.owner}; `
      + `recommended next action: ${owned.recommendedAction}` });
  return { ...result, needsOperator: true, operatorReason: reason, boundedWait: escalation,
    ownedRetry: { ...owned, deadline: decision.deadline || null }, inconclusiveExhaustion: inconclusive };
}
