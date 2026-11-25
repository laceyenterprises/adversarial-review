import { parseReviewFindings } from './kernel/review-findings.mjs';
import { sanitizeReviewPayloadBestEffort } from './kernel/verdict.mjs';

// Classify posted review bodies without opening review state or loading the
// reviewer cascade. The closer's predicate uses the same classifiers.
export function classifyBlockingFindings(reviewBody) {
  // Defense-in-depth format-independence: canonicalize the posted body before
  // parsing so a non-`##`-headed gemini/agy review (which reviewer-side
  // sanitation now normalizes at post time, but which may already be posted
  // un-canonicalized on an in-flight PR) still yields a parseable
  // `## Blocking issues` section. Without this the closer resolves
  // `state:'unknown'` on such bodies and REFUSES the budget-exhausted final
  // pass, so the PR never closes and re-enters the review loop.
  const parsed = parseReviewFindings(sanitizeReviewPayloadBestEffort(reviewBody));
  if (parsed.blocking.state === 'unknown') {
    return { count: 0, state: 'unknown' };
  }
  return { count: parsed.blocking.count, state: 'known' };
}

export function classifyNonBlockingFindings(reviewBody) {
  const { count, state } = parseReviewFindings(sanitizeReviewPayloadBestEffort(reviewBody)).nonBlocking;
  return { count, state };
}
