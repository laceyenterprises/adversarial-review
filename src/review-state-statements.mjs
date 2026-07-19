export const MARK_ATTEMPT_STARTED_SQL = `UPDATE reviewed_prs
     SET review_status = 'reviewing',
         last_attempted_at = ?,
         reviewer_session_uuid = ?,
         reviewer_started_at = NULL,
         reviewer_head_sha = ?,
         reviewer_timeout_ms = ?,
         reviewer_lease_expires_at = ?,
         reviewer_pgid = NULL,
         failed_at = CASE
           WHEN review_status = 'pending-upstream' THEN failed_at
           ELSE NULL
         END,
         failure_message = CASE
           WHEN review_status = 'pending-upstream' THEN failure_message
           ELSE NULL
         END,
         quota_reset_at_utc = NULL
   WHERE repo = ?
     AND pr_number = ?
     AND review_status IN ('pending', 'pending-upstream')
     -- SEV1 (2026-07-19): never (re)claim a review for a MERGED PR. Merged PRs
     -- can be stuck at review_status='pending' (their cross-model review never
     -- posted — high Gemini failure rate); without this guard the CAS re-claims
     -- + re-spawns a reviewer for them every tick FOREVER (6,049 spawns / 2,482
     -- merged-but-pending rows / ~5 Gemini procs on 0 open PRs). Guard on
     -- 'merged' specifically (NOT all non-open): merged is permanent, so pr_state
     -- can't be a stale value racing the post-claim lifecycle sync — whereas a
     -- 'closed' PR can be reopened, and the claim runs before that tick's sync,
     -- so blocking 'closed' here would wrongly defer a reopened PR by a tick.
     -- COALESCE treats a NULL pr_state as open so a legitimate PR is never skipped.
     AND COALESCE(pr_state, 'open') != 'merged'`;

export const MARK_MERGED_PENDING_REVIEW_SKIPPED_SQL = `UPDATE reviewed_prs
      SET review_status = 'skipped',
          failed_at = NULL,
          failure_message = ?,
          quota_reset_at_utc = NULL,
          reviewer_session_uuid = NULL,
          reviewer_started_at = NULL,
          reviewer_head_sha = NULL,
          reviewer_timeout_ms = NULL,
          reviewer_lease_expires_at = NULL,
          reviewer_pgid = NULL,
          merged_at = COALESCE(merged_at, ?)
    WHERE repo = ?
      AND pr_number = ?
      AND pr_state = 'merged'
      AND review_status IN ('pending', 'pending-upstream')`;

export function prepareMarkAttemptStarted(db) {
  return db.prepare(MARK_ATTEMPT_STARTED_SQL);
}

export function prepareMarkMergedPendingReviewSkipped(db) {
  return db.prepare(MARK_MERGED_PENDING_REVIEW_SKIPPED_SQL);
}
