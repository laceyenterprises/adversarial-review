import { DELIVERED_REVIEW_SQL, countReviewCeilingUnits } from './review-ceiling-metrics.mjs';
import { isOrphanHeadReviewRequested, isExplicitOperatorReviewRetrigger } from './first-pass-review-suppression.mjs';

// A persisted legacy/operator increase remains authoritative for the active
// PR cycle. Routing to closure and admitting reviews must use the same budget.
export function resolveMaxRemediationRounds({ roundBudget, latestMaxRounds }) {
  const persistedMaxRounds = Number(latestMaxRounds);
  return Number.isInteger(persistedMaxRounds) && persistedMaxRounds > roundBudget
    ? persistedMaxRounds
    : roundBudget;
}

// Only a delivered review spends the PR-wide ceiling. A successful process
// exit without a GitHub review is still just an attempt.
export function postedReviewCeilingReached({ db, repo, prNumber, ceiling }) {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM reviewer_passes WHERE repo=? AND pr_number=?
    AND pass_kind IN ('first-pass','rereview') AND status='completed' AND ${DELIVERED_REVIEW_SQL}`).get(repo, prNumber);
  return Math.max(Number(row.count), countReviewCeilingUnits({ db, repoPath: repo, prNumber })) >= ceiling;
}

export { hammerHandoffReviewBypass } from './hammer-handoff-review-bypass.mjs';

export function routeCappedReviewToClosure({ db, stmtGetReviewRow, repo, prNumber, headSha, row, ceiling, logger = console }) {
  if (!row || ['reviewing', 'malformed', 'failed-orphan'].includes(row.review_status)
    || isExplicitOperatorReviewRetrigger(row) || isOrphanHeadReviewRequested(row, headSha)
    || !postedReviewCeilingReached({ db, repo, prNumber, ceiling })) return false;
  if (row.review_status === 'failed' && row.rereview_reason !== 'system-review-ceiling-closure') return false;
  const posted = db.prepare(`SELECT head_sha, ended_at FROM reviewer_passes
    WHERE repo=? AND pr_number=? AND status='completed'
    AND pass_kind IN ('first-pass','rereview') AND head_sha IS NOT NULL
    AND ${DELIVERED_REVIEW_SQL}
    ORDER BY ended_at DESC, pass_id DESC LIMIT 1`).get(repo, prNumber);
  if (!posted || posted.head_sha === headSha) return false;
  // Return ownership even on a no-op: the caller must keep auto-refresh
  // suppressed on every tick, without rewriting/logging posted -> posted.
  const changed = db.prepare(`UPDATE reviewed_prs SET review_status='posted',
    reviewer_head_sha=?, posted_at=?, rereview_reason='system-review-ceiling-closure'
    WHERE repo=? AND pr_number=? AND review_status=? AND review_status IN ('posted','pending','pending-upstream','failed')
    AND NOT (review_status='posted' AND reviewer_head_sha IS ? AND posted_at IS ?
      AND rereview_reason IS 'system-review-ceiling-closure')`)
    .run(posted.head_sha, posted.ended_at, repo, prNumber, row.review_status, posted.head_sha, posted.ended_at).changes === 1;
  if (changed) logger.log?.(JSON.stringify({ event: 'review-ceiling-closure-transition', repo, prNumber, headSha, priorStatus: row.review_status, status: 'posted' }));
  const current = changed ? null : (stmtGetReviewRow
    || db.prepare('SELECT * FROM reviewed_prs WHERE repo=? AND pr_number=?')).get(repo, prNumber);
  return changed || (current?.review_status === 'posted'
    && current.rereview_reason === 'system-review-ceiling-closure'
    && current.reviewer_head_sha === posted.head_sha && current.posted_at === posted.ended_at);
}
