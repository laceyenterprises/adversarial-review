// Shared closure evidence: only a new builder head gets a new review/budget
// episode. A closer's pushed head stays in its existing reviewed-head series.
export function hasUnreviewedBuilderHead(input = {}) {
  return Boolean(input.currentHead && input.reviewState?.headSha
    && input.currentHead !== input.reviewState.headSha
    && !(input.hammerHead || input.closerAuthoredStale?.hammerHead)
    && !input.closerAuthoredStale?.carryForward && input.attested !== true);
}

// Exhaustion ends remediation rounds, not the obligation to review a builder's
// new content. Callers must classify the live commit before granting admission.
export function owesExhaustedHeadVerdict({ exhausted, headSha, reviewedHeadSha, closerAuthored = false,
  deliveredReviews = 0 } = {}) {
  return exhausted === true && Boolean(headSha && reviewedHeadSha && headSha !== reviewedHeadSha)
    && closerAuthored === false && deliveredReviews === 0;
}

export const exhaustedHeadVerdictReason = headSha => `system-exhausted-head-verdict:${headSha}`;
export function isExhaustedHeadVerdictRequested(row, headSha) {
  return Boolean(headSha && row?.rereview_requested_at && row.revision_ref === headSha
    && row.rereview_reason === exhaustedHeadVerdictReason(headSha));
}

// Admission only: the normal claim CAS, retry limits and pass journal still own
// execution. A completed delivered pass prevents re-admission even after a
// later push away from, and back to, the same commit.
export async function admitExhaustedHeadVerdict({ exhausted, headSha, row,
  countDelivered, classifyCloser, request, readRow, lifetimeExhausted = false }) {
  if (isExhaustedHeadVerdictRequested(row, headSha)) return row;
  if (lifetimeExhausted || !exhausted || !headSha || !row || row.reviewer_head_sha === headSha
    || countDelivered() !== 0) return row;
  const closer = await classifyCloser();
  if (!owesExhaustedHeadVerdict({ exhausted, headSha,
    reviewedHeadSha: row.reviewer_head_sha, closerAuthored: closer.suppressed })) return row;
  request({ targetRevisionRef: headSha, reason: exhaustedHeadVerdictReason(headSha),
    preserveBudgets: true, ownerlessRecovery: true });
  return readRow();
}
