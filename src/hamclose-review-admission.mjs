import { readAmaCloserLease } from './ama/closer-lease.mjs';
import { isOrphanHeadReviewRequested, isExplicitOperatorReviewRetrigger } from './first-pass-review-suppression.mjs';

// Only a delivered review spends the PR-wide ceiling. A successful process
// exit without a GitHub review is still just an attempt.
export function postedReviewCeilingReached({ db, repo, prNumber, ceiling }) {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM reviewer_passes
    WHERE repo=? AND pr_number=? AND pass_kind IN ('first-pass','rereview')
    AND status='completed' AND gh_comment_id IS NOT NULL AND gh_comment_id<>''`).get(repo, prNumber);
  return Number(row.count) >= ceiling;
}

export function hammerHandoffReviewBypass({ db, rootDir, repo, prNumber, headSha, row }) {
  if (!isOrphanHeadReviewRequested(row, headSha)) return false;
  const lease = readAmaCloserLease(rootDir, { repo, prNumber, headSha });
  if (lease?.status !== 'handed-to-review') return false;
  // The handoff authorizes one attempt after transfer, never an unbounded
  // quota-error retry loop. The normal reviewer claim CAS remains unchanged.
  return !db.prepare(`SELECT 1 FROM reviewer_passes WHERE repo=? AND pr_number=?
    AND head_sha=? AND started_at>=? LIMIT 1`).get(repo, prNumber, headSha, lease.updatedAt);
}

export function routeCappedReviewToClosure({ db, repo, prNumber, headSha, row, ceiling }) {
  if (!row || ['reviewing', 'malformed', 'failed-orphan'].includes(row.review_status)
    || isExplicitOperatorReviewRetrigger(row) || isOrphanHeadReviewRequested(row, headSha)
    || !postedReviewCeilingReached({ db, repo, prNumber, ceiling })) return false;
  const posted = db.prepare(`SELECT head_sha, ended_at FROM reviewer_passes
    WHERE repo=? AND pr_number=? AND status='completed'
    AND pass_kind IN ('first-pass','rereview') AND head_sha IS NOT NULL
    AND gh_comment_id IS NOT NULL AND gh_comment_id<>''
    ORDER BY ended_at DESC, pass_id DESC LIMIT 1`).get(repo, prNumber);
  if (!posted || posted.head_sha === headSha) return false;
  return db.prepare(`UPDATE reviewed_prs SET review_status='posted',
    reviewer_head_sha=?, posted_at=?, rereview_reason='system-review-ceiling-closure'
    WHERE repo=? AND pr_number=? AND review_status IN ('posted','pending','pending-upstream','failed')`)
    .run(posted.head_sha, posted.ended_at, repo, prNumber).changes === 1;
}
