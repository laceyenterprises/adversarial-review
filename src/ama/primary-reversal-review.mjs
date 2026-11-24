import Database from 'better-sqlite3';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { findExplicitReviewRequest, primaryReversalReviewContext, primaryReversalReviewRequest } from '../explicit-review-intent.mjs';
import { parseReviewFindings } from '../kernel/review-findings.mjs';
import { requestReviewRereview } from '../review-state.mjs';
import { normalizeEffectiveReviewVerdict } from '../kernel/verdict.mjs';
import { amaReviewerFamilyForLogin } from './reviewer-authority.mjs';

export function queuePrimaryReversalReview({ rootDir, repo, prNumber, headSha, db, context, logger }) {
  return requestReviewRereview({ rootDir, repo, prNumber, db, targetRevisionRef: headSha,
    preserveBudgets: true, reason: 'system-primary-reversal-review', logger,
    explicitReviewRequest: { ...primaryReversalReviewRequest(headSha), context } });
}

export function readPrimaryReversalReview(rootDir, { repo, prNumber, headSha }) {
  const path = join(rootDir, 'data', 'reviews.db');
  if (!existsSync(path)) return null;
  const db = new Database(path, { fileMustExist: true, readonly: true, timeout: 100 });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'explicit_review_intents'").get()) return null;
    const intent = findExplicitReviewRequest(db, { repo, prNumber, ...primaryReversalReviewRequest(headSha) });
    const context = primaryReversalReviewContext(intent, headSha);
    if (!context) return null;
    if (intent.state !== 'consumed') return { context, state: intent.state };
    const passes = db.prepare(`SELECT gh_comment_id, status FROM reviewer_passes
      WHERE repo = ? AND pr_number = ? AND head_sha = ? AND pass_kind = 'rereview'
        AND CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.primaryReversalReview') END = ?
      ORDER BY attempt_number DESC`).all(repo, prNumber, headSha, context.scope);
    const posted = passes.find(pass => pass.status === 'completed' && pass.gh_comment_id);
    const active = db.prepare(`SELECT 1 FROM reviewed_prs WHERE repo = ? AND pr_number = ?
      AND reviewer_head_sha = ? AND review_status = 'reviewing'`).get(repo, prNumber, headSha);
    return { context, state: posted ? 'posted' : active ? 'pending' : 'spent', reviewId: posted?.gh_comment_id };
  } finally { db.close(); }
}

export function verifyPrimaryReversalReview(receipt, reviews) {
  if (receipt?.state !== 'posted' || !Array.isArray(reviews) || reviews.length >= 100) return null;
  const { headSha, scope } = receipt.context;
  const review = reviews.find(entry => entry.node_id === receipt.reviewId || String(entry.id) === receipt.reviewId);
  if (review?.commit_id !== headSha || !['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED'].includes(review.state)) return null;
  const family = amaReviewerFamilyForLogin(review.user?.login);
  if (!family || reviews.slice(reviews.indexOf(review) + 1).some(entry => entry.commit_id === headSha
    && entry.state !== 'PENDING' && amaReviewerFamilyForLogin(entry.user?.login) === family)) return null;
  const verdict = normalizeEffectiveReviewVerdict(review.body);
  const { blocking } = parseReviewFindings(review.body);
  if (verdict === 'request-changes' && blocking.state === 'known' && blocking.count > 0) return { state: 'remediation', scope, headSha, reviewId: receipt.reviewId };
  if (!['approved', 'comment-only'].includes(verdict) || blocking.state !== 'known' || blocking.count !== 0
    || review.state === 'CHANGES_REQUESTED') return null;
  return { state: 'authorized', scope, headSha, reviewId: receipt.reviewId,
    authorization: `Reversal-Authorized-By: ${receipt.reviewId} head=${headSha}` };
}

export function formatPrimaryReversalReviewContext(context, headSha) {
  if (!context || context.headSha !== headSha) return '';
  return '\n\n## Reverted primary-change regions\n\n'
    + `Review these reversals on head ${headSha} against protected author head ${context.primaryHead}. `
    + 'The ranges identify the removed change in the author head, even when it is absent from the current diff. '
    + 'Inspect each cited commit. Report an improper loss of author intent as a normal blocking finding. '
    + 'If the affected lines are gone, identify the missing behavior and its closest location on the current head. '
    + 'Apply the full review contract to the PR.\n\n'
    + context.regions.map(({ file, start, end, commit }) =>
      `- File ${JSON.stringify(file)}, lines ${start}–${end}, removal commit \`${commit}\``).join('\n') + '\n';
}
