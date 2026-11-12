import { observeClosureWait } from './closure-wait.mjs';
import { readHammerRetryCapLedger, refundCloserSelfError } from './hammer-retry-cap.mjs';
import { readAmaAuditEntry } from './audit.mjs';
import { CLOSER_INCONCLUSIVE_RETRY_OWNER, classifyCloserOutcome, closerInconclusiveLaunchIds,
  readCloserInconclusiveRetries, recordCloserInconclusiveRetry } from './closer-inconclusive-retry.mjs';
import { resolveHqRoot } from '../hq-root.mjs';

export const CLOSURE_BUDGET_NEXT_ACTION = 'inspect the latest closer audit for this head, then push a fix '
  + 'for the refused condition (a reviewed new head re-arms the budget) or grant an operator re-drive';

// INCONCLUSIVERETRY-01b: a budget spent only by launches the owner recorded as
// inconclusive was never spent.
// CLOSERRETRYREFUND-01: the rule is per charge, not all-or-nothing. A charge is
// a fault, never an adjudication, when its own launch is named by the owner's
// inconclusive record (including a launch the pipeline itself superseded) or
// when every stop that launch wrote to the AMA audit has closer or
// infrastructure origin. Each fault charge is refunded once, by launch id, the
// first time this executor sees it, so a revision that fixes the fault re-arms
// the closer on its first pass. Real charges stay spent; the owner's retry
// record paces the re-armed closer, so a persistent fault cannot spin.
function auditFaultStop(attempts, launchRequestId) {
  const own = attempts.filter(attempt => attempt?.launchRequestId === launchRequestId);
  if (!own.length || own.some(attempt => attempt.outcome === 'succeeded')) return null;
  const stops = own.filter(attempt => typeof attempt.reason === 'string' && attempt.reason.trim());
  if (!stops.length) return null;
  const classes = stops.map(attempt => classifyCloserOutcome({ reason: attempt.reason }));
  return classes.every(value => value.kind === 'inconclusive') ? classes.at(-1).reason : null;
}

export function refundInconclusiveExhaustion({ rootDir, repo, prNumber, headSha = null, now = Date.now(),
  hqRoot = null, readLedgerImpl = readHammerRetryCapLedger,
  refundImpl = refundCloserSelfError, readRetriesImpl = readCloserInconclusiveRetries,
  readAuditImpl = readAmaAuditEntry, recordRetryImpl = recordCloserInconclusiveRetry } = {}) {
  const identity = { repo, prNumber };
  const ledger = readLedgerImpl(rootDir, identity);
  if (!ledger || ledger.__corrupt) return { recovered: false, reason: 'ledger-unavailable' };
  const charges = Object.values(ledger.dispatchCharges || {}).filter(charge => charge?.jobKey === ledger.jobKey
    && !Object.values(charge.refundedBudgets || {}).some(Boolean));
  if (!charges.length) return { recovered: false, reason: 'no-open-charge', realAttempts: 0 };
  const inconclusive = closerInconclusiveLaunchIds(readRetriesImpl(rootDir, identity));
  const audits = new Map();
  const auditAttempts = head => {
    if (!hqRoot || !head) return [];
    if (!audits.has(head)) {
      let attempts = [];
      try { attempts = readAuditImpl(hqRoot, repo, prNumber, head)?.attempts || []; }
      catch { /* An unreadable audit proves nothing; the charge stays real. */ }
      audits.set(head, Array.isArray(attempts) ? attempts : []);
    }
    return audits.get(head);
  };
  const faults = [];
  const real = [];
  for (const charge of charges) {
    if (inconclusive.has(charge.launchRequestId)) { faults.push({ charge, source: 'owner-record' }); continue; }
    // The closer may have pushed a remediation head before its merge step
    // stopped, so its audit can sit at the current head instead.
    const heads = [...new Set([charge.headSha, headSha].filter(Boolean))];
    const reason = auditFaultStop(heads.flatMap(auditAttempts), charge.launchRequestId);
    if (!reason) { real.push(charge); continue; }
    try {
      recordRetryImpl(rootDir, identity, { headSha: charge.headSha, launchRequestId: charge.launchRequestId,
        reason, now: new Date(now).toISOString() });
    } catch { /* Pacing is best effort; the refund below is still owed. */ }
    faults.push({ charge, source: 'audit', reason });
  }
  if (!faults.length) return { recovered: false, reason: 'real-attempts-spent-budget', realAttempts: real.length };
  const refunds = faults.map(({ charge }) => {
    try {
      return refundImpl(rootDir, identity, { jobKey: charge.jobKey, headSha: charge.headSha,
        launchRequestId: charge.launchRequestId, now: new Date(now).toISOString() });
    } catch (error) { return { refunded: false, reason: error?.code || 'refund-failed' }; }
  });
  const refunded = refunds.filter(refund => refund.refunded).length;
  return { recovered: refunded === faults.length,
    reason: refunded !== faults.length ? 'refund-incomplete' : real.length ? 'fault-charges-refunded' : 'inconclusive-only',
    refunded, charges: charges.length, realAttempts: real.length,
    faultLaunches: faults.map(({ charge, source, reason }) => ({ launchRequestId: charge.launchRequestId,
      source, ...(reason ? { reason } : {}) })) };
}

