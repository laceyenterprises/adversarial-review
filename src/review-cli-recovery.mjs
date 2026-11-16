import { resolveReviewCliAsync, reviewCliForModel } from './review-cli-resolver.mjs';
import { recordReviewCliProbe } from './reviewer-cascade.mjs';

// Called after durable backoff, before cap handling or a charged recovery claim.
export async function recoverHealthyReviewCli({
  db, rootDir, row, resolveImpl = resolveReviewCliAsync, log = console,
}) {
  let healthy = false;
  try {
    const resolution = await resolveImpl(reviewCliForModel(row.reviewer), { log });
    healthy = resolution?.status === 'resolved';
  } catch { /* retain the observed failure and schedule the next probe */ }
  if (!healthy) {
    const current = db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
      .get(row.repo, row.pr_number);
    if (current && ['review_status', 'failure_message', 'failed_at', 'reviewer_head_sha', 'reviewer_session_uuid', 'pr_state']
      .every(key => (current[key] ?? null) === (row[key] ?? null))) {
      recordReviewCliProbe(rootDir, { repo: row.repo, prNumber: row.pr_number, healthy: false });
    }
    return false;
  }
  const changed = db.prepare(`UPDATE reviewed_prs SET review_status = 'pending',
      failure_message = NULL, failed_at = NULL, reviewer_session_uuid = NULL,
      reviewer_lease_expires_at = NULL, reviewer_pgid = NULL
    WHERE repo = ? AND pr_number = ? AND review_status IS ?
      AND failure_message IS ? AND failed_at IS ?
      AND reviewer_head_sha IS ? AND reviewer_session_uuid IS ?
      AND COALESCE(pr_state, 'open') != 'merged'`).run(
    row.repo, row.pr_number, row.review_status, row.failure_message, row.failed_at,
    row.reviewer_head_sha, row.reviewer_session_uuid,
  );
  if (changed.changes === 1) {
    recordReviewCliProbe(rootDir, {
      repo: row.repo, prNumber: row.pr_number,
      healthy: true,
    });
  }
  return true;
}
