// Repair only the historical posted-without-head shape observed on this exact
// live head. The status CAS makes repeated polls a no-op after the first repair.
export function requeuePostedReviewWithoutHead({ db, repo, prNumber, headSha,
  now = new Date().toISOString(), logger = console }) {
  if (!headSha) return false;
  const orphanReason = `system-orphan-head-review:${headSha}`;
  const result = db.prepare(`UPDATE reviewed_prs
      SET review_status = 'pending', posted_at = NULL,
          reviewer_session_uuid = NULL, reviewer_pgid = NULL,
          reviewer_started_at = NULL, reviewer_head_sha = NULL,
          reviewer_timeout_ms = NULL, reviewer_lease_expires_at = NULL,
          failed_at = NULL, failure_message = NULL, quota_reset_at_utc = NULL,
          rereview_requested_at = CASE
            WHEN rereview_reason = ? AND rereview_requested_at IS NOT NULL THEN rereview_requested_at
            ELSE ? END,
          rereview_reason = CASE
            WHEN rereview_reason = ? AND rereview_requested_at IS NOT NULL THEN rereview_reason
            ELSE ? END
    WHERE repo = ? AND pr_number = ? AND pr_state = 'open'
      AND review_status = 'posted'
      AND NULLIF(TRIM(reviewer_head_sha), '') IS NULL
      AND revision_ref = ?`).run(orphanReason, now, orphanReason,
    `system-missing-reviewed-head:${headSha}`, repo, prNumber, headSha);
  if (result.changes !== 1) return false;
  logger.warn?.(`[watcher] posted-review-missing-head-requeued repo=${repo} pr=${prNumber} head=${headSha} `
    + 'without charging review attempts or changing recovery budgets');
  return true;
}
