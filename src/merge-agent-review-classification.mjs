// Merge-agent review-state classification.
//
// Pure review-outcome interpretation helpers extracted verbatim from
// follow-up-merge-agent.mjs (ARC-19 wave 4): the blocking / non-blocking
// finding classifiers that read a posted review body into a
// count/state verdict, plus the reviewer-failure-state reader that folds
// review-state-db status and cascade history into a
// {reviewFailureClass, reviewFailureExhausted} shape. These are the
// functions buildMergeAgentDispatchJob uses to turn a PR's latest review
// into dispatch-job classification fields.
//
// This is a leaf module: it imports only from sibling modules and never
// from follow-up-merge-agent.mjs, keeping the import graph acyclic.

import { parseReviewBody as parseMergeAgentRescueReviewBody } from './merge-agent-rescue-classifier.mjs';
import { normalizeReviewVerdict, sanitizeReviewPayloadBestEffort } from './review-verdict.mjs';
import { getReviewRow, openReviewStateDb } from './review-state.mjs';
import { reviewerFailureClassFromStoredRow } from './reviewer-failure-classification.mjs';
import { CASCADE_FAILURE_CAP, readCascadeState } from './reviewer-cascade.mjs';

function classifyBlockingFindings(reviewBody, { lastVerdict = null } = {}) {
  // Defense-in-depth format-independence: canonicalize the posted body before
  // parsing so a non-`##`-headed gemini/agy review (which reviewer-side
  // sanitation now normalizes at post time, but which may already be posted
  // un-canonicalized on an in-flight PR) still yields a parseable
  // `## Blocking issues` section. Without this the closer resolves
  // `state:'unknown'` on such bodies and REFUSES the budget-exhausted final
  // pass, so the PR never closes and re-enters the review loop.
  const parsed = parseMergeAgentRescueReviewBody(sanitizeReviewPayloadBestEffort(reviewBody));
  const normalizedVerdict = normalizeReviewVerdict(lastVerdict);
  const verdictKey = normalizedVerdict === 'unknown'
    ? String(lastVerdict || '').trim().toLowerCase()
    : normalizedVerdict;
  if (parsed.blocking.missing) {
    return verdictKey === 'request-changes'
      ? { count: 0, state: 'unknown' }
      : { count: 0, state: 'known' };
  }
  return { count: parsed.blocking.count, state: 'known' };
}

function classifyNonBlockingFindings(reviewBody, { lastVerdict = null } = {}) {
  if (!String(reviewBody ?? '').trim()) return { count: 0, state: 'unknown' };
  const parsed = parseMergeAgentRescueReviewBody(sanitizeReviewPayloadBestEffort(reviewBody));
  const normalizedVerdict = normalizeReviewVerdict(lastVerdict);
  const verdictKey = normalizedVerdict === 'unknown'
    ? String(lastVerdict || '').trim().toLowerCase()
    : normalizedVerdict;
  if (parsed.nonBlocking.missing) {
    return verdictKey === 'approved' || verdictKey === 'comment-only'
      ? { count: 0, state: 'known' }
      : { count: 0, state: 'unknown' };
  }
  return { count: parsed.nonBlocking.count, state: 'known' };
}

function readMergeAgentReviewFailureState(rootDir, { repo, prNumber, headSha = null } = {}) {
  return readMergeAgentReviewFailureStateWithDb(rootDir, null, { repo, prNumber, headSha });
}

function readMergeAgentReviewFailureStateWithDb(rootDir, reviewStateDb, { repo, prNumber, headSha = null } = {}) {
  let db = null;
  try {
    db = reviewStateDb || openReviewStateDb(rootDir);
    const row = getReviewRow(db, { repo, prNumber });
    const reviewStatus = String(row?.review_status || '').trim().toLowerCase();
    const failureClass = (reviewStatus === 'failed' || reviewStatus === 'pending-upstream')
      ? reviewerFailureClassFromStoredRow(row)
      : null;
    const reviewedHeadSha = String(row?.reviewer_head_sha || '').trim();
    const currentHeadSha = String(headSha || '').trim();
    if (failureClass === 'reviewer-timeout' && reviewedHeadSha && currentHeadSha && reviewedHeadSha !== currentHeadSha) {
      return {
        reviewFailureClass: failureClass,
        reviewFailureExhausted: false,
        reviewStatus: row?.review_status || null,
      };
    }
    const cascadeState = failureClass === 'reviewer-timeout'
      ? readCascadeState(rootDir, { repo, prNumber })
      : null;
    const timeoutFailures = Number(cascadeState?.transientFailureBreakdown?.['reviewer-timeout'] || 0);
    return {
      reviewFailureClass: failureClass || null,
      reviewFailureExhausted: failureClass === 'reviewer-timeout' && timeoutFailures >= CASCADE_FAILURE_CAP,
      reviewStatus: row?.review_status || null,
    };
  } catch {
    return {
      reviewFailureClass: null,
      reviewFailureExhausted: false,
      reviewStatus: null,
    };
  } finally {
    try {
      if (!reviewStateDb) db?.close?.();
    } catch {}
  }
}

export {
  classifyBlockingFindings,
  classifyNonBlockingFindings,
  readMergeAgentReviewFailureState,
  readMergeAgentReviewFailureStateWithDb,
};
