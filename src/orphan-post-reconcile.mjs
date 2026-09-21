import { SQL_COUNT_OPEN_AWAITING_FIRST_PASS_REVIEW } from './review-state-statements.mjs';
import { reviewerBotLoginAliases } from './reviewer-reattach.mjs';
import { loginsMatch } from './review-body-capture.mjs';
import { ghReviewStateToVerdict } from './backfill-review-bodies.mjs';
import { queueFollowUpForRecoveredPostedReview } from './reviewer-pass-reaper.mjs';
import { withSqliteBusyRetrySync } from './sqlite-busy-retry.mjs';
import { findFollowUpJobForRevision } from './operator-retrigger-helpers.mjs';

function postedReviewForRow(row, reviews) {
  const aliases = reviewerBotLoginAliases(row.reviewer);
  const reviewerStartedAt = Date.parse(row.reviewer_started_at || '');
  const lastAttemptedAt = Date.parse(row.last_attempted_at || '');
  const startedAt = Number.isFinite(reviewerStartedAt) ? reviewerStartedAt : lastAttemptedAt;
  if (!Number.isFinite(startedAt)) return null;
  const headSha = String(row.reviewer_head_sha || '').trim();
  if (!headSha) return null;
  const acceptedStates = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']);
  return reviews
    .filter((review) => aliases.some((alias) => loginsMatch(review?.user?.login, alias)))
    .filter((review) => acceptedStates.has(String(review?.state || '').toUpperCase()))
    .filter((review) => {
      const submittedAt = Date.parse(review?.submitted_at || '');
      const commitId = String(review?.commit_id || '').trim();
      return Number.isFinite(submittedAt) &&
        submittedAt >= startedAt &&
        (!headSha || !commitId || commitId === headSha);
    })
    .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at))[0] || null;
}

function reviewVerdict(state) {
  return ghReviewStateToVerdict(state);
}

function reviewBodyForStorage(review) {
  if (review?.body === null || review?.body === undefined) return null;
  return String(review.body);
}

function livePullIsTerminal(pull) {
  if (!pull) return false;
  return Boolean(pull.merged_at) || String(pull.state || '').toLowerCase() !== 'open';
}

