import { resolveReviewCliAsync, reviewCliForModel } from './review-cli-resolver.mjs';
import { recordCascadeFailure } from './reviewer-cascade.mjs';

// Called after durable backoff, before cap handling or a charged recovery claim.
export async function recoverHealthyReviewCli({
  db, rootDir, row, resolveImpl = resolveReviewCliAsync, log = console,
}) {
  try {
    const resolution = await resolveImpl(reviewCliForModel(row.reviewer), { log });
    if (resolution?.status !== 'resolved') return false;
  } catch {
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
    recordCascadeFailure(rootDir, {
      repo: row.repo, prNumber: row.pr_number,
      failureClass: 'cli-resolution-transient', resolverHealthy: true,
      failureReason: 'Resolver recovered; review re-queued without charging infrastructure recovery.',
    });
  }
  return true;
}
