import { HAMMER_STOP_ORIGINS, registeredHammerStopOrigin } from './hammer-stop-origin.mjs';

export const HAMMER_RETRYABLE_READ_OUTCOMES = new Set([
  ...Object.keys(HAMMER_STOP_ORIGINS).filter(reason => HAMMER_STOP_ORIGINS[reason] !== 'world'),
]);


// MRQ-02: the watcher owns a re-drive of every retryable closer deferral on the
// same head (a fresh launch under a fresh lease, paced by the owned retry).
// The attempt names that continuation, so the launch can end succeeded with
// its PR still open only when something durable comes next. An in-run retry is
// not a launch's terminal decision and names none.
const SHA = /^[a-f0-9]{40}$/i;
export const HAMMER_REDRIVE_CONTINUATION_OWNER = 'watcher';
export function hammerRedriveContinuation({ headSha, now } = {}) {
  if (!SHA.test(headSha || '')) return null;
  const at = new Date(now ?? Date.now());
  return { kind: 'redrive', owner: HAMMER_REDRIVE_CONTINUATION_OWNER, headSha: String(headSha).toLowerCase(),
    notBefore: (Number.isFinite(at.getTime()) ? at : new Date()).toISOString(), lease: 'fresh' };
}

export function hammerPhaseAttempt(attempt, { headSha = null, now = null } = {}) {
  if (!['failed-without-merge', 'deferred'].includes(attempt?.outcome)
    || !HAMMER_RETRYABLE_READ_OUTCOMES.has(attempt.reason)) return attempt;
  const continuation = attempt.continuation || attempt.inRunRetry === true ? null
    : hammerRedriveContinuation({ headSha, now });
  return { ...attempt, outcome: 'deferred', ...(continuation ? { continuation } : {}) };
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
    // Unknown historical codes retain their original authority.
    if (registeredHammerStopOrigin(attempt.reason) === 'closer') {
      const [code, diagnostic] = attempt.reason.split(':');
      closerReason = code === 'review-evidence-invalid' ? diagnostic : code;
    }
    const daemon = String(attempt.attemptPhase).startsWith('daemon')
      || String(attempt.path).startsWith('daemon');
    const hammer = !daemon && (doc.closureAuthority === 'ham-terminal-remediation'
      || attempt.attemptPhase === 'hammer-early-exit' || attempt.path === 'hammer');
    const facts = [attempt.reasons, attempt.eligibilityTrace?.reasons, attempt.githubGate?.reasons];
    const sameLaunchRefusal = doc.attempts.some(other => other !== attempt
      && other.launchRequestId === attempt.launchRequestId && other.outcome === 'failed-without-merge'
      && [null, 'world'].includes(registeredHammerStopOrigin(other.reason)));
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
