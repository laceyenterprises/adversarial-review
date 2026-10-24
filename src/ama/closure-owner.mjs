// Compatibility projection only. Selection belongs to nextAction(snapshot).
import { nextAction } from '../pr-next-action.mjs';
// NXA-05: compatibility outputs describe the selected workflow, including
// recovery. A page or a capacity observation cannot replace its actor.
export function closureOwnerFromDecision(decision) {
  const owner = { review: 'review', remediate: 'remediation', hammer: 'hammer',
    'daemon-merge': 'daemon-merge', 'wait-for-CI': 'wait',
    'operator-hold': 'operator-hold', done: 'done' }[decision.action];
  return Object.freeze({ owner, actor: decision.actor, action: decision.action,
    reason: decision.reason, head: decision.head, deadline: decision.deadline,
    decisionKey: decision.decisionKey, queue: decision.queue });
}

// Callers with a snapshot use the same pure policy, without a second read or
// independent eligibility table. Execution callers normally pass the decision.
export function decideClosureOwner({ snapshot, decision } = {}) {
  return closureOwnerFromDecision(decision || nextAction(snapshot));
}
