// ── Review-cycle cap → hammer final adjudication ──────────────────────────────
//
// CYCLECAPHAM-01 (SEV1). Operator decisions, 2026-10-10: "Hammers judgement is
// final", and any operator action outside a critical safety requirement is a
// SEV1. agent-os PR 7956 reached the cap, was told "operator attention
// required", and sat ~10h at CHANGES_REQUESTED until it was merged by hand.
//
// The cap label stays on (so first-pass suppression never spawns another
// reviewer) and the PR never re-enters the posted-review phase. The `failed`
// cap row itself is re-armed to `pending` once the head has moved past the
// last reviewed head, so the durable cap signal is the label backed by the
// watcher's own escalation marker. This hook runs on every watcher tick for a
// capped PR and hands it to the ordinary AMA closer with `reviewCycleCapReached`,
// through the hammer-owner route it shares with CIBLOCKHAM-01
// (src/hammer-owner-route.mjs). The closer owns the hammer: lease, per-head
// retry cap, lifetime ceiling and every merge predicate are unchanged. The
// operator is paged only for the two route-ending outcomes: the hammer's final
// no-merge decision, or an exhausted hammer retry cap.
import { routeToHammerOwner } from './hammer-owner-route.mjs';
import {
  PAUSED_FOR_REDESIGN_LABEL,
  REVIEWER_CYCLE_CAP_REACHED_LABEL,
  hasReviewCycleEscalated,
  recentReviewCycleVerdicts,
} from './review-cycle-cap.mjs';
import { isAutomaticReviewCycleCapPause, normalizeLabelNames } from './review-cycle-cap-actions.mjs';

// The watcher capped this PR: an automatic cap row, or the cap label backed by
// the watcher's own escalation marker (a hand-applied label alone never
// summons a hammer). An operator `paused-for-redesign` is a decision, not a cap.
export function isReviewCycleCapRoutedToHammer({ db, repoPath, prNumber, reviewRow, labelNames = [] } = {}) {
  const labels = new Set(normalizeLabelNames(labelNames));
  if (labels.has(PAUSED_FOR_REDESIGN_LABEL)) return false;
  if (String(reviewRow?.failure_message || '').includes(`operator selected ${PAUSED_FOR_REDESIGN_LABEL}`)) return false;
  if (isAutomaticReviewCycleCapPause(reviewRow)) return true;
  if (!labels.has(REVIEWER_CYCLE_CAP_REACHED_LABEL) || !db) return false;
  try {
    return hasReviewCycleEscalated(db, { repo: repoPath, prNumber });
  } catch {
    return false;
  }
}

export async function maybeRouteReviewCycleCapToHammer({
  db,
  repoPath,
  prNumber,
  existing,
  labelNames = [],
  cap = null,
  logger = console,
  ...routeOptions
} = {}) {
  if (!isReviewCycleCapRoutedToHammer({ db, repoPath, prNumber, reviewRow: existing, labelNames })) {
    return { handled: false, reason: 'not-review-cycle-cap-paused' };
  }
  let reviewCycleHistory = [];
  try {
    reviewCycleHistory = db ? recentReviewCycleVerdicts(db, { repo: repoPath, prNumber, limit: cap || undefined }) : [];
  } catch (err) {
    logger?.warn?.(
      `[watcher] review-cycle-cap history read failed for ${repoPath}#${prNumber}: ${err?.message || err}`
    );
  }
  // Admission resets clear reviewer_head_sha. The successful verdict ledger
  // outlives those resets and pins the hammer to the last actual review,
  // never to the unreviewed live head or a later failed reviewer attempt.
  return routeToHammerOwner({
    ...routeOptions,
    route: 'review-cycle-cap',
    db,
    repoPath,
    prNumber,
    existing,
    labelNames,
    logger,
    reviewedHeadSha: reviewCycleHistory.at(-1)?.head_sha || existing?.reviewer_head_sha,
    dispatchJobFields: { reviewCycleCap: cap, reviewCycleHistory },
  });
}
