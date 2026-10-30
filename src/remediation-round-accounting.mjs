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
  const liveHead = lifecycle?.source === 'live' ? lifecycle.headSha : null;
  let refund;
  try {
    refund = withFollowUpJobLock(join(rootDir, 'data', 'follow-up-jobs'), () => {
      // Exit events can land while the live-head lookup awaits; read their durable outcome.
      const current = readFollowUpJob(jobPath);
      if (current.status !== 'in_progress' || current.remediationPlan?.currentRound !== job.remediationPlan?.currentRound
        || current.remediationWorker?.processId !== worker.processId) return { action: 'skipped', reason: 'already-terminal' };
      const currentRound = current.remediationPlan?.rounds?.find((entry) => entry.round === current.remediationPlan.currentRound);
      const currentStartHead = currentRound?.startHeadSha || current.revisionRef;
      const alreadyRetriedRound = (current.remediationPlan?.retryHistory || []).some((retry) =>
        retry.round === current.remediationPlan.currentRound && retry.retryMetadata?.code === 'infrastructure-refund');
      const recordedOutcome = current.remediationWorker?.recordedOutcome;
      if (recordedOutcome) worker.recordedOutcome = { ...worker.recordedOutcome, ...recordedOutcome };
      let refundReason = liveness.state === 'exited' && !lifecycleStop && !alreadyRetriedRound
        ? infrastructureRefundReason({
          outcome: liveness.dispatchStatus || worker.recordedOutcome,
          startHead: currentStartHead, endHead: liveHead, refunds: 0,
        }) : null;
      if (refundReason) {
        refundReason = infrastructureRefundReason({
          outcome: liveness.dispatchStatus || worker.recordedOutcome,
          startHead: currentStartHead, endHead: liveHead,
          refunds: summarizePRRemediationLedger(rootDir, current, { refundsOnly: true }).infrastructureRefundsForPR || 0,
        });
      }
      if (!refundReason) {
        if (currentRound && liveHead && currentStartHead && liveHead !== currentStartHead) {
          currentRound.startHeadSha = currentStartHead;
          currentRound.publishedHeadSha = liveHead;
          writeFollowUpJob(jobPath, current);
          if (round) {
            round.startHeadSha = currentStartHead;
            round.publishedHeadSha = liveHead;
          }
        }
        return null;
      }
      const evidenceOutcome = liveness.dispatchStatus || worker.recordedOutcome;
      if (evidenceOutcome?.toolHostEvidence) {
        current.remediationWorker.recordedOutcome = evidenceOutcome;
        writeFollowUpJob(jobPath, current);
      }
      const requeued = requeueInProgressFollowUpJobForRetry({
        rootDir, jobPath, requeuedAt: completedAt,
        retryReason: `not charged: ${refundReason}`,
        retryAfterOverride: completedAt, allowDirectWorkerRetry: true, chargeRetryBudget: false,
        retryMetadata: {
          code: 'infrastructure-refund', reason: refundReason, startHead: currentStartHead, endHead: liveHead,
          workerClass: worker.workerClass || worker.model,
          harnessSpecific: refundReason === 'codex-tool-host-unavailable'
            || (refundReason === 'boot-failed' && worker.dispatchMode !== 'hq'),
        },
    });
    return { refundReason, requeued };
    });
  } catch (error) {
    if (['ENOENT', 'EWOULDBLOCK', 'EAGAIN'].includes(error.code)) {
      return { action: 'skipped', reason: 'accounting-retry-next-tick' };
    }
    throw error;
  }
  if (refund?.action === 'skipped') return refund;
  if (refund) {
    const { refundReason, requeued } = refund;
    await postOutcomeComment({
      rootDir, job, worker,
      action: 'refunded', failure: { message: `not charged: ${refundReason}` },
      postCommentImpl, now, log,
    });
    return { action: 'requeued', reason: refundReason, ...requeued };
  }
  return null;
}

export function recordLocalRemediationOutcome({ rootDir, jobPath, worker, log }) {
  const recordOutcome = (outcome, attempt = 0) => {
    try {
      withFollowUpJobLock(join(rootDir, 'data', 'follow-up-jobs'), () => {
        const current = readFollowUpJob(jobPath);
        if (current.status !== 'in_progress' || current.remediationWorker?.processId !== worker.processId) return;
        current.remediationWorker.recordedOutcome = { ...current.remediationWorker.recordedOutcome, ...outcome };
        writeFollowUpJob(jobPath, current);
      });
    } catch (err) {
      if (['EWOULDBLOCK', 'EAGAIN'].includes(err.code) && attempt < 5) {
        setTimeout(() => recordOutcome(outcome, attempt + 1), 25 * (2 ** attempt));
        return;
      }
      if (err.code === 'ENOENT') return;
      log.warn?.(`[follow-up-remediation] cannot record worker outcome: ${err.message}`);
    }
  };
  worker.child?.once?.('error', (error) => recordOutcome(localWorkerErrorOutcome(worker, error)));
  worker.child?.once?.('exit', (exitCode, signal) => recordOutcome({
    exitCode: exitCode ?? (signal === 'SIGTERM' ? 143 : signal === 'SIGKILL' ? 137 : null),
    signal,
  }));
}
