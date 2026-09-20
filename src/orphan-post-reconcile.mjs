import { SQL_COUNT_OPEN_AWAITING_FIRST_PASS_REVIEW } from './review-state-statements.mjs';
import { reviewerBotLoginAliases } from './reviewer-reattach.mjs';
import { loginsMatch } from './review-body-capture.mjs';

function postedReviewForRow(row, reviews) {
  const aliases = reviewerBotLoginAliases(row.reviewer);
  const startedAt = Date.parse(row.reviewer_started_at || row.last_attempted_at || '');
  const headSha = String(row.reviewer_head_sha || '');
  return reviews
    .filter((review) => aliases.some((alias) => loginsMatch(review?.user?.login, alias)))
    .filter((review) => {
      const submittedAt = Date.parse(review?.submitted_at || '');
      const commitId = String(review?.commit_id || '');
      return Number.isFinite(submittedAt)
        && (!Number.isFinite(startedAt) || submittedAt >= startedAt)
        && (!headSha || !commitId || commitId === headSha);
    })
    .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at))[0] || null;
}

function reviewVerdict(state) {
  return {
    APPROVED: 'approved',
    CHANGES_REQUESTED: 'request-changes',
    COMMENTED: 'comment-only',
    DISMISSED: 'dismissed',
  }[String(state || '').toUpperCase()] || null;
}

export async function reconcilePostedFailedOrphans({ db, listReviews, apply = false, limit = 20 } = {}) {
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
    `SELECT pass_id FROM reviewer_passes
      WHERE repo = ? AND pr_number = ?
        AND (? IS NULL OR head_sha IS NULL OR head_sha = ?)
        AND pass_kind IN ('first-pass', 'rereview')
        AND status IN ('running', 'abandoned')
      ORDER BY CASE WHEN attempt_number = ? THEN 0 ELSE 1 END,
               started_at DESC, pass_id DESC LIMIT 1`
  );
  const markPassPosted = db.prepare(
    `UPDATE reviewer_passes
        SET ended_at = COALESCE(ended_at, ?), status = 'completed', verdict = ?,
            body_md = COALESCE(body_md, ?), gh_comment_id = ?,
            body_captured_at = COALESCE(body_captured_at, ?)
      WHERE pass_id = ? AND (gh_comment_id IS NULL OR gh_comment_id = ?)`
  );
  const passByReviewId = db.prepare(
    'SELECT pass_id, repo, pr_number FROM reviewer_passes WHERE gh_comment_id = ?'
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
      if (apply) {
        changed = db.transaction(() => {
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
            row.reviewer_head_sha || null,
            row.reviewer_head_sha || null,
            row.review_attempts
          );
          if (pass && reviewId && !existingArtifact) {
            markPassPosted.run(
              review.submitted_at,
              reviewVerdict(review.state),
              review.body || '',
              reviewId,
              review.submitted_at,
              pass.pass_id,
              reviewId
            );
          }
          return true;
        })();
      }
      results.push({
        repo: row.repo,
        prNumber: row.pr_number,
        action: apply ? (changed ? 'reconciled' : 'cas-miss') : 'would-reconcile',
        postedAt: review.submitted_at,
        reviewId: review.id,
        verdict: reviewVerdict(review.state),
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
