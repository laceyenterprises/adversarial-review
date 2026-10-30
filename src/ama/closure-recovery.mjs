// CLOSURERECOVERYEXEC-01: the executor for an R04 `closure-recovery` next
// action (ownership reconciliation). Before this, nothing ran that actor: the
// background hammer queue refused it as `closure-decision-mismatch`, the inline
// closer refused it as `ownership-unreadable`, and no path enforced its
// deadline, so the PR sat ownerless indefinitely.
//
// Execution reuses the existing custody readers: both the inline route and the
// background queue hand the decision to the closer, whose admission reconciles
// the recorded launch/lease (and dispatches when ownership resolves) before its
// shared-intent gate. This module owns what happens when it does not resolve:
// the closer's named refusal until the decision's deadline, then exactly one
// escalation through the closure-wait page. It owns no merge or dispatch authority.
import { hasClosureRecoveryIntent } from './closure-next-action.mjs';
import { observeClosureWait } from './closure-wait.mjs';

export const CLOSURE_RECOVERY_WAIT_CLASS = 'closure-recovery-deadline';
export const CLOSURE_RECOVERY_ESCALATED_REASON = 'closure-recovery-ownership-unresolved';
const RETRY_MS = 30_000;
// Closer outcomes that leave custody unresolved, besides its intent gate
// echoing the R04 reason itself. Any other refusal names its own owner.
const CUSTODY_REFUSALS = new Set(['existing-dispatch-unknown', 'dispatch-retry-chain-unreadable']);

const text = value => (typeof value === 'string' ? value.trim() : '');

function unresolvedEvidence(shared) {
  const { decision, snapshot } = shared;
  const launch = snapshot?.observations?.launches?.value?.closer;
  const lease = snapshot?.observations?.leases?.value?.closer;
  const launchRequestId = text(launch?.launchRequestId) || text(lease?.lrqId) || null;
  const refs = (decision.evidenceRefs || []).filter(ref => /^(lease|launch):/.test(ref));
  return { launchRequestId, unresolved: refs };
}

/**
 * Apply the R04 deadline to a closure result that did not dispatch.
 * @returns {Promise<object>} the result, unchanged unless `shared` is still an
 *   R04 reconciliation for this head and the closer left custody unresolved.
 */
export async function enforceClosureRecoveryDeadline({ rootDir, repo, prNumber, headSha, shared, result,
  now = Date.now(), env = process.env, observeWaitImpl = observeClosureWait, logger = console }) {
  if (!result || result.dispatched || !hasClosureRecoveryIntent(shared, { repo, prNumber, headSha })) return result;
  const decision = shared.decision;
  const dueMs = Date.parse(text(decision.deadline?.at));
  const ageMs = Number.isFinite(dueMs) ? now - dueMs : null;
  const { launchRequestId, unresolved } = unresolvedEvidence(shared);
  const closerReason = text(result.reason) || null;
  const detail = `action=${decision.action} actor=${decision.actor} reason=${decision.reason} head=${headSha} `
    + `deadline=${decision.deadline?.at || 'unknown'} ageMs=${ageMs ?? 'unknown'} `
    + `closer=${closerReason || 'none'} unresolved=${unresolved.join(',') || 'none'}`;
  const closureRecovery = { decisionKey: decision.decisionKey, reason: decision.reason,
    deadlineAt: decision.deadline?.at ?? null, ageMs, closerReason, launchRequestId, unresolved, detail };
  // The background closer is reconciling custody now; closure enforces its
  // settled refusal when it applies it on a later pass.
  if (result.backgroundDispatch) return { ...result, closureRecovery: { ...closureRecovery, outcome: 'executing' } };
  // Other named blockers (holds, stops, waits) keep their own owner and reason.
  if (result.boundedWait || !(closerReason === decision.reason || CUSTODY_REFUSALS.has(closerReason))) return result;
  const base = { ...result, dispatched: false, skipMergeAgent: true, recoveryWait: true, closerReason };
  // Before the deadline the closer's own refusal names the wait. A missing
  // deadline cannot defer escalation forever.
  if (ageMs !== null && ageMs < 0) {
    return { ...base, closureRecovery: { ...closureRecovery, outcome: 'pending' },
      retryAfterMs: Math.max(1000, Math.min(RETRY_MS, -ageMs)) };
  }
  const closureBlocker = `${CLOSURE_RECOVERY_ESCALATED_REASON}: ${detail}`;
  let boundedWait = null;
  let pageError = null;
  try {
    // closure-wait reserves one page per PR/head/class and refunds a refused
    // delivery, so later ticks re-observe without paging again.
    boundedWait = await observeWaitImpl({ rootDir, repo, prNumber, headSha, env, now,
      reason: closureBlocker, immediate: true, waitClass: CLOSURE_RECOVERY_WAIT_CLASS });
  } catch (error) {
    pageError = text(error?.message) || String(error);
    logger?.warn?.(`[watcher] closure-recovery escalation delivery failed for ${repo}#${prNumber}: ${pageError}`);
  }
  return { ...base, reason: CLOSURE_RECOVERY_ESCALATED_REASON, namedReason: CLOSURE_RECOVERY_ESCALATED_REASON,
    closureBlocker, needsOperator: true,
    ...(boundedWait ? { boundedWait } : {}), retryAfterMs: RETRY_MS,
    closureRecovery: { ...closureRecovery, outcome: 'escalated', paged: boundedWait?.notify === true,
      ...(pageError ? { pageError } : {}) } };
}
