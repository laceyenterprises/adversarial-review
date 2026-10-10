import { bouncedPostedReviewSettleSql } from './daemon-bounce-recovery.mjs';
import { ghReviewStateToVerdict } from './backfill-review-bodies.mjs';
import { queueFollowUpForRecoveredPostedReview } from './reviewer-pass-reaper.mjs';
import { withSqliteBusyRetrySync } from './sqlite-busy-retry.mjs';

// GitHub may accept a review before termination prevents local capture/handoff.
// Keep the delivery claim retryable until both the pass and the file-backed
// follow-up are durable. File writes survive a SQLite rollback; queue dedupe
// makes that crash window safe to replay.
export function settleDaemonBouncePostedReview({
  db, rootDir, row, postedAt, postedReview,
  defaultBaseBranch = 'main',
  queueFollowUp = queueFollowUpForRecoveredPostedReview,
} = {}) {
  const reviewId = postedReview?.id == null ? null : String(postedReview.id);
  const body = postedReview?.body;
  const verdict = ghReviewStateToVerdict(postedReview?.state);
  if (!reviewId || typeof body !== 'string' || !body.trim()
    || !['approved', 'comment-only', 'request-changes'].includes(verdict)
    || postedReview.commit_id !== row.reviewer_head_sha) {
    throw new Error('Recovered bounce review lacks exact-head artifact evidence');
  }
  return withSqliteBusyRetrySync(() => db.transaction(() => {
    const changes = db.prepare(bouncedPostedReviewSettleSql(
      'reviewer_session_uuid = ? AND reviewer_started_at = ? AND failed_at = ?'
    )).run(postedAt, row.repo, row.pr_number, row.reviewer_head_sha,
      row.reviewer_head_sha, row.reviewer_session_uuid, row.reviewer_started_at, row.failed_at).changes;
    if (changes !== 1) return 0;

    const pass = db.prepare(`SELECT * FROM reviewer_passes
      WHERE repo = ? AND pr_number = ? AND head_sha = ?
        AND pass_kind IN ('first-pass', 'rereview')
        AND json_valid(metadata_json)
        AND json_extract(metadata_json, '$.reviewerSessionUuid') = ?
      ORDER BY pass_id DESC LIMIT 1`).get(
      row.repo, row.pr_number, row.reviewer_head_sha, row.reviewer_session_uuid
    );
    if (!pass || (pass.gh_comment_id && pass.gh_comment_id !== reviewId)) {
      throw new Error('Recovered bounce review has no matching reviewer pass');
    }
    db.prepare(`UPDATE reviewer_passes
      SET body_md = ?, verdict = ?, gh_comment_id = ?, body_captured_at = ?,
          status = 'completed', ended_at = ?
      WHERE pass_id = ?`).run(body, verdict, reviewId, postedAt, postedAt, pass.pass_id);
    queueFollowUp({
      rootDir,
      row: { ...pass, body_md: body, verdict, gh_comment_id: reviewId,
        body_captured_at: postedAt, ended_at: postedAt, status: 'completed' },
      reviewRow: row,
      reviewPostedAt: postedAt,
      defaultBaseBranch,
    });
    return changes;
  })(), { label: 'daemon-bounce-posted-review' });
}
