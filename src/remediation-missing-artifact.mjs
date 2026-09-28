import { markFollowUpJobFailed, requeueInProgressFollowUpJobForRetry } from './follow-up-jobs.mjs';
import { hasTerminalProviderCapacitySignal } from './provider-capacity-signal.mjs';
import {
  INFRA_RUNTIME_MISSING_LIBRARY_FAILURE_CLASS,
  hasMissingRuntimeLibrarySignal,
} from './runtime-missing-library.mjs';

export async function settleMissingRemediationArtifact({
  rootDir, job, jobPath, worker, workerState, completedAt, finalMessage,
  liveness, logText, resumeImpossible, maxRetries, hqDispatchSucceeded, now, log, postCommentImpl,
  buildCommentDelivery, postOutcomeComment,
}) {
  // A worker whose CLI died in dyld never ran: the host runtime lost a shared
  // library (a Homebrew upgrade moved node's dylibs; NODEPIN-01). That is a
  // host fault, so it rides the same bounded transient budget as provider
  // capacity, and the requeue spends no remediation round.
  const missingLibrary = hasMissingRuntimeLibrarySignal(logText);
  const capacity = !missingLibrary
    && (worker?.dispatchMode !== 'hq' || hqDispatchSucceeded)
    && hasTerminalProviderCapacitySignal(logText);
  const transientCode = missingLibrary
    ? INFRA_RUNTIME_MISSING_LIBRARY_FAILURE_CLASS
    : capacity ? 'provider-capacity' : null;
  const transientCause = missingLibrary
    ? 'Remediation worker died in dyld (host runtime is missing a shared library; run `hq doctor dylib-drift`)'
    : 'Provider capacity or overload interrupted remediation';
  const nextRetry = Number(job?.remediationPlan?.transientRetries || 0) + 1;
  if (transientCode && nextRetry <= maxRetries) {
    const retryReason = `${transientCause}; retry ${nextRetry}/${maxRetries} after backoff.`;
    const requeued = requeueInProgressFollowUpJobForRetry({
      rootDir, jobPath, requeuedAt: completedAt, retryReason,
      allowDirectWorkerRetry: true,
      retryMetadata: { code: transientCode, logPath: worker.logPath || null },
    });
    const retryAfter = requeued.job.remediationPlan.retryAfter;
    log?.log?.(`[follow-up-remediation] Requeued ${job.repo}#${job.prNumber} -> ${transientCode} until ${retryAfter}`);
    return { action: 'requeued', reason: transientCode, job: requeued.job, jobPath: requeued.jobPath };
  }

  const dispatchFailureDetail = liveness?.dispatchStatus?.failureDetail || null;
  const failureCode = transientCode
    || (worker?.dispatchMode === 'hq' && !hqDispatchSucceeded
      ? 'hq-dispatch-failed'
      : finalMessage.exists ? 'artifact-empty-completion' : 'artifact-missing-completion');
  const failureMessage = transientCode
    ? `${transientCause}; exhausted transient retry budget (${nextRetry - 1}/${maxRetries}).`
    : failureCode === 'hq-dispatch-failed'
      ? dispatchFailureDetail || `HQ remediation dispatch ended with status ${liveness?.dispatchStatus?.status || 'unknown'} before writing a usable remediation reply.`
      : finalMessage.exists
        ? 'Remediation worker exited without a non-empty final message artifact.'
        : 'Remediation worker exited before writing the final message artifact.';
  const failure = { code: failureCode, message: failureMessage };
  const { commentDelivery } = buildCommentDelivery({ job, worker, action: 'failed', failure, now });
  const failed = markFollowUpJobFailed({
    rootDir, jobPath, failedAt: completedAt, failureCode,
    error: new Error(failureMessage),
    remediationWorker: { ...workerState, state: 'failed' },
    failure: {
      ...(transientCode ? { transientRetryBudget: { attempted: nextRetry - 1, max: maxRetries,
        currentRound: Number(job?.remediationPlan?.currentRound || 0) } } : {}),
      resumeImpossible,
      finalMessagePath: worker.outputPath || null,
      finalMessageBytes: finalMessage.bytes,
      logPath: worker.logPath || null,
      dispatchStatus: liveness?.dispatchStatus || null,
    },
    commentDelivery,
  });
  await postOutcomeComment({
    rootDir, jobPath: failed.jobPath, job: failed.job, worker,
    action: 'failed', failure, postCommentImpl,
    alreadyTerminal: failed.alreadyTerminal, now, log,
  });
  return {
    action: 'failed',
    reason: transientCode || (finalMessage.exists ? 'empty-final-message-artifact' : 'missing-final-message-artifact'),
    job: failed.job, jobPath: failed.jobPath,
  };
}
