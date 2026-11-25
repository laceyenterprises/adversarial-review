// Review failures depend on persisted review rows and cascade history.
import { getReviewRow, openReviewStateDb } from './review-state.mjs';
import { reviewerFailureClassFromStoredRow } from './reviewer-failure-classification.mjs';
import { CASCADE_FAILURE_CAP, readCascadeState } from './reviewer-cascade.mjs';

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

export { classifyBlockingFindings, classifyNonBlockingFindings } from './merge-agent-finding-classification.mjs';

export {
  readMergeAgentReviewFailureState,
  readMergeAgentReviewFailureStateWithDb,
};
