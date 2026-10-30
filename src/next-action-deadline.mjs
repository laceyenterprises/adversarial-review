// CLOSURERECOVERYEXEC-01: one expired-deadline projection for the watcher log
// and the pipeline-health summary. Pure and import-free: it reads only the
// shared decision (src/pr-next-action.mjs) and the caller's clock.
//
// A `refresh` deadline is the observer's re-read cadence, not an ownership
// commitment; every tick re-observes it, so its lapse is not reported here.
// Every other class (admission, recovery, observer, live-owner windows) names
// an owner that promised progress by `deadline.at`.

const text = value => (typeof value === 'string' ? value.trim() : '');

export function isClosureRecoveryNextAction(decision) {
  return decision?.actor === 'closure-recovery' || decision?.deadline?.class === 'recovery';
}

/**
 * @param {object|null} decision shared next action ({action, actor, reason, deadline, head, row})
 * @param {{headSha?: string|null, nowMs: number}} options
 * @returns {null|{action:string, actor:string, reason:string, row:string|null, head:string,
 *   deadlineAt:string, deadlineClass:string, ageMs:number, closureRecovery:boolean}}
 */
export function expiredNextActionDeadline(decision, { headSha = null, nowMs } = {}) {
  const head = text(decision?.head);
  if (!head || (text(headSha) && text(headSha) !== head)) return null;
  const deadlineClass = text(decision?.deadline?.class);
  if (!deadlineClass || deadlineClass === 'refresh') return null;
  const dueMs = Date.parse(text(decision.deadline.at));
  const observedMs = typeof nowMs === 'number' ? nowMs : Date.parse(text(nowMs));
  if (!Number.isFinite(dueMs) || !Number.isFinite(observedMs) || observedMs < dueMs) return null;
  return {
    action: text(decision.action) || null,
    actor: text(decision.actor) || null,
    reason: text(decision.reason) || null,
    row: text(decision.row) || null,
    head,
    deadlineAt: new Date(dueMs).toISOString(),
    deadlineClass,
    ageMs: observedMs - dueMs,
    closureRecovery: isClosureRecoveryNextAction(decision),
  };
}

export function formatExpiredNextActionDeadline(expired, { repo, prNumber, outcome = null } = {}) {
  return `[watcher] next-action deadline expired for ${repo}#${prNumber}: `
    + `action=${expired.action} actor=${expired.actor} reason=${expired.reason} `
    + `head=${expired.head.slice(0, 12)} deadline=${expired.deadlineAt} class=${expired.deadlineClass} `
    + `age_ms=${expired.ageMs}${outcome ? ` route=${outcome}` : ''}`;
}
