import { nextAction } from '../pr-next-action.mjs';

// Consume the same frozen snapshot and owner projection as v1. Never infer
// liveness from a dispatch receipt or a legacy action string.
export function finalizationOwner(snapshot, observedAt) {
  const decision = nextAction(snapshot);
  const deadline = decision.deadline?.at ?? null;
  const now = Date.parse(observedAt);
  const observed = Date.parse(snapshot?.observedAt);
  // Remediator `job.live` is already the bounded result of the canonical
  // remediationJobOwnership reader, refreshed in this snapshot. Closer launch
  // status alone needs a durable lease/progress deadline, never a poll anchor.
  const bounded = (decision.actor === 'remediator' || decision.deadline?.anchorSource !== 'observed')
    && Number.isFinite(now) && observed === now && now < Date.parse(deadline);
  const live = decision.row === 'R03-live-owner'
    && ['hammer', 'remediator'].includes(decision.actor) && bounded;
  return { live, actor: decision.actor, head: decision.head, deadline,
    reason: live ? 'live-owner' : decision.reason === 'live-owner' ? 'owner-bound-expired-or-unproven' : decision.reason,
    decisionKey: decision.decisionKey, evidenceRefs: decision.evidenceRefs };
}
