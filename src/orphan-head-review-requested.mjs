// Durable watchdog intent names the exact head; a later push cannot inherit it.
export function isOrphanHeadReviewRequested(row, headSha) {
  return Boolean(row?.rereview_requested_at && headSha
    && row.rereview_reason === `system-orphan-head-review:${headSha}`
    && row.revision_ref === headSha);
}
