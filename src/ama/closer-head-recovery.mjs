import { requestReviewRereview } from '../review-state.mjs';

const EXACT_REVIEW_REASONS = new Set([
  'stale-review-head', 'verdict-not-settled-success', 'blocking-findings-unknown',
]);

// Use the existing exact-head orphan request: admission honors it even when
// the tip has closer trailers. Ordinary automatic refresh would be suppressed.
export async function recoverStrandedCloserHead({ result, closerAuthored, rootDir,
  repo, prNumber, headSha, logger = console, requestRereviewImpl = requestReviewRereview }) {
  if (!closerAuthored || !headSha || result?.dispatched || result?.needsOperator
    || result?.reason !== 'not-eligible' || !result?.reasons?.includes('stale-review-head')
    || !result.reasons.every(reason => EXACT_REVIEW_REASONS.has(reason))) return null;
  const request = await requestRereviewImpl({ rootDir, repo, prNumber,
    targetRevisionRef: headSha, reason: `system-orphan-head-review:${headSha}`, logger });
  // A refused reset has no reviewer owner. Let the bounded orphan watchdog
  // observe it, account for recovery attempts and page on exhaustion.
  if (!request?.triggered && request?.reason !== 'already-pending') return null;
  logger.log?.(`[watcher] LEASEDEFER-01 exact-head re-review requested for ${repo}#${prNumber} head=${headSha} result=${request?.reason || (request?.triggered ? 'triggered' : 'refused')}`);
  return { ...result, skipMergeAgent: true, recoveryWait: true,
    reason: 'closer-head-exact-review-requested', rereview: request };
}
