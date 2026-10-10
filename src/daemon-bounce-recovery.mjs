// REVIEWBOUNCE-01: a daemon bounce interrupts the watcher, not the review.
//
// When the watcher restarts mid-review, recoverReviewerRunRecords cannot
// reattach to the reviewer it spawned and tags the row `[daemon-bounce]`. The
// reviewer process itself frequently survives the bounce and posts its verdict
// a minute later. Before this module two things went wrong with that:
//
//   1. The bounce charged review_attempts and was not infrastructure-recoverable,
//      so the next tick parked the row with "Review retry cap exhausted ...
//      failure is not infrastructure-recoverable" and the gate read
//      `review-failed`.
//   2. The posted-review artifact recovery only settled `reviewing` rows, so the
//      verified review the surviving reviewer posted for the exact head never
//      reached reviewed_prs.
//
// agent-os PR 8000 (head 20bb4884): bounce at 15:17:16, APPROVED review posted
// at 15:19:01, row still `failed` until a manual retrigger at 15:27.
//
// A bounce is now an infra failure: it re-queues through the bounded infra
// auto-recovery CAS and never touches review_attempts. While the bounced
// reviewer is provably still running inside its own timeout, the re-queue
// holds so the reaper can settle its post instead of spawning a duplicate.

import { verifyPgidIdentitySync } from './process-group-identity.mjs';

export const DAEMON_BOUNCE_FAILURE_CLASS = 'daemon-bounce';

const DAEMON_BOUNCE_HOLD_FALLBACK_MS = 60 * 60 * 1000;

export function isDaemonBounceFailure(row) {
  return String(row?.failure_message || '').trimStart().toLowerCase().startsWith(`[${DAEMON_BOUNCE_FAILURE_CLASS}]`);
}

function parseTimestampMs(value) {
  if (!value) return null;
  const text = String(value);
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function defaultIsAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err?.code === 'ESRCH' ? false : null;
  }
}

// Hold only on positive evidence: the bounced reviewer's process group is alive,
// its start time matches the claim, and it is still inside its own timeout. Any
// unknown (no pgid, unverifiable identity, unparseable timestamps) fails open to
// the bounded re-queue.
export function daemonBounceReviewerHold(row, {
  now = Date.now(),
  isAlive = defaultIsAlive,
  verifyIdentity = verifyPgidIdentitySync,
  fallbackHoldMs = DAEMON_BOUNCE_HOLD_FALLBACK_MS,
} = {}) {
  if (!isDaemonBounceFailure(row)) return { hold: false, reason: 'not-daemon-bounce' };
  const pgid = Number(row?.reviewer_pgid);
  if (!Number.isInteger(pgid) || pgid <= 0) return { hold: false, reason: 'no-reviewer-pgid' };
  const startedMs = parseTimestampMs(row?.reviewer_started_at);
  if (startedMs == null) return { hold: false, reason: 'no-reviewer-started-at' };
  const timeoutMs = Number(row?.reviewer_timeout_ms);
  const holdUntilMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? startedMs + timeoutMs
    : (parseTimestampMs(row?.failed_at) ?? startedMs) + fallbackHoldMs;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!(nowMs < holdUntilMs)) return { hold: false, reason: 'reviewer-timeout-elapsed' };
  if (isAlive(pgid) !== true) return { hold: false, reason: 'reviewer-not-alive' };
  const identity = verifyIdentity(pgid, new Date(startedMs).toISOString());
  if (!identity?.match) return { hold: false, reason: 'reviewer-identity-mismatch' };
  return { hold: true, reason: 'bounced-reviewer-still-running', pgid, holdUntilMs };
}

// Settles a row a daemon bounce marked failed/pending once the bounced
// reviewer's verified GitHub review is on file. Exact head only: the pass head
// must equal the row's reviewer_head_sha, and the claim predicate must tie the
// pass to the row's reviewer session. Same transition as the `reviewing`
// recovery: the review that posted is the one attempt it spent.
export function bouncedPostedReviewSettleSql(activeReviewClaimPredicate) {
  return `UPDATE reviewed_prs
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
        AND lower(COALESCE(failure_message, '')) LIKE '[${DAEMON_BOUNCE_FAILURE_CLASS}]%'
        AND ? IS NOT NULL
        AND reviewer_head_sha = ?
        AND ${activeReviewClaimPredicate}`;
}
