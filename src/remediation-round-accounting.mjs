// Remediation round accounting and durable infrastructure outcomes (REMREFUND-01).
import { join } from 'node:path';
import { withFollowUpJobLock } from './follow-up-job-write.mjs';
import { readFollowUpJob, writeFollowUpJob, summarizePRRemediationLedger, requeueInProgressFollowUpJobForRetry } from './follow-up-jobs.mjs';
import { infrastructureRefundReason, localWorkerErrorOutcome } from './remediation-infrastructure-refund.mjs';

export function logRoundBudgetDecision(log, {
  riskClass,
  runsCompleted,
  cap,
  decision,
  repo = null,
  prNumber = null,
}) {
  const payload = {
    event: 'remediation-round-budget',
    repo,
    prNumber,
    riskClass,
    runsCompleted,
    cap,
    decision,
  };
  log?.log?.(`[follow-up] ${JSON.stringify(payload)}`);
}

export async function settleInfrastructureRemediationRound({
  rootDir, job, jobPath, worker, liveness, lifecycle, lifecycleStop, completedAt,
  postOutcomeComment, postCommentImpl, now, log,
}) {
  const round = job.remediationPlan?.rounds?.find((entry) => entry.round === job.remediationPlan.currentRound);
  const startHead = round?.startHeadSha || job.revisionRef;
  const liveHead = lifecycle?.source === 'live' ? lifecycle.headSha : null;
  const ledger = summarizePRRemediationLedger(rootDir, job);
  const alreadyRetriedRound = (job.remediationPlan?.retryHistory || []).some((retry) =>
    retry.round === job.remediationPlan.currentRound && retry.retryMetadata?.code === 'infrastructure-refund');
  const refund = withFollowUpJobLock(join(rootDir, 'data', 'follow-up-jobs'), () => {
    // Exit events can land while the live-head lookup awaits; read their durable outcome.
    const recordedOutcome = readFollowUpJob(jobPath).remediationWorker?.recordedOutcome;
    if (recordedOutcome) worker.recordedOutcome = recordedOutcome;
    const refundReason = liveness.state === 'exited' && !lifecycleStop && !alreadyRetriedRound
      ? infrastructureRefundReason({
        outcome: liveness.dispatchStatus || worker.recordedOutcome,
        startHead, endHead: liveHead, refunds: summarizePRRemediationLedger(rootDir, job).infrastructureRefundsForPR || 0,
      }) : null;
    if (!refundReason) return null;
    const requeued = requeueInProgressFollowUpJobForRetry({
      rootDir, jobPath, requeuedAt: completedAt,
      retryReason: `not charged: ${refundReason}`,
      retryAfterOverride: completedAt, allowDirectWorkerRetry: true, chargeRetryBudget: false,
      retryMetadata: {
        code: 'infrastructure-refund', reason: refundReason, startHead, endHead: liveHead,
        workerClass: worker.workerClass || worker.model,
        harnessSpecific: refundReason === 'codex-tool-host-unavailable'
          || (refundReason === 'boot-failed' && worker.dispatchMode !== 'hq'),
      },
    });
    return { refundReason, requeued };
  });
  if (refund) {
    const { refundReason, requeued } = refund;
    await postOutcomeComment({
      rootDir, jobPath: requeued.jobPath, job, worker,
      action: 'refunded', failure: { message: `not charged: ${refundReason}` },
      postCommentImpl, now, log,
    });
    return { action: 'requeued', reason: refundReason, ...requeued };
  }
  job.remediationPlan.publishedRoundsForPR = (ledger.publishedRoundsForPR || 0)
    + (round && liveHead && startHead && liveHead !== startHead && !round.publishedHeadSha ? 1 : 0);
  if (round && liveHead && startHead && liveHead !== startHead) {
    round.startHeadSha = startHead;
    round.publishedHeadSha = liveHead;
  }
  writeFollowUpJob(jobPath, job);
  return null;
}

export function recordLocalRemediationOutcome({ rootDir, jobPath, worker, log }) {
  const recordOutcome = (outcome) => {
    try {
      withFollowUpJobLock(join(rootDir, 'data', 'follow-up-jobs'), () => {
        const current = readFollowUpJob(jobPath);
        if (current.status !== 'in_progress' || current.remediationWorker?.processId !== worker.processId) return;
        current.remediationWorker.recordedOutcome = { ...current.remediationWorker.recordedOutcome, ...outcome };
        writeFollowUpJob(jobPath, current);
      });
    } catch (err) {
      log.warn?.(`[follow-up-remediation] cannot record worker outcome: ${err.message}`);
    }
  };
  worker.child?.once?.('error', (error) => recordOutcome(localWorkerErrorOutcome(worker, error)));
  worker.child?.once?.('exit', (exitCode, signal) => recordOutcome({
    exitCode: exitCode ?? (signal === 'SIGTERM' ? 143 : signal === 'SIGKILL' ? 137 : null),
    signal,
  }));
}
