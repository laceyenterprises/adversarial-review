import { HAMMER_STOP_ORIGINS, hammerStopOrigin } from './hammer-stop-origin.mjs';

export const HAMMER_RETRYABLE_READ_OUTCOMES = new Set([
  ...Object.keys(HAMMER_STOP_ORIGINS).filter(reason => HAMMER_STOP_ORIGINS[reason] !== 'world'),
]);


export function hammerPhaseAttempt(attempt) {
  return ['failed-without-merge', 'deferred'].includes(attempt?.outcome)
    && HAMMER_RETRYABLE_READ_OUTCOMES.has(attempt.reason)
    ? { ...attempt, outcome: 'deferred' } : attempt;
}

// Historical audits remain immutable on disk. Reclassify only explicitly
// identified hammer faults on read so an old harness mistake can reach the
// same ended-launch reconciliation as a new deferral. Structured world
// refusals and succeeded audits always win.
export function projectHammerStopAudit(doc) {
  if (!doc || doc.status === 'succeeded' || !Array.isArray(doc.attempts)
    || doc.attempts.some(attempt => !attempt || typeof attempt !== 'object' || Array.isArray(attempt))
    || doc.attempts.some(attempt => attempt.outcome === 'succeeded')) return doc;
  let changed = false;
  const attempts = doc.attempts.map(attempt => {
    let closerReason;
    try {
      if (hammerStopOrigin(attempt.reason) === 'closer') {
        const [code, diagnostic] = attempt.reason.split(':');
        closerReason = code === 'review-evidence-invalid' ? diagnostic : code;
      }
    } catch { /* Unknown historical codes retain their original authority. */ }
    const daemon = String(attempt.attemptPhase).startsWith('daemon')
      || String(attempt.path).startsWith('daemon');
    const hammer = !daemon && (doc.closureAuthority === 'ham-terminal-remediation'
      || attempt.attemptPhase === 'hammer-early-exit' || attempt.path === 'hammer');
    const facts = [attempt.reasons, attempt.eligibilityTrace?.reasons, attempt.githubGate?.reasons];
    const sameLaunchRefusal = doc.attempts.some(other => other !== attempt
      && other.launchRequestId === attempt.launchRequestId && other.outcome === 'failed-without-merge'
      && (() => { try { return hammerStopOrigin(other.reason) === 'world'; } catch { return true; } })());
    if (!hammer || sameLaunchRefusal || facts.some(value => value != null && (!Array.isArray(value) || value.length))
      || !closerReason
      || attempt.outcome !== 'failed-without-merge') return attempt;
    changed = true;
    return { ...attempt, reason: closerReason, outcome: 'deferred', recordedOutcome: attempt.outcome,
      ...(closerReason !== attempt.reason ? { reasonDetail: attempt.reason } : {}) };
  });
  return changed ? { ...doc, attempts, status: doc.status === 'failed-without-merge'
    && attempts.at(-1).outcome === 'deferred' ? 'deferred' : doc.status } : doc;
}
