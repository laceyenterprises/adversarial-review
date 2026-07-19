// review-state-db.mjs — shared review-state SQLite handle + prepared statements.
//
// ARC-18: extracted verbatim from watcher.mjs. This module owns the single
// process-wide review-state `db` handle and every prepared statement built
// against it, in the original declaration order. watcher.mjs (and later
// stmt-coupled extractions) import these handles back. This module MUST NEVER
// call db.close(); the handle lives for the process lifetime, exactly as the
// original module-level watcher handle did.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureReviewStateSchema, openReviewStateDb } from './review-state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const db = openReviewStateDb(ROOT);
ensureReviewStateSchema(db);

export const stmtGetReviewRow = db.prepare(
  'SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
);
export const stmtGetLatestPostedReviewBody = db.prepare(
  `SELECT body_md
     FROM reviewer_passes
    WHERE repo = ?
      AND pr_number = ?
      AND pass_kind IN ('first-pass', 'rereview')
      AND body_md IS NOT NULL
    ORDER BY attempt_number DESC, pass_id DESC
    LIMIT 1`
);
export const stmtCreateReviewRow = db.prepare(
  `INSERT OR IGNORE INTO reviewed_prs (
     repo, pr_number, domain_id, subject_external_id, revision_ref,
     reviewed_at, reviewer, pr_state, linear_ticket, review_status,
     review_attempts, labels_json
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
);
export const stmtCreateFastMergeSkippedReviewRow = db.prepare(
  `INSERT OR IGNORE INTO reviewed_prs (
     repo, pr_number, domain_id, subject_external_id, revision_ref,
     reviewed_at, reviewer, pr_state, linear_ticket, review_status,
     review_attempts, labels_json, fast_merge_authorized_head_sha,
     fast_merge_audit_status, fast_merge_audit_payload_json, fast_merge_audit_error
   ) VALUES (?, ?, ?, ?, ?, ?, ?, 'fast_merge_skipped', ?, 'fast_merge_skipped', 0, ?, ?, ?, ?, ?)`
);
export const stmtUpdateReviewRouting = db.prepare(
  'UPDATE reviewed_prs SET reviewer = ?, linear_ticket = COALESCE(?, linear_ticket) WHERE repo = ? AND pr_number = ?'
);
export const stmtUpdateReviewLabels = db.prepare(
  'UPDATE reviewed_prs SET labels_json = ? WHERE repo = ? AND pr_number = ?'
);
export const stmtUpdatePipelineStageStates = db.prepare(
  'UPDATE reviewed_prs SET pipeline_stage_states_json = ? WHERE repo = ? AND pr_number = ?'
);
export const stmtGetFastMergeSkippedPRs = db.prepare(
  "SELECT * FROM reviewed_prs WHERE pr_state = 'fast_merge_skipped' ORDER BY reviewed_at ASC, id ASC LIMIT ?"
);
export const stmtGetPendingFastMergeAudits = db.prepare(
  "SELECT * FROM reviewed_prs WHERE fast_merge_audit_status = 'pending' AND fast_merge_audit_payload_json IS NOT NULL ORDER BY reviewed_at ASC, id ASC LIMIT ?"
);

export const stmtMarkInfraAutoRecoveryAttemptStarted = db.prepare(
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
     AND review_status = 'failed'
     AND COALESCE(infra_auto_recover_attempts, 0) < ?
     AND (
       (? = 'cascade' AND (
         lower(COALESCE(failure_message, '')) LIKE '[cascade]%' OR
         lower(COALESCE(failure_message, '')) LIKE '%litellm/upstream cascade%' OR
         lower(COALESCE(failure_message, '')) LIKE '%watcher backoff engaged%'
       )) OR
       (? = 'provider-overloaded' AND lower(COALESCE(failure_message, '')) LIKE '[provider-overloaded]%') OR
       (? = 'reviewer-timeout' AND lower(COALESCE(failure_message, '')) LIKE '[reviewer-timeout]%') OR
       (? = 'launchctl-bootstrap' AND (
         lower(COALESCE(failure_message, '')) LIKE '[launchctl-bootstrap]%' OR
         lower(COALESCE(failure_message, '')) LIKE '%claude launchctl session bootstrap failed%' OR
         lower(COALESCE(failure_message, '')) LIKE '%launchctlsessionerror%'
       )) OR
       (? = 'oauth-broken' AND lower(COALESCE(failure_message, '')) LIKE '%[oauth-broken]%') OR
       (? = 'quota-exhausted' AND lower(COALESCE(failure_message, '')) LIKE '[quota-exhausted]%') OR
       (? = 'reviewer-command-failed' AND (
         (
           lower(COALESCE(failure_message, '')) LIKE '[unknown] command failed%' AND
           lower(COALESCE(failure_message, '')) NOT LIKE '[unknown] command failed with code %'
         ) OR
         lower(COALESCE(failure_message, '')) LIKE '[unknown] command failed with code %'
       ))
     )`
);
export const stmtMarkReviewPopulationRetryAttemptStarted = db.prepare(
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
         review_population_retry_attempts = CASE
           WHEN COALESCE(review_population_retry_head_sha, '') = COALESCE(?, '') THEN review_population_retry_attempts + 1
           ELSE 1
         END,
         review_population_retry_last_at = ?,
         review_population_retry_head_sha = ?
   WHERE repo = ?
     AND pr_number = ?
     AND review_status = 'failed'
     AND (
       COALESCE(review_population_retry_head_sha, '') != COALESCE(?, '') OR
       review_population_retry_attempts < ?
     )
     AND (
       (
         lower(COALESCE(failure_message, '')) LIKE '%reviewer session % is no longer alive%' AND
         lower(COALESCE(failure_message, '')) LIKE '%no github review%found%'
       ) OR
       lower(COALESCE(failure_message, '')) LIKE '%no github review%found%' OR
       lower(COALESCE(failure_message, '')) LIKE '%generated-but-not-posted%' OR
       lower(COALESCE(failure_message, '')) LIKE '%generated but not posted%'
     )`
);
export const stmtMarkUnknownFailureRetryAttemptStarted = db.prepare(
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
         failure_message = NULL
   WHERE repo = ?
     AND pr_number = ?
     AND review_status = 'failed'
     AND review_attempts < ?
     AND (
       lower(COALESCE(failure_message, '')) LIKE '%command failed with code %' OR
       lower(COALESCE(failure_message, '')) LIKE '%command exited with code %' OR
       lower(COALESCE(failure_message, '')) LIKE '%non-zero exit code %' OR
       lower(COALESCE(failure_message, '')) LIKE '%non-zero exit %'
     )
     AND (
       lower(COALESCE(failure_message, '')) LIKE '[unknown]%' OR
       lower(COALESCE(failure_message, '')) NOT GLOB '[[]*[]]*'
     )`
);
export const stmtMarkFastMergeAuditPending = db.prepare(
  "UPDATE reviewed_prs SET fast_merge_audit_status = 'pending', fast_merge_audit_payload_json = ?, fast_merge_audit_error = NULL WHERE repo = ? AND pr_number = ?"
);
export const stmtMarkFastMergeAuditWritten = db.prepare(
  "UPDATE reviewed_prs SET fast_merge_audit_status = 'written', fast_merge_audit_error = NULL WHERE repo = ? AND pr_number = ?"
);
export const stmtMarkFastMergeAuditError = db.prepare(
  "UPDATE reviewed_prs SET fast_merge_audit_status = 'pending', fast_merge_audit_error = ? WHERE repo = ? AND pr_number = ?"
);
export const stmtMarkMalformed = db.prepare(
  "UPDATE reviewed_prs SET reviewer = 'malformed-title', review_status = 'malformed', failure_message = ?, failed_at = ?, last_attempted_at = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
);
// 'reviewing' is the durable in-progress claim: set BEFORE spawning
// the reviewer subprocess, replaced with 'posted' / 'failed' once the
// spawn resolves. If the watcher exits between these two updates
// (watchdog timeout, OOM kill, launchd restart), the row stays in
// 'reviewing' on disk — that is the operator-visible signal that a
// review subprocess was in flight when the parent died and may have
// posted a review the parent never recorded. On startup, the durable
// reviewer handle below lets reconcileReviewerSessions reattach to a
// still-live reviewer or recover a posted GitHub review before falling
// back to sticky operator action for legacy/anomalous rows.
// Compare-and-swap claim: only flip `pending` rows and expired
// `pending-upstream` backoff rows to
// `'reviewing'`. The unconditional UPDATE the previous version of this
// statement performed was safe under the in-process pollOnce
// serialization in this module, but did NOT close the cross-process
// race: if a second watcher instance (operator dev-mode launch racing
// launchd's KeepAlive, accidental double-launch, etc.) reads the same
// `pending` row, both would have called the unconditional UPDATE and
// both would have spawned a reviewer subprocess, producing duplicate
// GitHub reviews. The atomic CAS below is the second of two layers
// (in-process self-scheduled poll loop + cross-process SQL CAS) that
// together close the duplicate-spawn vector at both layers.
//
// Match conditions:
//   - `review_status = 'pending'` — happy-path claim.
//   - `review_status = 'pending-upstream'` — upstream-cascade backoff
//     path. pollOnce gates this state on file-backed nextRetryAfter,
//     and once that window expires the row may be reclaimed for
//     another attempt without burning review_attempts.
// Infrastructure-class `failed` rows use the dedicated
// stmtMarkInfraAutoRecoveryAttemptStarted claim above, which rechecks the
// stored failure class and recovery cap atomically. Non-infrastructure
// `failed` rows must remain failed for operator inspection; the generic claim
// must never erase their failure evidence.
//
// Terminal statuses (`posted`, `malformed`) and the durable in-flight
// state (`reviewing`) is NOT reclaimable by this CAS. `failed-orphan`
// rows use the bounded auto-reclaim pass below after lease/process
// liveness guards pass, or the explicit operator recovery path
// (`npm run retrigger-review --allow-failed-reset`) after manual
// verification. Both reset the row to `pending`, and this CAS then
// matches it on the next poll.
//
// Callers must check `result.changes === 1` before proceeding with
// the spawn. A 0-changes result means another watcher (or a parallel
// claim path) won the row, or the row's status moved to a state this
// CAS does not match — log and skip.
//
// INVARIANT — do not widen the two-status WHERE list, and do not drop the
// fields this claim stamps. This UPDATE is both:
//   (a) THE single-claim concurrency guarantee: exactly one claimant can
//       flip a row to 'reviewing', across processes, because SQLite executes
//       the row UPDATE atomically and every other status is unmatched; and
//   (b) the orphan-recovery anchor: the `reviewer_session_uuid`,
//       `reviewer_head_sha`, `reviewer_timeout_ms`, and
//       `reviewer_lease_expires_at` written here (plus `reviewer_pgid` via
//       stmtMarkReviewerPgid after spawn) are the durable reviewer handle
//       that `failedOrphanAutoReclaimDecision` / `probeReviewerProcessSession`
//       use to prove lease expiry and process-group liveness/identity (the
//       `ps` command-line must contain the session UUID — that is the
//       recycled-PGID discriminator). A claim path that skips these stamps
//       produces rows that can only ever fall to sticky failed-orphan.
// Adding 'reviewing' to the WHERE re-opens the duplicate-spawn race; adding
// 'failed' erases operator failure evidence; adding 'failed-orphan' bypasses
// the lease/liveness guards. The CAS semantics are pinned by
// test/watcher-atomic-claim.test.mjs (claim/refusal per status) and the
// surrounding hot path by test/watcher-claim-loop.test.mjs.
export const stmtMarkAttemptStarted = db.prepare(
  `UPDATE reviewed_prs
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
     AND review_status IN ('pending', 'pending-upstream')`
);
export const stmtMarkReviewerPgid = db.prepare(
  `UPDATE reviewed_prs
      SET reviewer_pgid = ?,
          reviewer_started_at = ?,
          reviewer_lease_expires_at = ?
    WHERE reviewer_session_uuid = ?
      AND repo = ?
      AND pr_number = ?
      AND review_status = 'reviewing'`
);
export const stmtReleaseReviewerClaim = db.prepare(
  `UPDATE reviewed_prs
      SET review_status = 'pending',
          reviewer_session_uuid = NULL,
          reviewer_started_at = NULL,
          reviewer_head_sha = NULL,
          reviewer_timeout_ms = NULL,
          reviewer_lease_expires_at = NULL,
          reviewer_pgid = NULL
    WHERE reviewer_session_uuid = ?
      AND repo = ?
      AND pr_number = ?
      AND review_status = 'reviewing'`
);
export const stmtMarkPosted = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'posted', posted_at = ?, failed_at = NULL, failure_message = NULL, quota_reset_at_utc = NULL, review_attempts = review_attempts + 1, reviewer_lease_expires_at = NULL, infra_auto_recover_attempts = 0 WHERE repo = ? AND pr_number = ?"
);
export const stmtRestoreSameHeadSuppressedReviewPosted = db.prepare(
  `UPDATE reviewed_prs
      SET review_status = 'posted',
          posted_at = COALESCE(posted_at, ?),
          failed_at = NULL,
          failure_message = NULL,
          quota_reset_at_utc = NULL,
          reviewer_lease_expires_at = NULL,
          rereview_requested_at = NULL,
          rereview_reason = NULL
    WHERE repo = ?
      AND pr_number = ?
      AND review_status = 'pending'
      AND reviewer_head_sha = ?`
);
// CAS variant for reviewer-command-failed posted-reconciliation (LAC-1359
// follow-up). The reconcile path shells out to GitHub (async) BEFORE mutating
// SQLite, so a generic repo+pr_number UPDATE could overwrite a row that moved on
// since the probe. This statement ties the `posted` write to the exact `failed`
// row + reviewer session/start + command-failed shape the probe inspected, so a
// raced row (new claim/failure/operator action) matches 0 rows instead of being
// force-posted. Callers MUST check `.changes === 1`.
export const stmtMarkReviewerCommandFailedRecoveredPosted = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'posted', posted_at = ?, failed_at = NULL, failure_message = NULL, quota_reset_at_utc = NULL, review_attempts = review_attempts + 1, reviewer_lease_expires_at = NULL, infra_auto_recover_attempts = 0 WHERE repo = ? AND pr_number = ? AND review_status = 'failed' AND reviewer_session_uuid = ? AND reviewer_started_at = ? AND lower(COALESCE(failure_message, '')) LIKE '[unknown] command failed%'"
);
export const stmtMarkFailed = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, quota_reset_at_utc = NULL, review_attempts = review_attempts + 1, reviewer_lease_expires_at = NULL WHERE repo = ? AND pr_number = ?"
);
export const stmtReleaseReviewLease = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'pending', failed_at = ?, failure_message = ?, quota_reset_at_utc = NULL, review_attempts = review_attempts + 1, reviewer_lease_expires_at = NULL WHERE repo = ? AND pr_number = ? AND review_status = 'reviewing'"
);
// Quota-exhaustion variants: identical to markFailed / releaseReviewLease but
// ALSO persist the provider usage-cap reset time (captured from the full
// reviewer output before failure_message truncation) into quota_reset_at_utc so
// the hold-until-reset gate can honor it instead of the blind fallback window.
export const stmtMarkFailedQuota = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, quota_reset_at_utc = ?, review_attempts = review_attempts + 1, reviewer_lease_expires_at = NULL WHERE repo = ? AND pr_number = ?"
);
export const stmtReleaseReviewLeaseQuota = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'pending', failed_at = ?, failure_message = ?, quota_reset_at_utc = ?, review_attempts = review_attempts + 1, reviewer_lease_expires_at = NULL WHERE repo = ? AND pr_number = ? AND review_status = 'reviewing'"
);
export const stmtMarkOutageTransient = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'pending-upstream', failed_at = ?, failure_message = ?, quota_reset_at_utc = ?, reviewer_lease_expires_at = NULL WHERE repo = ? AND pr_number = ? AND review_status = 'reviewing'"
);
export const stmtMarkCascadeFailed = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, reviewer_lease_expires_at = NULL WHERE repo = ? AND pr_number = ?"
);
export const stmtMarkPendingUpstream = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'pending-upstream', failed_at = ?, failure_message = ?, reviewer_lease_expires_at = NULL, infra_auto_recover_attempts = COALESCE(infra_auto_recover_attempts, 0) + 1 WHERE repo = ? AND pr_number = ?"
);
export const stmtMarkReviewCycleCapPaused = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, reviewer_lease_expires_at = NULL WHERE repo = ? AND pr_number = ?"
);
export const stmtListFailedOrphanAutoReclaimCandidates = db.prepare(
  `SELECT repo, pr_number, pr_state, review_status, reviewer, review_attempts,
          last_attempted_at, failed_at, failure_message, reviewer_session_uuid,
          reviewer_pgid, reviewer_started_at, reviewer_head_sha, reviewer_timeout_ms,
          reviewer_lease_expires_at, infra_auto_recover_attempts
     FROM reviewed_prs
    WHERE pr_state = 'open'
      AND review_status = 'failed-orphan'
      AND COALESCE(infra_auto_recover_attempts, 0) < ?
    ORDER BY failed_at ASC, last_attempted_at ASC, id ASC
    LIMIT ?`
);
export const stmtAutoReclaimFailedOrphan = db.prepare(
  `UPDATE reviewed_prs
      SET review_status = 'pending',
          review_attempts = 0,
          last_attempted_at = NULL,
          posted_at = NULL,
          failed_at = ?,
          failure_message = ?,
          rereview_requested_at = ?,
          rereview_reason = ?,
          reviewer_session_uuid = NULL,
          reviewer_pgid = NULL,
          reviewer_started_at = NULL,
          reviewer_head_sha = NULL,
          reviewer_timeout_ms = NULL,
          reviewer_lease_expires_at = NULL,
          quota_reset_at_utc = NULL,
          review_population_retry_attempts = 0,
          review_population_retry_last_at = NULL,
          review_population_retry_head_sha = NULL,
          infra_auto_recover_attempts = COALESCE(infra_auto_recover_attempts, 0) + 1
    WHERE repo = ?
      AND pr_number = ?
      AND pr_state = 'open'
      AND review_status = 'failed-orphan'
      AND COALESCE(infra_auto_recover_attempts, 0) < ?
      AND COALESCE(reviewer_session_uuid, '') = COALESCE(?, '')
      AND COALESCE(reviewer_pgid, '') = COALESCE(?, '')
      AND COALESCE(reviewer_lease_expires_at, '') = COALESCE(?, '')`
);
export const stmtGetOpenPRs = db.prepare(
  "SELECT repo, pr_number, linear_ticket, labels_json FROM reviewed_prs WHERE pr_state = 'open'"
);
export const stmtMarkMerged = db.prepare(
  "UPDATE reviewed_prs SET pr_state = 'merged', merged_at = ? WHERE repo = ? AND pr_number = ?"
);
export const stmtMarkClosed = db.prepare(
  "UPDATE reviewed_prs SET pr_state = 'closed', closed_at = ? WHERE repo = ? AND pr_number = ?"
);