// A spent budget has no automatic executor. Give it a named escalation owner;
// the wait store reserves one page atomically and refunds failed delivery.
// CLOSERRETRYREFUND-01: this is the R07 `retry-exhausted`/`lifetime-exhausted`
// executor. It either re-arms one ordinary closer (fault charges refunded) or
// publishes the typed terminal `closure-<reason>` as the pass result, so the
// watcher and `hq merge-agent rescue` read one named state with an operator
// owner instead of a repeating `closure-decision-mismatch`.
export const CLOSURE_BUDGET_REFUNDED_REASON = 'closure-budget-refunded';
export async function escalateClosureBudget({ result, rootDir, repo, prNumber,
  now = Date.now(), env = process.env, observeWaitImpl = observeClosureWait,
  hqRoot = resolveHqRoot(env), refundInconclusiveImpl = refundInconclusiveExhaustion }) {
  // CAPREHEAD has an automatic executor for this pass, including known live
  // closer/builder custody. Refusals and unknown custody retain the normal page.
  if (result?.capRehead?.dispatched || result?.capRehead?.custody === true) return result;
  const decision = result?.nextAction;
  if (decision?.row !== 'R07-stop'
    || !['retry-exhausted', 'lifetime-exhausted'].includes(decision.reason)) return result;
  const reason = `closure-${decision.reason}`;
  const owned = { owner: CLOSER_INCONCLUSIVE_RETRY_OWNER, reason, recommendedAction: CLOSURE_BUDGET_NEXT_ACTION };
  let inconclusive;
  try { inconclusive = refundInconclusiveImpl({ rootDir, repo, prNumber, headSha: decision.head || null, now, hqRoot }); }
  catch (error) { inconclusive = { recovered: false, reason: `refund-check-failed:${error?.message || error}` }; }
  // Fault charges were never spent: the owner re-arms the ordinary closer,
  // with every merge check, on the next pass.
  if (inconclusive.recovered || inconclusive.reason === 'refund-incomplete') {
    return { ...result, reason: CLOSURE_BUDGET_REFUNDED_REASON, priorReason: result.reason ?? null,
      needsOperator: false, recoveryWait: true,
      ownedRetry: { ...owned, reason: 'closure-budget-inconclusive-only', deadline: new Date(now).toISOString() },
      inconclusiveExhaustion: inconclusive };
  }
  const escalation = await observeWaitImpl({ rootDir, repo, prNumber,
    headSha: decision.head, waitClass: reason, immediate: true, now, env,
    reason: `${reason}; real closer attempts spent the budget; owner ${owned.owner}; `
      + `recommended next action: ${owned.recommendedAction}` });
  return { ...result, reason, priorReason: result.reason ?? null,
    needsOperator: true, operatorReason: reason, boundedWait: escalation,
    closureTerminal: { state: reason, headSha: decision.head || null, owner: 'operator',
      realAttempts: inconclusive.realAttempts ?? null, recommendedAction: owned.recommendedAction },
    ownedRetry: { ...owned, deadline: decision.deadline || null }, inconclusiveExhaustion: inconclusive };
}
