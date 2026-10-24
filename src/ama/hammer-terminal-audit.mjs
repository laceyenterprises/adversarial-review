import { appendAmaAuditAttempt, readAmaAuditEntry } from './audit.mjs';

// Failure recording must work before any GitHub read or merge-lease acquisition.
// Reasons are fixed codes, never transport output (which can contain secrets).
export function recordHammerEarlyFailure(reason, { env = process.env, headSha } = {}) {
  const identity = {
    hqRoot: env.HAM_HQ_ROOT || env.HQ_ROOT,
    repo: env.HAM_REPO,
    prNumber: Number(env.HAM_PR_NUMBER),
    headSha: headSha || env.HAM_TARGET_REMEDIATION_SHA || env.HAM_REVIEWED_SHA,
  };
  if (!identity.hqRoot || !identity.repo || !identity.prNumber || !identity.headSha) return null;
  const launchRequestId = env.HQ_LAUNCH_REQUEST_ID || null;
  const existing = readAmaAuditEntry(identity.hqRoot, identity.repo, identity.prNumber, identity.headSha);
  if (launchRequestId && existing?.attempts?.some(attempt =>
    attempt.launchRequestId === launchRequestId &&
    ['succeeded', 'failed-without-merge', 'superseded', 'deferred'].includes(attempt.outcome))) return existing;
  return appendAmaAuditAttempt({
    ...identity,
    attempt: { outcome: 'failed-without-merge', reason, launchRequestId,
      attemptPhase: 'hammer-early-exit' },
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
