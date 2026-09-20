import { SQL_COUNT_OPEN_AWAITING_FIRST_PASS_REVIEW } from './review-state-statements.mjs';
import { reviewerBotLoginAliases } from './reviewer-reattach.mjs';
import { loginsMatch } from './review-body-capture.mjs';
import { ghReviewStateToVerdict } from './backfill-review-bodies.mjs';
import { queueFollowUpForRecoveredPostedReview } from './reviewer-pass-reaper.mjs';
import { withSqliteBusyRetrySync } from './sqlite-busy-retry.mjs';

function postedReviewForRow(row, reviews) {
  const aliases = reviewerBotLoginAliases(row.reviewer);
  const startedAt = Date.parse(row.reviewer_started_at || row.last_attempted_at || '');
  const headSha = String(row.reviewer_head_sha || '');
  return reviews
    .filter((review) => aliases.some((alias) => loginsMatch(review?.user?.login, alias)))
    .filter((review) => {
      const submittedAt = Date.parse(review?.submitted_at || '');
      const commitId = String(review?.commit_id || '');
      const hasStartedBound = Number.isFinite(startedAt);
      const hasHeadBound = Boolean(headSha && commitId);
      return Number.isFinite(submittedAt)
        && (hasStartedBound ? submittedAt >= startedAt : true)
        && (hasHeadBound ? commitId === headSha : hasStartedBound);
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

export async function reconcilePostedFailedOrphans({
  db,
  listReviews,
  apply = false,
  limit = 20,
  rootDir = process.cwd(),
  queueFollowUpForRecoveredPostedReviewImpl = queueFollowUpForRecoveredPostedReview,
} = {}) {
  const scanLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 20;
  const depthBefore = Number(db.prepare(SQL_COUNT_OPEN_AWAITING_FIRST_PASS_REVIEW).get()?.n || 0);
  const rows = db.prepare(
    `SELECT repo, pr_number, reviewer, review_status, review_attempts, last_attempted_at,
            reviewer_started_at, reviewer_session_uuid, reviewer_head_sha,
            infra_auto_recover_attempts
       FROM reviewed_prs
      WHERE pr_state = 'open'
        AND review_status = 'failed-orphan'
      ORDER BY failed_at, id
      LIMIT ?`
  ).all(scanLimit);
  const markPosted = db.prepare(
    `UPDATE reviewed_prs
        SET review_status = 'posted', posted_at = ?, failed_at = NULL,
            failure_message = NULL, reviewer_lease_expires_at = NULL,
            infra_auto_recover_attempts = 0
      WHERE repo = ? AND pr_number = ? AND review_status = 'failed-orphan'
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
        SET ended_at = COALESCE(ended_at, ?), status = 'completed', verdict = ?,
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
      const reviews = await listReviews(row);
      const review = postedReviewForRow(row, reviews);
      if (!review) {
        results.push({ repo: row.repo, prNumber: row.pr_number, action: 'unchanged', reason: 'no-posted-review' });
        continue;
      }
      let changed = false;
      let artifactLinked = false;
      let queueDecision = null;
      if (apply) {
        changed = withSqliteBusyRetrySync(
          () => db.transaction(() => {
            const result = markPosted.run(
              review.submitted_at,
              row.repo,
              row.pr_number,
              row.reviewer_session_uuid || ''
            );
            if (result.changes !== 1) return false;
            const reviewId = review.id === null || review.id === undefined ? null : String(review.id);
            const existingArtifact = reviewId ? passByReviewId.get(reviewId) : null;
            if (existingArtifact && (
              existingArtifact.repo !== row.repo || Number(existingArtifact.pr_number) !== Number(row.pr_number)
            )) {
              throw new Error(`review ${reviewId} is already linked to another PR`);
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
              markPassPosted.run(
                review.submitted_at,
                reviewVerdict(review.state),
                reviewBodyForStorage(review),
                reviewId,
                review.submitted_at,
                pass.pass_id,
                reviewId
              );
              linkedPass = passById.get(pass.pass_id) || pass;
            }
            if (linkedPass) {
              artifactLinked = Boolean(reviewId && (linkedPass.gh_comment_id || existingArtifact));
              queueDecision = queueFollowUpForRecoveredPostedReviewImpl({
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
              });
            }
            return true;
          })(),
          { label: 'reconcile-posted-orphans-row' }
        );
      }
      results.push({
        repo: row.repo,
        prNumber: row.pr_number,
        action: apply ? (changed ? (artifactLinked ? 'reconciled' : 'posted-no-artifact') : 'cas-miss') : 'would-reconcile',
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
    wouldReconcile: results.filter((item) => item.action === 'would-reconcile').length,
    firstPassQueue: { before: depthBefore, after: depthAfter },
    results,
  };
}

export { postedReviewForRow, reviewVerdict };
