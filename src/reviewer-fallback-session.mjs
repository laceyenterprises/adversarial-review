// Preserve claim ownership and recovery attribution across a same-pass fallback.
export function transferReviewerFallbackSession(db, { repo, prNumber, previousSessionUuid,
  reviewerSessionUuid, reviewerModel, codexBrokerProvider }) {
  const result = db.prepare(`UPDATE reviewed_prs
    SET reviewer_session_uuid = ?, reviewer = ?, codex_broker_provider = ?,
        reviewer_pgid = NULL, reviewer_started_at = NULL
    WHERE repo = ? AND pr_number = ? AND reviewer_session_uuid = ?
      AND review_status = 'reviewing'`).run(
    reviewerSessionUuid, reviewerModel,
    reviewerModel === 'codex' ? codexBrokerProvider || 'codex' : null,
    repo, prNumber, previousSessionUuid,
  );
  if (result.changes !== 1) throw new Error('Reviewer fallback lost session claim');
}
