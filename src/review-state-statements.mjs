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
         quota_reset_at_utc = NULL,
         review_attempts = CASE
           WHEN review_status = 'pending'
             AND failed_at IS NOT NULL
             AND reviewer_head_sha IS NOT NULL
             AND COALESCE(reviewer_head_sha, '') != COALESCE(?, '')
             THEN 0
           ELSE review_attempts
         END
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

export const MARK_INFRA_AUTO_RECOVERY_ATTEMPT_STARTED_SQL =
  `UPDATE reviewed_prs
     SET review_status = 'reviewing',
         last_attempted_at = ?,
         reviewer_session_uuid = ?,
         reviewer_started_at = NULL,
         reviewer_head_sha = ?,
         reviewer_timeout_ms = ?,
         reviewer_lease_expires_at = ?,
         reviewer_pgid = NULL,
         failed_at = NULL,
         failure_message = NULL,
         quota_reset_at_utc = NULL,
         infra_auto_recover_attempts = COALESCE(infra_auto_recover_attempts, 0) + 1
   WHERE repo = ?
     AND pr_number = ?
     AND (
       review_status = 'failed' OR
       (
         review_status = 'pending' AND
         failed_at = ? AND
         reviewer_head_sha = ?
       )
     )
     AND COALESCE(infra_auto_recover_attempts, 0) < ?
     AND CASE ?
       WHEN 'cascade' THEN (
         lower(COALESCE(failure_message, '')) LIKE '[cascade]%' OR
         lower(COALESCE(failure_message, '')) LIKE '%litellm/upstream cascade%' OR
         lower(COALESCE(failure_message, '')) LIKE '%watcher backoff engaged%'
       )
       WHEN 'provider-overloaded' THEN lower(COALESCE(failure_message, '')) LIKE '[provider-overloaded]%'
       WHEN 'reviewer-timeout' THEN lower(COALESCE(failure_message, '')) LIKE '[reviewer-timeout]%'
       WHEN 'reviewer-output' THEN lower(COALESCE(failure_message, '')) LIKE '[reviewer-output]%'
       WHEN 'launchctl-bootstrap' THEN (
         lower(COALESCE(failure_message, '')) LIKE '[launchctl-bootstrap]%' OR
         lower(COALESCE(failure_message, '')) LIKE '%claude launchctl session bootstrap failed%' OR
         lower(COALESCE(failure_message, '')) LIKE '%launchctlsessionerror%'
       )
       WHEN 'oauth-broken' THEN lower(COALESCE(failure_message, '')) LIKE '%[oauth-broken]%'
       WHEN 'quota-exhausted' THEN lower(COALESCE(failure_message, '')) LIKE '[quota-exhausted]%'
       WHEN 'reviewer-command-failed' THEN (
         (
           lower(COALESCE(failure_message, '')) LIKE '[unknown] command failed%' AND
           lower(COALESCE(failure_message, '')) NOT LIKE '[unknown] command failed with code %'
         ) OR
         lower(COALESCE(failure_message, '')) LIKE '[unknown] command failed with code %'
       )
       ELSE 0
     END`;

export const MARK_REVIEWER_COMMAND_FAILED_RECOVERED_POSTED_SQL =
  `UPDATE reviewed_prs
      SET review_status = 'posted',
          posted_at = ?,
          failed_at = NULL,
          failure_message = NULL,
          quota_reset_at_utc = NULL,
          review_attempts = review_attempts + 1,
          reviewer_lease_expires_at = NULL,
          infra_auto_recover_attempts = 0
    WHERE repo = ?
      AND pr_number = ?
      AND review_status IN ('failed', 'pending')
      AND reviewer_session_uuid = ?
      AND reviewer_started_at = ?
      AND lower(COALESCE(failure_message, '')) LIKE '[unknown] command failed%'`;

export const FINALIZE_PENDING_TERMINAL_FAILURE_SQL =
  `UPDATE reviewed_prs
      SET review_status = 'failed',
          reviewer_lease_expires_at = NULL
    WHERE repo = ?
      AND pr_number = ?
      AND review_status = 'pending'
      AND failed_at = ?
      AND failure_message IS ?
      AND reviewer_head_sha = ?`;

