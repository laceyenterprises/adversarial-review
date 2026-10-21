// HAMNOREREVIEW-01: retained as the orchestration injection seam for older
// callers. A closer head stays with the hammer, including when validation or
// starting-base evidence is missing. Ordinary dispatch, leases, retry caps and
// safety holds decide its next pass; recovery must never request source review.
export async function recoverStrandedCloserHead() {
  return null;
}
