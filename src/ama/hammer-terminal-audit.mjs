import { appendAmaAuditAttempt, readAmaAuditEntry } from './audit.mjs';
import { reportHammerProgress } from './hammer-progress.mjs';
import { HAMMER_RETRYABLE_READ_OUTCOMES, hammerPhaseAttempt } from './hammer-phase-outcome.mjs';

// Failure recording must work before any GitHub read or merge-lease acquisition.
// Reasons are fixed codes, never transport output (which can contain secrets).
// The terminal-stop progress receipt is written only when the caller declares
// the run's final exit; helper failures the closer may still retry write none.
export function recordHammerEarlyFailure(reason, { env = process.env, headSha, final = false } = {}) {
  if (!/^[a-z][a-z0-9:-]*$/.test(reason || '')) throw new TypeError('invalid hammer failure reason');
  // A later controller step must not terminalize with its previous phase's
  // success. The procedure exports a step identity before non-phase commands.
  if (['published', 'verified', 'ci-settled', 'ci-wait-not-needed'].includes(reason)) {
    const step = env.HAM_PROCEDURE_STEP;
    reason = /^[a-z][a-z0-9-]*$/.test(step || '') ? `${step}-failed` : 'procedure-step-failed';
  }
  if (final === true) reportHammerProgress('terminal-stop', { env, reason, final });
  const identity = {
    hqRoot: env.HAM_HQ_ROOT || env.HQ_ROOT,
    repo: env.HAM_REPO,
    prNumber: Number(env.HAM_PR_NUMBER),
    headSha: /^[a-f0-9]{40}$/i.test(headSha || '') ? headSha
      : env.HAM_TARGET_REMEDIATION_SHA || env.HAM_REVIEWED_SHA,
  };
  if (!identity.hqRoot || !identity.repo || !identity.prNumber || !identity.headSha) return null;
  const launchRequestId = env.HQ_LAUNCH_REQUEST_ID || null;
  const existing = readAmaAuditEntry(identity.hqRoot, identity.repo, identity.prNumber, identity.headSha);
  const prior = existing?.attempts?.findLast(attempt =>
    (launchRequestId ? attempt.launchRequestId === launchRequestId
      : !attempt.launchRequestId && attempt.attemptPhase === 'hammer-early-exit') &&
    ['succeeded', 'failed-without-merge', 'superseded', 'deferred'].includes(attempt.outcome));
  // A later authoritative fence overrides an observation failure. Generic
  // wrapper exits still preserve the phase's original failure receipt.
  const authoritativeFence = ['controller-cancelled', 'controller-owner-lost', 'head-changed',
    'rebase-conflict', 'github-gate-red', 'predicate-not-eligible'].includes(reason);
  if (prior && !(authoritativeFence && prior.outcome === 'deferred'
    && HAMMER_RETRYABLE_READ_OUTCOMES.has(prior.reason))) return existing;
  return appendAmaAuditAttempt({
    ...identity,
    attempt: hammerPhaseAttempt({ outcome: 'failed-without-merge', reason, launchRequestId,
      attemptPhase: 'hammer-early-exit' }),
    metadata: { closureAuthority: 'ham-terminal-remediation' },
  });
}

export function reportHammerEarlyFailure(reason, options) {
  try { return recordHammerEarlyFailure(reason, options); }
  catch {
    // Preserve the original failure, but make an unavailable audit explicit.
    process.stderr.write('HAM terminal failure audit unavailable\n');
    return null;
  }
}
