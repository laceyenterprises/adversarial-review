import { requestReviewRereview } from '../review-state.mjs';

// Use the existing exact-head orphan request: admission honors it even when
// the tip has closer trailers. Ordinary automatic refresh would be suppressed.
export async function recoverStrandedCloserHead({ result, closerAuthored, rootDir,
  repo, prNumber, headSha, logger = console, requestRereviewImpl = requestReviewRereview }) {
  if (!closerAuthored || !headSha || result?.dispatched || result?.needsOperator
    || result?.reason !== 'not-eligible' || !result?.reasons?.includes('stale-review-head')) return null;
  const request = await requestRereviewImpl({ rootDir, repo, prNumber,
    targetRevisionRef: headSha, reason: `system-orphan-head-review:${headSha}`, logger });
  logger.log?.(`[watcher] LEASEDEFER-01 exact-head re-review requested for ${repo}#${prNumber} head=${headSha} result=${request?.reason || (request?.triggered ? 'triggered' : 'refused')}`);
  return { ...result, skipMergeAgent: true, recoveryWait: true,
    reason: 'closer-head-exact-review-requested', rereview: request };
}
