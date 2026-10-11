import { requestReviewRereview } from '../review-state.mjs';
import { findLiveAmaCloserLease, isHeldAmaCloserLease } from './closer-lease.mjs';
import { requestBoundedOrphanReview } from './orphan-review-request.mjs';
import { isOrphanHeadReviewRequested } from '../orphan-head-review-requested.mjs';
import { probeOrphanOwnership } from './orphan-watchdog.mjs';

const EXACT_REVIEW_REASONS = new Set([
  'stale-review-head', 'verdict-not-settled-success', 'blocking-findings-unknown',
]);

// Use the existing exact-head orphan request: admission honors it even when
// the tip has closer trailers. Ordinary automatic refresh would be suppressed.
export async function recoverStrandedCloserHead({ result, closerAuthored, rootDir,
  repo, prNumber, headSha, labels = [], signal = null, timeoutMs = 5000,
  logger = console, reviewStateRow = null, requestRereviewImpl = requestReviewRereview,
  requestBoundedReviewImpl = requestBoundedOrphanReview,
  probeOwnershipImpl = probeOrphanOwnership }) {
  if (!closerAuthored || !headSha || result?.dispatched || result?.needsOperator
    || result?.reason !== 'not-eligible' || !result?.reasons?.includes('stale-review-head')
    || !result.reasons.every(reason => EXACT_REVIEW_REASONS.has(reason))) return null;
  if (reviewStateRow?.review_status === 'failed' && reviewStateRow.reviewer_head_sha === headSha) return null;
  // A hammer may still own an older dispatch head after pushing this tip.
  // Check the PR-wide lease and durable launches before transferring ownership.
  // Do not pass the reviewer row: an already-pending reviewer is the owner we
  // want to retain, but must not hide a queued/running hammer from this probe.
  try {
    const lease = findLiveAmaCloserLease(rootDir, { repo, prNumber });
    if (lease && isHeldAmaCloserLease(rootDir, { repo, prNumber, headSha: lease.headSha })) return null;
    const ownership = await probeOwnershipImpl({ rootDir, repo, prNumber, headSha,
      labels, signal, timeoutMs, logger });
    if (signal?.aborted || ownership?.owned !== false || ownership?.uncertain !== false) return null;
  } catch (error) {
    if (signal?.aborted) throw error;
    logger.warn?.(`[watcher] LEASEDEFER-01 ownership probe failed for ${repo}#${prNumber}: ${error.message || error}`);
    return null;
  }
  let request;
  try {
    request = await requestBoundedReviewImpl({ rootDir, repo, prNumber, headSha,
      reviewStateRow, requestRereviewImpl, logger });
  } catch (error) {
    if (signal?.aborted) throw error;
    logger.warn?.(`[watcher] LEASEDEFER-01 bounded review request failed for ${repo}#${prNumber}: ${error.message || error}`);
    return null;
  }
  // A refused reset has no reviewer owner. Let the bounded orphan watchdog
  // observe it, account for recovery attempts and page on exhaustion.
  if (!request?.triggered && !isOrphanHeadReviewRequested(request?.reviewRow, headSha)) return null;
  logger.log?.(`[watcher] LEASEDEFER-01 exact-head re-review requested for ${repo}#${prNumber} head=${headSha} result=${request?.reason || (request?.triggered ? 'triggered' : 'refused')}`);
  return { ...result, skipMergeAgent: true, recoveryWait: true,
    reason: 'closer-head-exact-review-requested', rereview: request };
}
