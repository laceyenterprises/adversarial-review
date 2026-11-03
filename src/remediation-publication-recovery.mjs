// Recover publication debt only from the same structural proof as completion.
// The queue writer compares the full source snapshot under its existing lock.
import { recoveryDigest } from './comment-only-recovery-record.mjs';
import { proveFinalRoundWorkerPush } from './comment-only-final-round.mjs';
import { resolveCommentOnlyFinalRoundCompletion } from './comment-only-final-round-completion.mjs';
import { readRemediationReplyArtifact } from './follow-up-jobs.mjs';
import { auditWorkspaceForContamination } from './remediation-git-pr-io.mjs';
import { parseHqWorkerWorkspaceFromPayload, resolveHqWorkerWorkspace } from './remediation-hq-dispatch.mjs';
import { buildReconcileCommentDelivery } from './adapters/comms/github-pr-comments/comment-delivery.mjs';

export async function proveStoppedPublication({ job, jobPath, headSha, ciGate, execFileImpl, log = console }) {
  if (job?.status !== 'stopped' || job.remediationPlan?.stop?.code !== 'committed-unpublished'
    || !job.baseBranch || typeof execFileImpl !== 'function') return null;
  const sourceDigest = recoveryDigest(job);
  const worker = job.remediationWorker || {};
  const workspaceDir = job.unpublishedWork?.workspaceDir || parseHqWorkerWorkspaceFromPayload(worker)
    || await resolveHqWorkerWorkspace({ worker, execFileImpl });
  if (!workspaceDir) return null;
  const push = await proveFinalRoundWorkerPush({ repo: job.repo, prNumber: job.prNumber,
    jobId: job.jobId, reviewedHead: job.revisionRef, baseBranch: job.baseBranch,
    workspaceDir, liveHeadSha: headSha, execFileImpl, log });
  if (push.workerPushedHeadSha !== headSha) return null;
  let completion = null;
  let commentDelivery = null;
  if (job.finalRound === 'comment-only' && job.reReview?.suppressed === 'comment-only-final-round') {
    // Preserve the reply's actual findings and human-owned blockers. Publication
    // alone cannot turn a partial or invalid reply into a completed final round.
    let reply;
    try {
      reply = readRemediationReplyArtifact(job.remediationReply?.path || worker.replyPath, { expectedJob: job });
    } catch { /* A missing reply may still use a remaining ordinary round. */ }
    if (reply) completion = await resolveCommentOnlyFinalRoundCompletion({ job, jobPath, reply, workspaceDir,
      execFileImpl, log, retryDelaysMs: [], auditWorkspaceForContaminationImpl: auditWorkspaceForContamination,
      inspectRemediationCiRegressionImpl: async () => ciGate,
      writeJobImpl: () => { throw new Error('publication-recovery-cannot-rewrite-source'); } });
    if (completion?.completed === true && completion.workerPushedHeadSha === headSha) {
      commentDelivery = buildReconcileCommentDelivery({ job, worker, action: 'completed', reply,
        reReview: { ...job.reReview, requested: false } }).commentDelivery;
    }
  }
  return { sourceDigest, headSha, proof: push.proof,
    completedFinalRound: completion?.completed === true && completion.workerPushedHeadSha === headSha,
    completionFields: completion?.completionFields || {}, commentDelivery };
}
