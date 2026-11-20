// Recover publication debt only from the same structural proof as completion.
// The queue writer compares the full source snapshot under its existing lock.
import { recoveryDigest } from './comment-only-recovery-record.mjs';
import { proveFinalRoundWorkerPush } from './comment-only-final-round.mjs';
import { resolveCommentOnlyFinalRoundCompletion } from './comment-only-final-round-completion.mjs';
import { readRemediationReplyArtifact } from './follow-up-jobs.mjs';
import { auditWorkspaceForContamination } from './remediation-git-pr-io.mjs';
import { hqPublicationWorker, resolvePublicationWorkspace } from './remediation-publication-workspace.mjs';
import { buildReconcileCommentDelivery } from './adapters/comms/github-pr-comments/comment-delivery.mjs';

export async function proveStoppedPublication({ job, jobPath, headSha, ciGate, execFileImpl, log = console }) {
  if (job?.status !== 'stopped' || job.remediationPlan?.stop?.code !== 'committed-unpublished'
    || !job.baseBranch || !/^[a-f0-9]{40}$/iu.test(headSha || '') || typeof execFileImpl !== 'function') return null;
  const sourceDigest = recoveryDigest(job);
  const hqWorker = hqPublicationWorker(job);
  const worker = hqWorker || job.remediationWorker || {};
  const retainedCommit = job.unpublishedWork?.commitSha;
  if (hqWorker && (typeof retainedCommit !== 'string' || !/^[a-f0-9]{7,40}$/iu.test(retainedCommit))) return null;
  const expectedLocalHead = hqWorker ? retainedCommit.toLowerCase() : null;
  const workspaceDir = await resolvePublicationWorkspace({ job, execFileImpl, log,
    workspaceDir: job.unpublishedWork?.workspaceDir || worker.workspaceDir });
  if (!workspaceDir) return null;
  const push = await proveFinalRoundWorkerPush({ repo: job.repo, prNumber: job.prNumber,
    jobId: job.jobId, reviewedHead: job.revisionRef, baseBranch: job.baseBranch,
    workspaceDir, liveHeadSha: headSha, publicationBranch: hqWorker ? job.branch : null,
    expectedLocalHead, execFileImpl, log });
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
      expectedLocalHead, execFileImpl, log, retryDelaysMs: [], auditWorkspaceForContaminationImpl: auditWorkspaceForContamination,
      inspectRemediationCiRegressionImpl: async () => ciGate,
      writeJobImpl: () => { throw new Error('publication-recovery-cannot-rewrite-source'); } });
    if (completion && completion.workerPushedHeadSha !== headSha) return null;
    if (completion?.completed === true) {
      commentDelivery = buildReconcileCommentDelivery({ job, worker, action: 'completed', reply,
        reReview: { ...job.reReview, requested: false } }).commentDelivery;
    }
  }
  return { sourceDigest, headSha, proof: push.proof, ...(hqWorker ? { workspaceDir } : {}),
    completedFinalRound: completion?.completed === true && completion.workerPushedHeadSha === headSha,
    completionFields: completion?.completionFields || {}, commentDelivery };
}
