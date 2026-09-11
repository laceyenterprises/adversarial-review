import { REREVIEW_CI_BLOCKED_STATUS } from './review-statuses.mjs';

export const MARK_ATTEMPT_STARTED_SQL = `UPDATE reviewed_prs
     SET review_status = 'reviewing',
         last_attempted_at = ?,
         reviewer_session_uuid = ?,
         reviewer_started_at = NULL,
         reviewer_head_sha = ?,
         revision_ref = COALESCE(?, revision_ref),
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

export const MARK_REREVIEW_CI_BLOCKED_SQL = `UPDATE reviewed_prs
      SET review_status = '${REREVIEW_CI_BLOCKED_STATUS}',
          failed_at = ?,
          failure_message = ?,
          last_attempted_at = ?,
          reviewer_session_uuid = NULL,
          reviewer_started_at = NULL,
          reviewer_head_sha = COALESCE(?, reviewer_head_sha),
          revision_ref = COALESCE(?, revision_ref),
          reviewer_timeout_ms = NULL,
          reviewer_lease_expires_at = NULL,
          reviewer_pgid = NULL,
          quota_reset_at_utc = NULL
    WHERE reviewer_session_uuid = ?
      AND repo = ?
      AND pr_number = ?
      AND review_status = 'reviewing'`;

export const MARK_REREVIEW_CI_BLOCKED_RECHECK_SQL = `UPDATE reviewed_prs
      SET last_attempted_at = ?
    WHERE repo = ?
      AND pr_number = ?
      AND review_status = '${REREVIEW_CI_BLOCKED_STATUS}'`;

export const MARK_INFRA_AUTO_RECOVERY_ATTEMPT_STARTED_SQL =
  `UPDATE reviewed_prs
     SET review_status = 'reviewing',
         last_attempted_at = ?,
         reviewer_session_uuid = ?,
         reviewer_started_at = NULL,
         reviewer_head_sha = ?,
         revision_ref = COALESCE(?, revision_ref),
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
     AND (COALESCE(infra_auto_recover_attempts, 0) < ? OR ? = 1)
     AND CASE ?
       WHEN 'cascade' THEN (
         lower(COALESCE(failure_message, '')) LIKE '[cascade]%' OR
         lower(COALESCE(failure_message, '')) LIKE '%litellm/upstream cascade%' OR
         lower(COALESCE(failure_message, '')) LIKE '%watcher backoff engaged%'
       )
       WHEN 'provider-overloaded' THEN lower(COALESCE(failure_message, '')) LIKE '[provider-overloaded]%'
       WHEN 'reviewer-timeout' THEN lower(COALESCE(failure_message, '')) LIKE '[reviewer-timeout]%'
       WHEN 'reviewer-output' THEN lower(COALESCE(failure_message, '')) LIKE '[reviewer-output]%'
       WHEN 'attestation-sign-failed' THEN lower(COALESCE(failure_message, '')) LIKE '[attestation-sign-failed]%'
       WHEN 'hcp-unavailable' THEN lower(COALESCE(failure_message, '')) LIKE '[hcp-unavailable]%'
       WHEN 'launchctl-bootstrap' THEN (
         lower(COALESCE(failure_message, '')) LIKE '[launchctl-bootstrap]%' OR
         lower(COALESCE(failure_message, '')) LIKE '%claude launchctl session bootstrap failed%' OR
         lower(COALESCE(failure_message, '')) LIKE '%launchctlsessionerror%'
       )
      WHEN 'oauth-broken' THEN (
        lower(COALESCE(failure_message, '')) LIKE '%[oauth-broken]%' OR
        lower(COALESCE(failure_message, '')) LIKE '%bad credentials%' OR
        lower(COALESCE(failure_message, '')) LIKE '%401%unauthorized%' OR
        lower(COALESCE(failure_message, '')) LIKE '%requires authentication%'
      )
       WHEN 'quota-exhausted' THEN lower(COALESCE(failure_message, '')) LIKE '[quota-exhausted]%'
       WHEN 'reviewer-command-failed' THEN (
         (
           lower(COALESCE(failure_message, '')) LIKE '[unknown] command failed%' AND
           lower(COALESCE(failure_message, '')) NOT LIKE '[unknown] command failed with code %'
         ) OR
         lower(COALESCE(failure_message, '')) LIKE '[unknown] command failed with code %'
       )
       WHEN 'github-review-create-transient' THEN (
         lower(COALESCE(failure_message, '')) LIKE '[github-review-create-transient]%' OR
         (
           (
             lower(COALESCE(failure_message, '')) LIKE '%pulls/%/reviews%' OR
             lower(COALESCE(failure_message, '')) LIKE '%create-a-review-for-a-pull-request%' OR
             lower(COALESCE(failure_message, '')) LIKE '%review-create%'
           ) AND
           (
             lower(COALESCE(failure_message, '')) LIKE '%http 403%' OR
             lower(COALESCE(failure_message, '')) LIKE '%http 429%' OR
             lower(COALESCE(failure_message, '')) LIKE '%status 403%' OR
             lower(COALESCE(failure_message, '')) LIKE '%status 429%' OR
             lower(COALESCE(failure_message, '')) LIKE '%http 5__%' OR
             lower(COALESCE(failure_message, '')) LIKE '%status 5__%'
           )
         )
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

export function prepareMarkRereviewCiBlocked(db) {
  return db.prepare(MARK_REREVIEW_CI_BLOCKED_SQL);
}

export function prepareMarkRereviewCiBlockedRecheck(db) {
  return db.prepare(MARK_REREVIEW_CI_BLOCKED_RECHECK_SQL);
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

// Depth of the first-pass review queue: OPEN PRs that have never received a
// first-pass review. Lives in this side-effect-free statements leaf (rather than
// beside its prepared statement in review-state-db.mjs) so tests, the RSP-01
// queue-depth lever, and the `review-queue-depth` operator CLI can all read the
// EXACT SQL production issues without importing the process-wide singleton DB
// handle — the same reason every other statement here was extracted.
export const SQL_COUNT_OPEN_AWAITING_FIRST_PASS_REVIEW =
  "SELECT COUNT(*) AS n FROM reviewed_prs " +
  "WHERE pr_state = 'open' " +
  // Malformed-title, legacy unroutable-bot, and Argus-routed PRs are not
  // awaiting a first pass: the dispatch loop returns early on all three, so
  // none can receive one. Counting them kept the "Reviews stalled" pager above
  // zero forever and produced pages naming PRs the reviewer will never touch.
  //
  // ASR-04 replaced the terminal `unroutable-bot-author` disposition with
  // `argus-security-queued`, which is NOT terminal — the row stays live so a new
  // head re-enqueues. It is excluded here anyway, and for the same reason: the
  // adversarial lane is not the thing it is waiting for. Argus queue depth and
  // `oldestPendingAgeMs` are where a stuck security review surfaces; an
  // adversarial stall pager that also fires on them would report the wrong
  // outage on the wrong dashboard. The legacy status stays in the list because
  // reopened PRs and kill-switch rows can still carry it.
  // This is not the same as trusting review_status='posted' -- the comment
  // above deliberately keys success off gh_comment_id so a stale success claim
  // cannot mask a real gap. Here we exclude work the pipeline has explicitly
  // refused, which is evidence about the PR, not about reviewer health.
  // SQLite's `NOT IN` drops NULL, so keep the null-safe shape explicit: exclude
  // terminal refused states while still counting rows with no status yet -- the
  // exact rows most likely to be genuinely awaiting a first pass.
  `AND (review_status IS NULL OR review_status NOT IN ('malformed', 'unroutable-bot-author', 'argus-security-queued', '${REREVIEW_CI_BLOCKED_STATUS}')) ` +
  "AND NOT EXISTS ( " +
  "  SELECT 1 FROM reviewer_passes " +
  "  WHERE reviewer_passes.repo = reviewed_prs.repo " +
  "    AND reviewer_passes.pr_number = reviewed_prs.pr_number " +
  "    AND reviewer_passes.gh_comment_id IS NOT NULL " +
  "    AND reviewer_passes.gh_comment_id <> ''" +
  ")";
