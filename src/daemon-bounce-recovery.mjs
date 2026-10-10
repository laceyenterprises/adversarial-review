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
// reviewer is still running, the re-queue holds. Expired reviewers must be
// verified and confirmed dead, or exhaust the incomplete-evidence hold, before replacement.

import { currentProcessGroupId, verifyPgidIdentitySync } from './process-group-identity.mjs';

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

// Timeout expiry is permission to recover, never proof of process exit.
// Unknown process evidence holds until its bounded deadline; it never authorizes signals.
export function daemonBounceReviewerHold(row, {
  now = Date.now(),
  isAlive = defaultIsAlive,
  verifyIdentity = verifyPgidIdentitySync,
  fallbackHoldMs = DAEMON_BOUNCE_HOLD_FALLBACK_MS,
} = {}) {
  if (!isDaemonBounceFailure(row)) return { hold: false, reason: 'not-daemon-bounce' };
  const startedMs = parseTimestampMs(row?.reviewer_started_at);
  const timeoutMs = Number(row?.reviewer_timeout_ms);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const holdUntilMs = startedMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? startedMs + timeoutMs
    : (parseTimestampMs(row?.failed_at) ?? startedMs ?? parseTimestampMs(row?.last_attempted_at)
      ?? parseTimestampMs(row?.reviewed_at) ?? 0) + fallbackHoldMs;
  const expired = Number.isFinite(nowMs) && nowMs >= holdUntilMs;
  const pgid = Number(row?.reviewer_pgid);
  // Incomplete evidence bounds the wait but never authorizes a process signal.
  const fallback = (reason) => ({ hold: !expired, reason, pgid, holdUntilMs, expired,
    processEvidenceMissing: true });
  if (!Number.isInteger(pgid) || pgid <= 0) return fallback('no-reviewer-pgid');
  if (startedMs == null) return fallback('no-reviewer-started-at');
  const alive = isAlive(pgid);
  if (alive === false) return { hold: false, reason: 'reviewer-not-alive', pgid, holdUntilMs, expired };
  if (alive !== true) return fallback('reviewer-liveness-unknown');
  const identity = verifyIdentity(pgid, new Date(startedMs).toISOString());
  if (!identity?.match) return fallback('reviewer-identity-unverified');
  return { hold: true, reason: 'bounced-reviewer-still-running', pgid, holdUntilMs, expired };
}

// Uses the same bounded TERM/KILL and delayed GitHub reprobe window as overdue
// reviewing-row recovery. A failed probe or cleanup leaves all claim evidence
// intact; the caller may claim a replacement only when handled is false.
export async function reconcileDaemonBounceBeforeRetry({
  row,
  now = Date.now(),
  isAlive = defaultIsAlive,
  verifyIdentity = verifyPgidIdentitySync,
  killProcessGroup = (pgid, signal) => process.kill(-pgid, signal),
  ownPgid = currentProcessGroupId,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  findPostedReview,
  resolveReviewerLogin = null,
  markPosted,
  settleRunRecord = async () => {},
} = {}) {
  if (!isDaemonBounceFailure(row)) return { handled: false, reason: 'not-daemon-bounce' };
  if (!row.reviewer_session_uuid || !row.reviewer_head_sha
    || (resolveReviewerLogin && !resolveReviewerLogin(row.reviewer))) {
    return { handled: false, reason: 'missing-review-claim-evidence' };
  }
  try {
    let decision = daemonBounceReviewerHold(row, { now, isAlive, verifyIdentity });
    if (decision.hold && !decision.expired) return { handled: true, ...decision };
    if (decision.hold) {
      const watcherPgid = ownPgid();
      if (!watcherPgid || watcherPgid === decision.pgid) {
        return { handled: true, reason: 'unsafe-process-group' };
      }
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        // Reverify before each signal; a PGID may be recycled during cleanup.
        decision = daemonBounceReviewerHold(row, { now, isAlive, verifyIdentity });
        if (decision.processEvidenceMissing) return { handled: true, reason: 'cleanup-identity-lost' };
        if (!decision.hold) break;
        if (!decision.expired) return { handled: true, ...decision };
        try {
          killProcessGroup(decision.pgid, signal);
        } catch (err) {
          if (err?.code !== 'ESRCH') throw err;
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await sleep(signal === 'SIGTERM' ? 200 : 100);
          if (isAlive(decision.pgid) === false) break;
        }
      }
    }
    // Even a successful signal is not evidence that the process group exited.
    if (!decision.processEvidenceMissing && isAlive(Number(row.reviewer_pgid)) !== false) {
      return { handled: true, reason: 'reviewer-exit-unconfirmed' };
    }
    for (const delay of [0, 500, 1500, 3000]) {
      if (delay) await sleep(delay);
      const review = await findPostedReview(row, { refresh: true, headSha: row.reviewer_head_sha });
      if (!review || review.commit_id !== row.reviewer_head_sha) continue;
      const postedAt = review.submitted_at;
      if (!postedAt || markPosted({ row, postedAt, postedReview: review }) !== 1) {
        return { handled: true, reason: 'posted-reconcile-cas-lost' };
      }
      await settleRunRecord({ sessionUuid: row.reviewer_session_uuid, state: 'completed',
        settledAt: postedAt, reason: 'posted-review-recovered-after-daemon-bounce' });
      return { handled: true, reason: 'marked-posted' };
    }
    await settleRunRecord({ sessionUuid: row.reviewer_session_uuid, state: 'cancelled',
      settledAt: new Date(now).toISOString(), reason: decision.processEvidenceMissing
        ? 'daemon-bounce-evidence-hold-expired' : 'daemon-bounce-reviewer-confirmed-dead' });
    return { handled: false, reason: 'dead-no-posted-review' };
  } catch (err) {
    return { handled: true, reason: 'bounce-recovery-inconclusive', error: err };
  }
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
