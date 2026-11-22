import { findFinalRemediationPushJob, isCompletedCommentOnlyFinalRoundJob, scanPrFollowUpJobs } from '../comment-only-final-round.mjs';
import { isRemediationRoundBudgetSpent } from '../remediation-round-recovery.mjs';
import { isFinalRemediatorHead, exactHeadReviewRequestId } from './exact-head-review-proof.mjs';

const SHA = /^[0-9a-f]{40}$/iu;

// MRQ-11 D2: a comment-only final round records its push as
// completion.workerPushedHeadSha without the finalRemediationPush marker (the
// closeout writer excludes comment-only rounds). Its head is a final remediator
// head the reviewer never re-reviews, exactly like a marked final push.
function commentOnlyFinalRoundPushJob(rootDir, { repo, prNumber, headSha }) {
  return scanPrFollowUpJobs(rootDir, 'completed', repo, prNumber)
    .filter(job => isCompletedCommentOnlyFinalRoundJob(job) && job.completion?.workerPushedHeadSha === headSha)
    .sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')))[0] || null;
}

const provable = job => Boolean(job) && job.status === 'completed' && !job.closureHandoff
  && isRemediationRoundBudgetSpent(job.remediationPlan) && Boolean(job.jobId);

// A worker's independently recorded publication proves authorship. Neither a
// commit login nor the broad legacy "hammer owns this head" route is proof.
export function readFinalRemediatorHead({ rootDir, repo, prNumber, headSha }) {
  if (!SHA.test(String(headSha || ''))) return null;
  let job = findFinalRemediationPushJob(rootDir, { repo, prNumber, headSha });
  let kind = 'remediation-push';
  if (!provable(job)) {
    job = commentOnlyFinalRoundPushJob(rootDir, { repo, prNumber, headSha });
    kind = 'comment-only-final-round-push';
  }
  if (!provable(job)) return null;
  return { repo, prNumber: Number(prNumber), headSha, jobId: job.jobId,
    currentRound: Number(job.remediationPlan.currentRound), maxRounds: Number(job.remediationPlan.maxRounds),
    suppressed: true, sourceRef: `${kind}:${job.jobId}:${headSha}` };
}

// Local queue API only. Its IMMEDIATE transaction coalesces pending requests
// from other paths and retains consumed/refused receipts across restarts.
export function createExactHeadReviewSurface({ rootDir, requestRereview = null } = {}) {
  const inspect = ({ subjectKey, revisionRef }) => {
    if (subjectKey?.domainId !== 'code-pr') return null;
    const match = /^(.*)#([1-9][0-9]*)$/.exec(subjectKey.subjectExternalId);
    return match ? readFinalRemediatorHead({ rootDir, repo: match[1],
      prNumber: Number(match[2]), headSha: revisionRef }) : null;
  };
  return { inspect, async request({ subjectKey, revisionRef, observedAt }) {
    // Shadow imports the proof reader too. Loading the mutation API eagerly
    // would re-enter the legacy daemon/closure import cycle during observation.
    const state = await import('../review-state.mjs');
    const request = requestRereview ?? state.requestReviewRereview;
    // Recheck the narrow durable proof at issuance, even for a replay.
    const proof = inspect({ subjectKey, revisionRef });
    if (!isFinalRemediatorHead(proof, subjectKey, revisionRef)) {
      return { triggered: false, status: 'blocked', reason: 'final-remediator-head-unproven' };
    }
    const db = state.openReviewStateDb(rootDir);
    try {
      state.ensureReviewStateSchema(db);
      return db.transaction(() => {
        // Do not reset a verdict that arrived after the executor's refresh.
        // The check and the existing queue API share one write transaction.
        const row = state.getReviewRow(db, { repo: proof.repo, prNumber: proof.prNumber });
        if (row?.review_status === 'posted' && row.reviewer_head_sha === revisionRef) {
          return { triggered: false, status: 'blocked', reason: 'verdict-at-requested-head' };
        }
        return request({ rootDir, repo: proof.repo, prNumber: proof.prNumber, db, inTransaction: true,
          requestedAt: observedAt, targetRevisionRef: revisionRef, preserveBudgets: true,
          reason: 'retrigger-review: final remediator head requires strict exact-head review',
          explicitReviewRequest: { requestId: exactHeadReviewRequestId(revisionRef), actor: 'finalization-v2' } });
      }).immediate();
    } finally { db.close(); }
  } };
}