// This also matches review_status='reviewing', so every reviewer_* lease field
// must be cleared when the merged PR is terminalized to skipped.
export const MARK_MERGED_PENDING_REVIEW_SKIPPED_SQL = `UPDATE reviewed_prs
      SET review_status = 'skipped',
          failed_at = NULL,
          failure_message = ?,
          quota_reset_at_utc = NULL,
          reviewer_session_uuid = NULL,
          reviewer_head_sha = NULL,
          reviewer_timeout_ms = NULL,
          reviewer_lease_expires_at = NULL,
          reviewer_started_at = NULL,
          reviewer_pgid = NULL,
          merged_at = COALESCE(merged_at, ?)
    WHERE repo = ?
      AND pr_number = ?
      AND pr_state = 'merged'
      AND review_status IN ('pending', 'pending-upstream', 'reviewing')`;

// ASR-04 — the disposition that replaces the terminal `unroutable-bot-author`
// write, plus the backfill that recovers the rows it already produced.
//
// The SQL lives here rather than inline in review-state-db.mjs so the tests can
// import the EXACT string production runs. A test that re-types the query proves
// only that the test's copy works; the pipeline has already paid for that lesson
// once, on the merged-PR claim CAS.

// Deliberately NOT terminal, and each field says so. `failed_at` is cleared
// because nothing failed. `review_attempts` is left alone because no adversarial
// attempt was made, and burning the retry budget on a PR the lane never
// dispatched would be double-counting. `failure_message` carries the routing
// note, mirroring MARK_MERGED_PENDING_REVIEW_SKIPPED_SQL's use of the same
// column for a non-failure explanation — it is the only operator-visible
// free-text field on the row, and leaving it empty would leave "why is this not
// being reviewed?" unanswered.
export const MARK_ARGUS_SECURITY_QUEUED_SQL = `UPDATE reviewed_prs
      SET reviewer = 'argus-security',
          review_status = 'argus-security-queued',
          failed_at = NULL,
          failure_message = ?,
          last_attempted_at = ?
    WHERE repo = ?
      AND pr_number = ?`;

// The memo of the head whose security surface has already been classified. A
// cache, never an authority: a new head leaves it stale and re-classifies, so
// losing it costs GitHub calls and can never cost a review.
export const RECORD_ARGUS_CLASSIFIED_HEAD_SQL =
  'UPDATE reviewed_prs SET argus_classified_head_sha = ? WHERE repo = ? AND pr_number = ?';

// Scoped to OPEN PRs on purpose. A merged or closed row carrying the old status
// is history, not a stranding, and rewriting it would churn state no gate reads
// on the exact class of already-terminal PR this pipeline has been burned by
// acting on before.
export const SELECT_OPEN_UNROUTABLE_BOT_ROWS_SQL = `SELECT repo, pr_number, revision_ref, reviewed_at, failure_message
     FROM reviewed_prs
    WHERE pr_state = 'open'
      AND review_status = 'unroutable-bot-author'
    ORDER BY repo ASC, pr_number ASC`;

// Guarded on the old status so a concurrent watcher tick that already recovered
// the row wins instead of being overwritten, and so a re-run is a no-op rather
// than a second rewrite. `argus_classified_head_sha` is CLEARED, not set: the
// backfill deliberately does not fabricate a queue entry for a head it never
// read, so it leaves the row in the exact state the live route treats as
// "classify and enqueue this on the next tick".
export const BACKFILL_UNROUTABLE_BOT_TO_ARGUS_QUEUED_SQL = `UPDATE reviewed_prs
      SET reviewer = 'argus-security',
          review_status = 'argus-security-queued',
          failed_at = NULL,
          failure_message = ?,
          argus_classified_head_sha = NULL
    WHERE repo = ?
      AND pr_number = ?
      AND pr_state = 'open'
      AND review_status = 'unroutable-bot-author'`;

export function prepareMarkAttemptStarted(db) {
  return db.prepare(MARK_ATTEMPT_STARTED_SQL);
}

export function prepareMarkInfraAutoRecoveryAttemptStarted(db) {
  return db.prepare(MARK_INFRA_AUTO_RECOVERY_ATTEMPT_STARTED_SQL);
}

export function prepareMarkReviewerCommandFailedRecoveredPosted(db) {
  return db.prepare(MARK_REVIEWER_COMMAND_FAILED_RECOVERED_POSTED_SQL);
}

export function prepareFinalizePendingTerminalFailure(db) {
  return db.prepare(FINALIZE_PENDING_TERMINAL_FAILURE_SQL);
}

export function prepareMarkMergedPendingReviewSkipped(db) {
  return db.prepare(MARK_MERGED_PENDING_REVIEW_SKIPPED_SQL);
}
