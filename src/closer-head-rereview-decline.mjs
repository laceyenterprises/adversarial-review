// NOOWNER-01 (SEV1) — a re-review the watcher will never spawn is declined,
// not left pending.
//
// agent-os PR 8022, 2026-10-10: the hammer rebased the PR, pushed closer head
// c9006987 and stopped without merging. The rebase put worker commits under the
// closer commit, so the closer could not certify the head and AMA automated
// recovery asked for an exact-head re-review (`requestReviewRereview`, reason
// "AMA automated recovery: stale-review-head"). That reset the row to
// `pending`. Standing policy never re-reviews a head whose tip carries the
// closer trailer, so every poll logged "Retrying PR ... previous
// status=pending" and "reviewer spawn SUPPRESSED ... closer-commit-trailer",
// and returned. A pending row never reaches the posted-review phase, which is
// the only path to the AMA closer, so the PR had no owner for hours.
//
// When the reviewer spawn is suppressed for a closer head, an AMA-recovery
// re-review request on that row is declined the same way FSR-06B declines its
// own: the row goes back to `posted` with the last posted review's head, and
// the decline is recorded in `rereview_reason`. The PR returns to the closer,
// which owns it through the hammer stop hold (src/ama/hammer-stop-hold.mjs),
// and automated recovery reads the marker as a refused re-review: it does not
// ask again, and pages once if nothing else takes the PR within its deadline.

// Pure leaf: automated recovery and the watcher spawn path both import it.

export const AMA_RECOVERY_REREVIEW_REASON_PREFIX = 'AMA automated recovery:';
const DECLINED_REASON_PREFIX = 'system-rereview-declined:closer-head:';

export function closerHeadRereviewDeclinedReason(headSha) {
  return `${DECLINED_REASON_PREFIX}${String(headSha || '').trim().toLowerCase()}`;
}

export function isCloserHeadRereviewDeclined(reviewRow, headSha) {
  return Boolean(headSha)
    && String(reviewRow?.rereview_reason || '').trim().toLowerCase() === closerHeadRereviewDeclinedReason(headSha);
}

export function isAmaRecoveryRereviewRequest(reviewRow) {
  return Boolean(reviewRow?.rereview_requested_at)
    && String(reviewRow?.rereview_reason || '').startsWith(AMA_RECOVERY_REREVIEW_REASON_PREFIX);
}

/**
 * Restore an AMA-recovery re-review request the watcher will not spawn.
 * Compare-and-swap on the armed request, so a concurrent operator retrigger or
 * a newer request is never overwritten.
 */
export function declineSuppressedAmaRecoveryRereview({
  db,
  repoPath,
  prNumber,
  reviewRow,
  headSha,
  reviewedHeadSha,
  suppressionReason,
  now = new Date().toISOString(),
  logger = console,
} = {}) {
  if (!db || !headSha || !isAmaRecoveryRereviewRequest(reviewRow)) return { declined: false };
  if (!reviewedHeadSha) {
    // No posted review to restore: leave the row for the operator retrigger
    // path rather than inventing a verdict.
    logger?.warn?.(
      `[watcher] AMA recovery re-review for ${repoPath}#${prNumber} cannot spawn (${suppressionReason}) `
        + 'and no posted review exists to restore; leaving the request in place',
    );
    return { declined: false, reason: 'no-posted-review' };
  }
  const result = db.prepare(
    `UPDATE reviewed_prs
        SET review_status = 'posted',
            posted_at = COALESCE(posted_at, ?),
            failed_at = NULL,
            failure_message = NULL,
            reviewer_lease_expires_at = NULL,
            reviewer_head_sha = COALESCE(NULLIF(reviewer_head_sha, ''), ?),
            rereview_requested_at = NULL,
            rereview_reason = ?
      WHERE repo = ?
        AND pr_number = ?
        AND pr_state = 'open'
        AND review_status = 'pending'
        AND rereview_requested_at = ?
        AND rereview_reason = ?`,
  ).run(
    now,
    reviewedHeadSha,
    closerHeadRereviewDeclinedReason(headSha),
    repoPath,
    prNumber,
    reviewRow.rereview_requested_at,
    reviewRow.rereview_reason,
  );
  const declined = result.changes === 1;
  if (declined) {
    logger?.warn?.(
      `[watcher] AMA recovery re-review DECLINED for ${repoPath}#${prNumber}: ${suppressionReason} on head `
        + `${String(headSha).slice(0, 12)} is never re-reviewed; restored review_status='posted' at reviewed head `
        + `${String(reviewedHeadSha).slice(0, 12)} so the closer owns the PR again`,
    );
  }
  return { declined, reviewedHeadSha };
}
