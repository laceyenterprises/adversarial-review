import Database from 'better-sqlite3';
import { join } from 'node:path';
import { REVIEWER_PASS_GENUINE_POSTED_REVIEW_WHERE_SQL } from './reviewer-pass-posted-review-sql.mjs';

// REBASECURRENCY-01: this is routing evidence, never merge authority. Read the
// review owner's store without migrating it or changing a review/lease.
export function conflictOwnerReviewRoute({ rootDir, repo, prNumber, headSha }) {
  const db = new Database(join(rootDir, 'data', 'reviews.db'), { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      const row = db.prepare(`SELECT review_status, reviewer_head_sha FROM reviewed_prs
        WHERE repo = ? COLLATE NOCASE AND pr_number = ?`).get(repo, prNumber);
      if (row?.review_status === 'reviewing' && (!row.reviewer_head_sha
        || row.reviewer_head_sha.toLowerCase() === headSha.toLowerCase())) {
        return { route: 'review-in-flight', headSha };
      }
      // Any delivered verdict qualifies, including request-changes and comment-only.
      // A failed attempt without a delivered review is not a settled verdict.
      const settled = db.prepare(`SELECT head_sha FROM reviewer_passes
        WHERE repo = ? COLLATE NOCASE AND pr_number = ? AND pass_kind IN ('first-pass', 'rereview')
          AND ${REVIEWER_PASS_GENUINE_POSTED_REVIEW_WHERE_SQL}
        ORDER BY COALESCE(body_captured_at, ended_at) DESC, pass_id DESC LIMIT 1`).get(repo, prNumber);
      // posted also covers legacy rows predating pass capture. Pending/failed
      // rows can still have an earlier delivered pass, found above.
      return { route: settled || row?.review_status === 'posted' ? 'hammer' : 'pr-update', headSha };
    })();
  } finally {
    db.close();
  }
}
