import { createHotPathCache, reviewContextCacheKey } from './hot-path-cache.mjs';

const reviewerContextBundleCache = createHotPathCache({
  name: 'review-context',
  ttlMs: 5 * 60_000,
  emitEvent: (event) => console.error(`[reviewer] cache-event ${JSON.stringify(event)}`),
});

export function buildCachedReviewerContext(options = {}, build) {
  const { repo, prNumber, headSha, baseSha, reviewerProfile } = options;
  const contextCache = options.contextCache || reviewerContextBundleCache;
  if (!headSha || !baseSha || !reviewerProfile || !contextCache?.get) return build(options);
  const key = reviewContextCacheKey({ repo, prNumber, headSha, baseSha, reviewerProfile });
  return contextCache.get(key, () => build(options), {
    repo, prNumber, headSha, baseSha, reviewerProfile,
  });
}
