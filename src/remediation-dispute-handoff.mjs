import { allBlockingDisputed, validateRemediationReply } from './kernel/remediation-reply.mjs';
import { evidenceDigest, resolveHammerAdjudication } from './ama/hammer-adjudication.mjs';

export const DISPUTED_COMPLETION = 'blocking-findings-disputed-with-evidence';
export const DISPUTE_REVIEW_REASON = 'disputed-findings-review';

// The reconciler's completed round proves it observed an unchanged open head.
// Match the currently authoritative body as well as the head. A later review
// can repeat the same body and must retain its own findings and remediation.
export function disputeHandoff(job, review, head) {
  if (!head || review?.headSha !== head || review.verdict !== 'request-changes'
    || job?.status !== 'completed' || job.revisionRef !== head
    || job.reReview?.reason !== DISPUTED_COMPLETION || job.reReview.status !== 'suppressed'
    || job.reReview.requested !== false || !Number.isFinite(Date.parse(job.completedAt))
    || (review.postedAt && Date.parse(review.postedAt) > Date.parse(job.completedAt))
    || review.reviewBodySha256 !== evidenceDigest(job.reviewBody)) return null;
  const round = job.remediationPlan?.rounds?.find(entry => entry.round === job.remediationPlan.currentRound);
  if (round?.state !== 'completed' || round.resultingHeadSha !== head) return null;
  let reply;
  try { reply = validateRemediationReply(round.remediationReply?.payload, { expectedJob: job }); }
  catch { return null; }
  if (!allBlockingDisputed(job, reply, head)
    || resolveHammerAdjudication({ ...review, reviewedHead: head, currentHead: head },
      review.hammerWithdrawnFindings).allBlockingWithdrawn) return null;
  return { headSha: head, completedAt: job.completedAt, jobId: job.jobId };
}
