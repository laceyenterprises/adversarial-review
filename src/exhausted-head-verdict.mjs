import { inspectMergeLeaseReviewCustody, withMergeLeaseReviewClaim } from './ama/merge-lease.mjs';
import { isDisputedFindingsReviewIntent } from './explicit-review-intent.mjs';
import { DISPUTE_REVIEW_REASON } from './remediation-dispute-handoff.mjs';

// Shared closure evidence: only a new builder head gets a new review/budget
// episode. A closer's pushed head stays in its existing reviewed-head series.
export function hasUnreviewedBuilderHead(input = {}) {
  // A missing closer proof is not builder provenance. Only the watcher
  // admission receipt proves it classified this exact new head; final-round
  // pushes and existing closer series must retain their owner.
  return Boolean(isExhaustedHeadVerdictRequested(input.reviewAdmissionRow, input.currentHead)
    && input.currentHead && input.reviewState?.headSha
    && input.currentHead !== input.reviewState.headSha
    && !(input.hammerHead || input.closerAuthoredStale?.hammerHead)
    && !input.closerAuthoredStale?.carryForward && input.attested !== true
    && !(input.finalPush?.suppressed === true && input.finalPush.headSha === input.currentHead));
}

// Exhaustion ends remediation rounds, not the obligation to review a builder's
// new content. Callers must classify the live commit before granting admission.
export function owesExhaustedHeadVerdict({ exhausted, headSha, reviewedHeadSha, closerAuthored = false,
  deliveredReviews = 0 } = {}) {
  return exhausted === true && Boolean(headSha && reviewedHeadSha
    && headSha.toLowerCase() !== reviewedHeadSha.toLowerCase())
    && closerAuthored === false && deliveredReviews === 0;
}

export const exhaustedHeadVerdictReason = headSha => `system-exhausted-head-verdict:${headSha}`;
const REPAIR_HEAD_REASON = /^system-repair-epoch:repair-[a-f0-9-]+:([a-f0-9]{40})$/i;
function isSystemExhaustedHeadVerdictRequested(row, headSha) {
  // Subject identity backfill can clear revision_ref on a legacy queued row.
  // The exact SHA in the system marker still binds the request.
  return Boolean(headSha && row?.rereview_requested_at
    && row.rereview_reason === exhaustedHeadVerdictReason(headSha)
    && (!row.revision_ref || row.revision_ref.toLowerCase() === headSha.toLowerCase()));
}

export function isRepairEpochReviewRequested(row, headSha) {
  if (!headSha || !row?.rereview_requested_at
    || row.revision_ref?.toLowerCase() !== headSha.toLowerCase()) return false;
  return REPAIR_HEAD_REASON.exec(row.rereview_reason || '')?.[1].toLowerCase() === headSha.toLowerCase();
}

export function isExhaustedHeadVerdictRequested(row, headSha) {
  return isSystemExhaustedHeadVerdictRequested(row, headSha) || isRepairEpochReviewRequested(row, headSha);
}

export function isAutomaticClosureReviewRequested(row, headSha, readDeliveredHead = () => null) {
  if (row?.failed_at) return false;
  if (isExhaustedHeadVerdictRequested(row, headSha)) return true;
  // A stale refresh is only competing closure work after a delivered review.
  // Its revision binds the successor even when the pending row cleared the
  // previous reviewer head.
  if (!headSha || row?.revision_ref !== headSha || !row.rereview_requested_at
    || !row.rereview_reason?.startsWith('auto-refresh: posted review on stale head')) return false;
  const reviewedHead = readDeliveredHead();
  return Boolean(reviewedHead && reviewedHead !== headSha);
}

function mergeCustodyReviewKind(row, headSha, hasPriorityIntent, readDeliveredHead) {
  if (row?.failed_at) return null;
  if (row?.rereview_reason === DISPUTE_REVIEW_REASON) {
    return isDisputedFindingsReviewIntent(hasPriorityIntent(), headSha) ? 'dispute' : null;
  }
  return isAutomaticClosureReviewRequested(row, headSha, readDeliveredHead) && !hasPriorityIntent()
    ? 'automatic' : null;
}

// Scheduling hint only; the claim transaction still owns the final decision.
export function exhaustedHeadMergeCustodyDeferral({ row, hasPriorityIntent, readDeliveredHead, ...identity }) {
  if (!mergeCustodyReviewKind(row, identity.headSha, hasPriorityIntent, readDeliveredHead)) return null;
  return inspectMergeLeaseReviewCustody(identity).reason;
}

// Operator priority keeps ordinary admission. The watchdog's same-head dispute
// receipt bypasses review deduplication and still checks native custody. Classify
// the current row and receipt in the claim transaction.
export function claimWithExhaustedHeadMergeCustody({
  db, readRow, hasPriorityIntent, readDeliveredHead, closureDeferral, ...identity
}, claim) {
  const { headSha } = identity;
  const attempt = db.transaction(mergeHold => {
    const row = readRow();
    const kind = mergeCustodyReviewKind(row, headSha, hasPriorityIntent, readDeliveredHead);
    if (kind && mergeHold === undefined) return null;
    if (kind && mergeHold) return { reason: mergeHold };
    const reason = kind === 'automatic' && closureDeferral?.(row);
    if (reason) return { reason };
    return { claim: claim(row) };
  }).immediate;
  return attempt() ?? withMergeLeaseReviewClaim(identity, attempt);
}

// Admission only: the normal claim CAS, retry limits and pass journal still own
// execution. A completed delivered pass prevents re-admission even after a
// later push away from, and back to, the same commit.
export async function admitExhaustedHeadVerdict({ exhausted, headSha, row,
  countDelivered, classifyCloser, request, readRow, lifetimeExhausted = false,
  repairEpoch = null, bindRepair = null }) {
  // Code-PR revision references must survive the canonical SHA normalizer.
  // Refuse malformed input before mutating the review row.
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(headSha)) return row;
  if (isExhaustedHeadVerdictRequested(row, headSha)) return row;
  if ((!repairEpoch && (lifetimeExhausted || !exhausted)) || !headSha || !row
    || row.reviewer_head_sha?.toLowerCase() === headSha.toLowerCase()
    || countDelivered() !== 0) return row;
  const closer = await classifyCloser();
  if (repairEpoch ? closer.suppressed : !owesExhaustedHeadVerdict({ exhausted, headSha,
    reviewedHeadSha: row.reviewer_head_sha, closerAuthored: closer.suppressed })) return row;
  if (repairEpoch && !bindRepair?.(repairEpoch)) return row;
  request({ targetRevisionRef: headSha, reason: repairEpoch
    ? `system-repair-epoch:${repairEpoch.id}:${headSha}` : exhaustedHeadVerdictReason(headSha),
    preserveBudgets: !repairEpoch, ownerlessRecovery: true });
  return readRow();
}
