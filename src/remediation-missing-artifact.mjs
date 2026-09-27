import { markFollowUpJobFailed, requeueInProgressFollowUpJobForRetry } from './follow-up-jobs.mjs';
import { hasTerminalProviderCapacitySignal } from './provider-capacity-signal.mjs';

export async function settleMissingRemediationArtifact({
  rootDir, job, jobPath, worker, workerState, completedAt, finalMessage,
  liveness, logText, resumeImpossible, maxRetries, hqDispatchSucceeded, now, log, postCommentImpl,
  buildCommentDelivery, postOutcomeComment,
}) {
  const capacity = (worker?.dispatchMode !== 'hq' || hqDispatchSucceeded)
    && hasTerminalProviderCapacitySignal(logText);
  const nextRetry = Number(job?.remediationPlan?.transientRetries || 0) + 1;
  if (capacity && nextRetry <= maxRetries) {
    const retryReason = `Provider capacity or overload interrupted remediation; retry ${nextRetry}/${maxRetries} after backoff.`;
    const requeued = requeueInProgressFollowUpJobForRetry({
      rootDir, jobPath, requeuedAt: completedAt, retryReason,
      allowDirectWorkerRetry: true,
      retryMetadata: { code: 'provider-capacity', logPath: worker.logPath || null },
    });
    const retryAfter = requeued.job.remediationPlan.retryAfter;
    log?.log?.(`[follow-up-remediation] Requeued ${job.repo}#${job.prNumber} -> provider-capacity until ${retryAfter}`);
    return { action: 'requeued', reason: 'provider-capacity', job: requeued.job, jobPath: requeued.jobPath };
  }

  const dispatchFailureDetail = liveness?.dispatchStatus?.failureDetail || null;
  const failureCode = capacity ? 'provider-capacity'
    : worker?.dispatchMode === 'hq' && !hqDispatchSucceeded
      ? 'hq-dispatch-failed'
      : finalMessage.exists ? 'artifact-empty-completion' : 'artifact-missing-completion';
  const failureMessage = capacity
    ? `Provider capacity or overload interrupted remediation; exhausted transient retry budget (${nextRetry - 1}/${maxRetries}).`
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
      ...(capacity ? { transientRetryBudget: { attempted: nextRetry - 1, max: maxRetries,
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
    reason: capacity ? 'provider-capacity' : finalMessage.exists ? 'empty-final-message-artifact' : 'missing-final-message-artifact',
    job: failed.job, jobPath: failed.jobPath,
  };
}
