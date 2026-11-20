import { DELIVERED_REVIEW_SQL, countReviewCeilingUnits } from './review-ceiling-metrics.mjs';
import { reviewCeilingOwner } from './review-ceiling-owner.mjs';
import { handoffAutomaticReview, isRemediationReviewIntent, pendingExplicitReviewIntent } from './explicit-review-intent.mjs';
import { normalizeEffectiveReviewVerdict } from './kernel/verdict.mjs';
import { parseReviewFindings } from './kernel/review-findings.mjs';
import { isSettledCommentOnlyReview } from './remediation-closeout.mjs';
import { parseReviewerPassTimestampMs } from './reviewer-pass-posted-review-sql.mjs';
export { reviewCeilingOwner } from './review-ceiling-owner.mjs';

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

export const BUDGET_EXHAUSTED_CLOSURE_REASON = 'system-budget-exhausted-closure';
const budgetHandoffLogs = new Set();
export function logBudgetClosureOnce({ repo, prNumber, headSha, logger = console, message }) {
  const key = JSON.stringify([repo, prNumber, headSha]);
  if (budgetHandoffLogs.has(key)) return;
  budgetHandoffLogs.add(key);
  if (budgetHandoffLogs.size > 4096) budgetHandoffLogs.delete(budgetHandoffLogs.values().next().value);
  logger.log?.(message);
}

export function isBudgetExhaustedReviewSuppression(decision) {
  return decision?.suppressed === true && ([
    'remediation-round-budget-exhausted', 'post-budget-final-review-completed-for-pr', 'review-cycle-cap-paused',
  ].includes(decision.reason) || (decision.reason === 'same-head-already-reviewed'
    && Number.isFinite(decision.roundBudget) && decision.completedRoundsForPR >= decision.roundBudget));
}

function latestDeliveredReview(db, repo, prNumber) {
  return db.prepare(`SELECT head_sha, started_at, ended_at, pass_kind, body_md FROM reviewer_passes
    WHERE repo=? AND pr_number=? AND status='completed'
    AND pass_kind IN ('first-pass','rereview') AND head_sha IS NOT NULL
    AND ${DELIVERED_REVIEW_SQL}
    ORDER BY ended_at DESC, pass_id DESC LIMIT 1`).get(repo, prNumber);
}

function canHandOffWorkerRequest(posted) {
  const findings = parseReviewFindings(posted.body_md);
  return isSettledCommentOnlyReview({ verdict: normalizeEffectiveReviewVerdict(posted.body_md),
    blockingFindingState: findings.blocking.state, blockingFindingCount: findings.blocking.count,
    nonBlockingFindingState: findings.nonBlocking.state });
}

// A queued review admission must never hide a delivered verdict from closure.
// Restore only that verdict's identity, under the queued request's CAS. Current
// PR/check/owner evidence is then read by the ordinary posted-review handler.
export function routeBudgetExhaustedReviewToClosure({ db, repo, prNumber, headSha, row, suppression, logger = console }) {
  if (!isBudgetExhaustedReviewSuppression(suppression)
    || !['pending', 'pending-upstream', 'ci-blocked'].includes(row?.review_status)) return false;
  const posted = latestDeliveredReview(db, repo, prNumber);
  if (!posted) return false;
  const changed = handoffAutomaticReview(db, { repo, prNumber, headSha }, BUDGET_EXHAUSTED_CLOSURE_REASON,
    intent => (!intent || posted.head_sha === headSha || canHandOffWorkerRequest(posted)) &&
    db.prepare(`UPDATE reviewed_prs SET review_status='posted',
    reviewer_head_sha=?, posted_at=?, rereview_requested_at=NULL, rereview_reason=?,
    failed_at=NULL, failure_message=NULL, reviewer_lease_expires_at=NULL
    WHERE repo=? AND pr_number=? AND pr_state='open' AND review_status=?
    AND revision_ref IS ? AND reviewer_head_sha IS ? AND posted_at IS ?
    AND rereview_requested_at IS ? AND rereview_reason IS ?`)
    .run(posted.head_sha, posted.ended_at, BUDGET_EXHAUSTED_CLOSURE_REASON,
      repo, prNumber, row.review_status, row.revision_ref ?? null, row.reviewer_head_sha ?? null,
      row.posted_at ?? null, row.rereview_requested_at ?? null, row.rereview_reason ?? null).changes === 1);
  if (changed) logBudgetClosureOnce({ repo, prNumber, headSha, logger,
    message: JSON.stringify({ event: 'budget-exhausted-closure-transition',
      repo, prNumber, headSha, priorStatus: row.review_status, reason: suppression.reason }) });
  return changed;
}

