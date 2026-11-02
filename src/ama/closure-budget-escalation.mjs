import { observeClosureWait } from './closure-wait.mjs';

// A spent budget has no automatic executor. Give it a named escalation owner;
// the wait store reserves one page atomically and refunds failed delivery.
export async function escalateClosureBudget({ result, rootDir, repo, prNumber,
  now = Date.now(), env = process.env, observeWaitImpl = observeClosureWait }) {
  // CAPREHEAD has an automatic executor for this pass, including known live
  // closer/builder custody. Refusals and unknown custody retain the normal page.
  if (result?.capRehead?.dispatched || result?.capRehead?.custody === true) return result;
  const decision = result?.nextAction;
  if (decision?.row !== 'R07-stop'
    || !['retry-exhausted', 'lifetime-exhausted'].includes(decision.reason)) return result;
  const reason = `closure-${decision.reason}`;
  const escalation = await observeWaitImpl({ rootDir, repo, prNumber,
    headSha: decision.head, waitClass: reason, reason, immediate: true, now, env });
  return { ...result, needsOperator: true, operatorReason: reason, boundedWait: escalation };
}