export async function reconcilePostedFailedOrphans({
  db,
  listReviews,
  apply = false,
  limit = 20,
  rootDir = process.cwd(),
  queueFollowUpForRecoveredPostedReviewImpl = queueFollowUpForRecoveredPostedReview,
  getPull = async () => null,
} = {}) {
  const scanLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 20;
  const depthBefore = Number(db.prepare(SQL_COUNT_OPEN_AWAITING_FIRST_PASS_REVIEW).get()?.n || 0);
  // Scan BOTH terminal-orphan and still-pending rows.
  //
  // A reviewer pass can post its review to GitHub and then never reach
  // settleReviewerAttempt() — the watcher is restarted, the process dies, or the
  // result is classified non-ok after the post already landed. The row is left at
  // `pending` with `posted_at` NULL while `reviewer_passes` carries a real
  // `gh_comment_id`. Remediation re-entry legitimately resets `posted_at` to NULL
  // as well (see the RVFRESH-01 note in review-state-db.mjs), so a pending row
  // with a posted review is reachable by more than one route.
  //
  // Left alone that row stays eligible for review, so the SAME PR is reviewed
  // again. Measured on the reference host 2026-09-21: 32 of 99 posted reviews in
  // 24h had not settled (32%), and #6928 and #6926 were each reviewed SIX times.
  // The wasted slots then surface as `review:queue_starvation` and a rising
  // `review:rereview_queue_wait`, which point at capacity rather than at the
  // unsettled row.
  //
  // Restricting this scan to 'failed-orphan' meant a live dry run reported
  // `scanned: 0` against those 32 rows. Widening is safe because nothing below
  // marks a row posted without a real GitHub review: markPosted is only ever
  // called with `review.submitted_at` from the PR's reviews API.
  const rows = db.prepare(
    `SELECT repo, pr_number, reviewer, review_status, review_attempts, last_attempted_at,
            reviewer_started_at, reviewer_session_uuid, reviewer_head_sha,
            infra_auto_recover_attempts
       FROM reviewed_prs
      WHERE pr_state = 'open'
        AND review_status IN ('failed-orphan', 'pending')
      ORDER BY COALESCE(failed_at, last_attempted_at), id
      LIMIT ?`
  ).all(scanLimit);
  const markPosted = db.prepare(
    `UPDATE reviewed_prs
        SET review_status = 'posted', posted_at = ?, failed_at = NULL,
            failure_message = NULL, reviewer_lease_expires_at = NULL,
            infra_auto_recover_attempts = 0
      WHERE repo = ? AND pr_number = ? AND review_status IN ('failed-orphan', 'pending')
        AND pr_state = 'open'
        AND COALESCE(reviewer_session_uuid, '') = COALESCE(?, '')`
  );
  const latestPass = db.prepare(
    `SELECT pass_id, repo, pr_number, reviewer_class, reviewer_model, metadata_json, head_sha,
            verdict, body_md, gh_comment_id
       FROM reviewer_passes
      WHERE repo = ? AND pr_number = ?
        AND attempt_number = ?
        AND pass_kind IN ('first-pass', 'rereview')
        AND (? IS NULL OR head_sha IS NULL OR head_sha = ?)
      ORDER BY started_at DESC, pass_id DESC LIMIT 1`
  );
  const markPassPosted = db.prepare(
    `UPDATE reviewer_passes
        SET ended_at = ?, status = 'completed', verdict = ?,
            body_md = COALESCE(body_md, ?), gh_comment_id = ?,
            body_captured_at = COALESCE(body_captured_at, ?)
      WHERE pass_id = ? AND (gh_comment_id IS NULL OR gh_comment_id = ?)`
  );
  const passByReviewId = db.prepare(
    `SELECT pass_id, repo, pr_number, reviewer_class, reviewer_model, metadata_json, head_sha,
            verdict, body_md, gh_comment_id
       FROM reviewer_passes WHERE gh_comment_id = ?`
  );
  const passById = db.prepare(
    `SELECT pass_id, repo, pr_number, reviewer_class, reviewer_model, metadata_json, head_sha,
            verdict, body_md, gh_comment_id
       FROM reviewer_passes WHERE pass_id = ?`
  );
  const results = [];

  for (const row of rows) {
    try {
      const livePull = await getPull(row);
      if (livePullIsTerminal(livePull)) {
        results.push({ repo: row.repo, prNumber: row.pr_number, action: 'terminal-live' });
        continue;
      }
      const reviews = await listReviews(row);
      const review = postedReviewForRow(row, reviews);
      if (!review) {
        results.push({ repo: row.repo, prNumber: row.pr_number, action: 'unchanged', reason: 'no-posted-review' });
        continue;
      }
      let artifactLinked = false;
      let queueDecision = null;
      let rowMarkedPosted = false;
      if (apply) {
        const applyResult = withSqliteBusyRetrySync(
          () => db.transaction(() => {
            const reviewId = review.id === null || review.id === undefined ? null : String(review.id);
            const reviewIds = [
              reviewId,
              review.node_id === null || review.node_id === undefined ? null : String(review.node_id),
            ].filter(Boolean);
            const existingArtifact = reviewIds
              .map((candidate) => passByReviewId.get(candidate))
              .find(Boolean) || null;
            if (existingArtifact && (
              existingArtifact.repo !== row.repo || Number(existingArtifact.pr_number) !== Number(row.pr_number)
            )) {
              throw new Error(`review ${reviewId || review.node_id} is already linked to another PR`);
            }
            const pass = existingArtifact || latestPass.get(
              row.repo,
              row.pr_number,
              row.review_attempts,
              row.reviewer_head_sha || null,
              row.reviewer_head_sha || null
            );
            let linkedPass = pass || null;
            if (pass && reviewId && !existingArtifact) {
              const passResult = markPassPosted.run(
                review.submitted_at,
                reviewVerdict(review.state),
                reviewBodyForStorage(review),
                reviewId,
                review.submitted_at,
                pass.pass_id,
                reviewId
              );
              linkedPass = passResult.changes === 1 ? (passById.get(pass.pass_id) || pass) : null;
            }
            const artifactLinked = Boolean(
              linkedPass && (reviewId || review.node_id) && (linkedPass.gh_comment_id || existingArtifact)
            );
            const followUpPayload = artifactLinked
              ? {
                  rootDir,
                  row: {
                    ...linkedPass,
                    body_md: linkedPass.body_md ?? reviewBodyForStorage(review),
                    verdict: linkedPass.verdict ?? reviewVerdict(review.state),
                    gh_comment_id: linkedPass.gh_comment_id ?? reviewId,
                    head_sha: linkedPass.head_sha || row.reviewer_head_sha || null,
                  },
                  reviewRow: row,
                  reviewPostedAt: review.submitted_at,
                }
              : null;
            if (!artifactLinked) {
              const result = markPosted.run(
                review.submitted_at,
                row.repo,
                row.pr_number,
                row.reviewer_session_uuid || ''
              );
              return { rowMarkedPosted: result.changes === 1, artifactLinked, passFound: Boolean(pass), followUpPayload };
            }
            return { rowMarkedPosted: false, artifactLinked, passFound: Boolean(pass), followUpPayload };
          })(),
          { label: 'reconcile-posted-orphans-row' }
        );
        rowMarkedPosted = applyResult.rowMarkedPosted === true;
        artifactLinked = applyResult.artifactLinked === true;
        const passFound = applyResult.passFound === true;
        if (artifactLinked && applyResult.followUpPayload) {
          const revisionRef = applyResult.followUpPayload.row.head_sha || row.reviewer_head_sha || null;
          const existingFollowUp = findFollowUpJobForRevision(rootDir, {
            repo: row.repo,
            prNumber: row.pr_number,
            revisionRef,
          });
          if (existingFollowUp) {
            queueDecision = {
              queued: false,
              reason: 'existing-follow-up-job',
              jobPath: existingFollowUp.jobPath,
            };
          } else {
            queueDecision = queueFollowUpForRecoveredPostedReviewImpl(applyResult.followUpPayload);
          }
          const markResult = markPosted.run(
            review.submitted_at,
            row.repo,
            row.pr_number,
            row.reviewer_session_uuid || ''
          );
          rowMarkedPosted = markResult.changes === 1;
        }
        if (rowMarkedPosted && !artifactLinked && !passFound) {
          results.push({
            repo: row.repo,
            prNumber: row.pr_number,
            action: 'posted-no-artifact',
            postedAt: review.submitted_at,
            reviewId: review.id,
            verdict: reviewVerdict(review.state),
          });
          continue;
        }
      }
      results.push({
        repo: row.repo,
        prNumber: row.pr_number,
        action: apply ? (rowMarkedPosted ? (artifactLinked ? 'reconciled' : 'reconciled-row-only') : 'cas-miss') : 'would-reconcile',
        postedAt: review.submitted_at,
        reviewId: review.id,
        verdict: reviewVerdict(review.state),
        ...(queueDecision ? { followUp: queueDecision } : {}),
      });
    } catch (err) {
      results.push({ repo: row.repo, prNumber: row.pr_number, action: 'error', error: err?.message || String(err) });
    }
  }

  const depthAfter = Number(db.prepare(SQL_COUNT_OPEN_AWAITING_FIRST_PASS_REVIEW).get()?.n || 0);
  return {
    apply,
    scanned: rows.length,
    reconciled: results.filter((item) => item.action === 'reconciled').length,
    reconciledRowOnly: results.filter((item) => item.action === 'reconciled-row-only').length,
    wouldReconcile: results.filter((item) => item.action === 'would-reconcile').length,
    firstPassQueue: { before: depthBefore, after: depthAfter },
    results,
  };
}

export { postedReviewForRow, reviewVerdict };
