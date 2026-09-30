import { appendScopeViolationFinding } from './additive-only-scope.mjs';
import { applyLivePackCrossEditReview } from './live-pack-cross-edit.mjs';

// Compose posting-time scope findings outside the reviewer orchestrator.
// Preserve the additive-only evidence before LIVEPACK can rewrite the verdict.
export function applyReviewScopeGates(reviewText, { scopeViolationFinding = null, ...livePackOptions } = {}) {
  const scopedText = scopeViolationFinding
    ? appendScopeViolationFinding(reviewText, scopeViolationFinding)
    : reviewText;
  return applyLivePackCrossEditReview(scopedText, livePackOptions);
}
