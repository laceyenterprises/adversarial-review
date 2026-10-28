import { isExplicitOperatorRetriggerReason } from './retrigger-review-reason.mjs';
import { isOrphanHeadReviewRequested } from './orphan-head-review-requested.mjs';

// Ceiling ownership only, not merge permission or reviewer liveness. Callers
// supply the existing delivered-review count result; a persisted closure row
// carries that result when admission has already handed it off. A closer's
// rereview-exact-head recommendation does not increase the budget.
export function reviewCeilingOwner({ row, headSha, ceilingReached = row?.rereview_reason === 'system-review-ceiling-closure' } = {}) {
  const explicitReview = Boolean(row?.rereview_requested_at
    && isExplicitOperatorRetriggerReason(row.rereview_reason))
    || isOrphanHeadReviewRequested(row, headSha);
  return ceilingReached && !explicitReview ? 'hammer' : 'reviewer';
}
