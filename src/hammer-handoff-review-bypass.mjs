import { DELIVERED_REVIEW_SQL } from './reviewer-pass-posted-review-sql.mjs';
import { readAmaCloserLease } from './ama/closer-lease.mjs';
import { isOrphanHeadReviewRequested } from './orphan-head-review-requested.mjs';

export function hammerHandoffReviewBypass({ db, rootDir, repo, prNumber, headSha, row }) {
  if (!isOrphanHeadReviewRequested(row, headSha)) return false;
  const lease = readAmaCloserLease(rootDir, { repo, prNumber, headSha });
  if (lease?.status !== 'handed-to-review') return false;
  // The handoff authorizes one attempt after transfer, never an unbounded
  // quota-error retry loop. A delivered same-head review also survives a later
  // lease transfer; a new lease timestamp cannot authorize reviewing it twice.
  return !db.prepare(`SELECT 1 FROM reviewer_passes WHERE repo=? AND pr_number=?
    AND head_sha=? AND (julianday(started_at)>=julianday(?) OR
      (status='completed' AND pass_kind IN ('first-pass','rereview') AND ${DELIVERED_REVIEW_SQL})) LIMIT 1`).get(repo, prNumber, headSha, lease.updatedAt);
}
