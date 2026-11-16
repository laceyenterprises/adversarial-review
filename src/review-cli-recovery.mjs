import { resolveReviewCliAsync, reviewCliForModel } from './review-cli-resolver.mjs';
import { recordReviewCliProbe } from './reviewer-cascade.mjs';

// Called after durable backoff, only below the infrastructure cap.
export async function recoverHealthyReviewCli({
  db, rootDir, row, probeCache = new Map(), resolveImpl = resolveReviewCliAsync, log = console,
}) {
  let healthy = false;
  try {
    const cli = reviewCliForModel(row.reviewer);
    if (!probeCache.has(cli)) probeCache.set(cli, Promise.resolve().then(() => resolveImpl(cli, { log })).catch(() => null));
    const resolution = await probeCache.get(cli);
    healthy = resolution?.status === 'resolved';
  } catch { /* retain the observed failure and schedule the next probe */ }
  if (!healthy) {
    const current = db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
      .get(row.repo, row.pr_number);
    if (current && ['review_status', 'failure_message', 'failed_at', 'reviewer_head_sha', 'reviewer_session_uuid', 'pr_state']
      .every(key => (current[key] ?? null) === (row[key] ?? null))) {
      recordReviewCliProbe(rootDir, { repo: row.repo, prNumber: row.pr_number });
    }
    return false;
  }
  const changed = db.prepare(`UPDATE reviewed_prs SET review_status = 'pending',
      failure_message = NULL, failed_at = NULL, reviewer_session_uuid = NULL,
      reviewer_lease_expires_at = NULL, reviewer_pgid = NULL,
      reviewer_head_sha = NULL, reviewer_started_at = NULL, reviewer_timeout_ms = NULL
    WHERE repo = ? AND pr_number = ? AND review_status IS ?
      AND failure_message IS ? AND failed_at IS ?
      AND reviewer_head_sha IS ? AND reviewer_session_uuid IS ?
      AND COALESCE(pr_state, 'open') = 'open'`).run(
    row.repo, row.pr_number, row.review_status, row.failure_message, row.failed_at,
    row.reviewer_head_sha, row.reviewer_session_uuid,
  );
  if (changed.changes === 1) {
    recordReviewCliProbe(rootDir, {
      repo: row.repo, prNumber: row.pr_number,
    });
  }
  return true;
}
