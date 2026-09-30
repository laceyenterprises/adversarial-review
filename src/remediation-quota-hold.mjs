// Reconcile-time quota hold for a remediation worker that hit a hard provider
// usage cap. Extracted from follow-up-remediation.mjs (ARC-19 R3) for
// REMFALLBACK-01, which changes how the hold spends the retry budget.
//
// HRR graceful degradation: the direct-CLI remediation worker (default path
// when ADV_WITH_HQ_INTEGRATION is unset) spawns the codex/claude CLI outside the
// dispatch daemon, so a hard provider usage cap bypasses HRR exactly like the
// reviewer and surfaces as an empty/missing artifact, which would otherwise post
// a misleading "remediation worker exited without an artifact / needs human"
// terminal failure. Instead: detect the cap in the worker's stderr log and
// requeue the job to pending with retryAfter pinned to the provider reset (or a
// fixed fallback), so the consume gate holds it until quota returns and a future
// tick re-resolves and spawns the remediation worker. Applies to every harness
// whose cap shape we know (codex / claude / gemini's generic shape).
//
// REMFALLBACK-01 (SEV3 agent-os#7327): a cap whose provider reset is further out
// than one hold window is not waited out by respawning the capped provider. The
// next claim re-resolves the remediator class (resolveClaimedRemediatorRouting):
// it moves to a declared fallback class, or holds with no respawn when none is
// available, and never respawns the capped class before its reset. Such a hold
// therefore does not spend the transient-retry budget and cannot end in
// `quota-exhausted-budget-exhausted`; that terminal park used to cost every
// codex-routed remediation a 5-day weekly cap. A reset inside the window, or no
// parseable reset, respawns the same provider once the hold ends, so it stays
// bounded by the shared transient-retry budget as before.
import { markFollowUpJobFailed, requeueInProgressFollowUpJobForRetry } from './follow-up-jobs.mjs';
import { parseQuotaResetAt } from './quota-exhaustion.mjs';
import { MAX_QUOTA_HOLD_WINDOW_MS } from './remediation-quota-evidence.mjs';

// Fallback hold window for a quota-exhausted remediation worker when the
// provider did not hand back a parseable reset time. Mirrors the reviewer
// path's QUOTA_EXHAUSTED_BACKOFF_MS (15 min) so both worker classes degrade
// the same way under a hard usage cap.
export const QUOTA_REMEDIATION_BACKOFF_MS = 15 * 60 * 1000;

export async function settleQuotaExhaustedRemediation({
  rootDir, job, jobPath, worker, workerState, completedAt, quotaSignal, quotaLogText,
  maxRetries, now, log, postCommentImpl, buildCommentDelivery, postOutcomeComment,
}) {
  const parsedCompletedAtMs = Date.parse(String(completedAt || ''));
  const completedAtMs = Number.isNaN(parsedCompletedAtMs) ? Date.now() : parsedCompletedAtMs;
  const nextQuotaRetry = Number(job?.remediationPlan?.transientRetries || 0) + 1;
  const resetIso = parseQuotaResetAt(quotaLogText, { nowMs: completedAtMs });
  const providerRetryAfterMs = resetIso ? Date.parse(resetIso) : NaN;
  const pastHoldWindow = Number.isFinite(providerRetryAfterMs)
    && providerRetryAfterMs > completedAtMs + MAX_QUOTA_HOLD_WINDOW_MS;
  if (pastHoldWindow || nextQuotaRetry <= maxRetries) {
    const retryAfterMs = Number.isFinite(providerRetryAfterMs)
      ? Math.min(providerRetryAfterMs, completedAtMs + MAX_QUOTA_HOLD_WINDOW_MS)
      : completedAtMs + QUOTA_REMEDIATION_BACKOFF_MS;
    const retryAfter = new Date(retryAfterMs).toISOString();
    const budgetNote = pastHoldWindow
      ? 'reset is past the hold window, so the next claim re-resolves the remediator class; retry budget not spent'
      : `retry ${nextQuotaRetry}/${maxRetries}`;
    const retryReason = `Provider usage cap hit (${quotaSignal.harness} harness); holding remediation until ${retryAfter} (HRR graceful degradation, ${budgetNote}).`;
    const requeued = requeueInProgressFollowUpJobForRetry({
      rootDir,
      jobPath,
      requeuedAt: completedAt,
      retryReason,
      retryAfterOverride: retryAfter,
      allowDirectWorkerRetry: true,
      chargeRetryBudget: !pastHoldWindow,
      retryMetadata: {
        code: 'quota-exhausted',
        harness: quotaSignal.harness,
        // The class and model that ran: job-local cap evidence for the next claim.
        workerClass: worker?.workerClass || worker?.model || null,
        model: worker?.resolvedModel || null,
        resetAt: resetIso || null,
        providerResetAt: resetIso || null,
        source: resetIso ? 'provider-reported' : 'fallback-window',
        maxUnvalidatedHoldMs: MAX_QUOTA_HOLD_WINDOW_MS,
        pastHoldWindow,
      },
    });
    log?.log?.(
      `[follow-up-remediation] Held ${job.repo}#${job.prNumber} -> quota-exhausted ` +
        `(${quotaSignal.harness}) until ${retryAfter} [${resetIso ? 'provider-reported' : 'fallback-window'}]` +
        (pastHoldWindow ? '; reset past the hold window, the next claim re-resolves the remediator' : '')
    );
    return {
      action: 'requeued',
      reason: 'quota-exhausted',
      job: requeued.job,
      jobPath: requeued.jobPath,
    };
  }
  // Quota retry budget exhausted: fall through to a distinct terminal code so
  // the operator comment names the real cause (a sustained provider cap) and
  // does not read as a worker bug.
  const quotaBudgetFailure = {
    code: 'quota-exhausted-budget-exhausted',
    message: `Remediation worker repeatedly hit a hard provider usage cap (${quotaSignal.harness} harness); exhausted the retry budget (${nextQuotaRetry - 1}/${maxRetries}). The PR's remediation is paused for operator action (wait for the cap to clear or add credits).`,
  };
  const { commentDelivery: quotaBudgetDelivery } = buildCommentDelivery({
    job, worker, action: 'failed', failure: quotaBudgetFailure, now,
  });
  const failed = markFollowUpJobFailed({
    rootDir,
    jobPath,
    failedAt: completedAt,
    failureCode: quotaBudgetFailure.code,
    error: new Error(quotaBudgetFailure.message),
    remediationWorker: {
      ...workerState,
      state: 'failed',
    },
    failure: {
      code: quotaBudgetFailure.code,
      message: quotaBudgetFailure.message,
      harness: quotaSignal.harness,
      quotaRetryBudget: { attempted: nextQuotaRetry - 1, max: maxRetries },
      logPath: worker.logPath || null,
    },
    commentDelivery: quotaBudgetDelivery,
  });
  await postOutcomeComment({
    rootDir,
    jobPath: failed.jobPath,
    job: failed.job,
    worker,
    action: 'failed',
    failure: quotaBudgetFailure,
    postCommentImpl,
    alreadyTerminal: failed.alreadyTerminal,
    now,
    log,
  });
  return {
    action: 'failed',
    reason: quotaBudgetFailure.code,
    job: failed.job,
    jobPath: failed.jobPath,
  };
}