export function routeCappedReviewToClosure({ db, stmtGetReviewRow, repo, prNumber, headSha,
  row, ceiling, roundBudget, completedRoundTimestamps = [], logger = console }) {
  if (!row || ['reviewing', 'malformed', 'failed-orphan'].includes(row.review_status)) return false;
  if (row.review_status === 'failed' && row.rereview_reason !== 'system-review-ceiling-closure') return false;
  const hardCeiling = postedReviewCeilingReached({ db, repo, prNumber, ceiling });
  const identity = { repo, prNumber, headSha };
  if (!hardCeiling) {
    if (row.revision_ref !== headSha) return false;
    const alreadyRouted = row.rereview_reason === 'system-review-ceiling-closure';
    if (!alreadyRouted && !(completedRoundTimestamps.length
      && isRemediationReviewIntent(pendingExplicitReviewIntent(db, identity)))) return false;
  }
  const posted = latestDeliveredReview(db, repo, prNumber);
  if (!posted || posted.head_sha === headSha) return false;
  // Even below the hard ceiling, a delivered pass that started after the
  // ordinary budget was spent can already have supplied the owed final review.
  const startedMs = parseReviewerPassTimestampMs(posted.started_at);
  const deliveredFinalReview = posted.pass_kind === 'rereview' && Number.isFinite(roundBudget)
    && startedMs !== null && row.revision_ref === headSha
    && completedRoundTimestamps.some(({ round, terminalAt }) => {
      const terminalMs = parseReviewerPassTimestampMs(terminalAt);
      return round >= roundBudget && terminalMs !== null && startedMs >= terminalMs;
    });
  // Return ownership even on a no-op: the caller must keep auto-refresh
  // suppressed on every tick, without rewriting/logging posted -> posted.
  const changed = handoffAutomaticReview(db, identity, 'system-review-ceiling-closure',
    intent => reviewCeilingOwner({ row, headSha,
      ceilingReached: hardCeiling || Boolean(intent && deliveredFinalReview) }) === 'hammer'
    && (!intent || canHandOffWorkerRequest(posted)) &&
    db.prepare(`UPDATE reviewed_prs SET review_status='posted',
    reviewer_head_sha=?, posted_at=?, rereview_requested_at=NULL, rereview_reason='system-review-ceiling-closure'
    WHERE repo=? AND pr_number=? AND pr_state='open' AND review_status=?
    AND review_status IN ('posted','pending','pending-upstream','ci-blocked','failed')
    AND revision_ref IS ? AND reviewer_head_sha IS ? AND posted_at IS ?
    AND rereview_requested_at IS ? AND rereview_reason IS ?
    AND NOT (review_status='posted' AND reviewer_head_sha IS ? AND posted_at IS ?
      AND rereview_reason IS 'system-review-ceiling-closure')`)
    .run(posted.head_sha, posted.ended_at, repo, prNumber, row.review_status,
      row.revision_ref ?? null, row.reviewer_head_sha ?? null, row.posted_at ?? null, row.rereview_requested_at ?? null,
      row.rereview_reason ?? null, posted.head_sha, posted.ended_at).changes === 1);
  if (changed) logger.log?.(JSON.stringify({ event: 'review-ceiling-closure-transition', repo, prNumber, headSha, priorStatus: row.review_status, status: 'posted' }));
  const current = changed ? null : (stmtGetReviewRow
    || db.prepare('SELECT * FROM reviewed_prs WHERE repo=? AND pr_number=?')).get(repo, prNumber);
  return changed || (current?.review_status === 'posted'
    && (hardCeiling || current.revision_ref === headSha)
    && current.rereview_reason === 'system-review-ceiling-closure'
    && current.reviewer_head_sha === posted.head_sha && current.posted_at === posted.ended_at);
}
