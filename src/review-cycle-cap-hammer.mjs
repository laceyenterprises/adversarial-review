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
// the same coexistence path the reviewer-timeout hand-off uses. The closer owns the hammer: lease,
// per-head retry cap, lifetime ceiling and every merge predicate are unchanged.
// The operator is paged only for the two route-ending outcomes: the hammer's
// final no-merge decision, or an exhausted hammer retry cap.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMergeAgentCoexistenceForWatcher } from './ama-closure-orchestration.mjs';
import {
  REVIEW_CYCLE_CAP_HAMMER_PAGE_EVENT,
  reviewCycleCapHammerFinalOutcome,
} from './ama/review-cycle-cap-route.mjs';
import { buildMergeAgentDispatchJob, fetchMergeAgentCandidate } from './follow-up-merge-agent.mjs';
import {
  PAUSED_FOR_REDESIGN_LABEL,
  REVIEWER_CYCLE_CAP_REACHED_LABEL,
  hasReviewCycleEscalated,
  recentReviewCycleVerdicts,
} from './review-cycle-cap.mjs';
import { isAutomaticReviewCycleCapPause, normalizeLabelNames } from './review-cycle-cap-actions.mjs';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function defaultDeliverAlert(text, options) {
  const { deliverAlert } = await import('./alert-delivery.mjs');
  return deliverAlert(text, options);
}

async function pageReviewCycleCapHammerOutcome({
  repoPath,
  prNumber,
  headSha,
  outcome,
  amaClosureResult,
  deliverAlertImpl,
  logger,
}) {
  const reason = amaClosureResult?.reason || outcome;
  const text = outcome === 'hammer-no-merge'
    ? `SEV1 ${repoPath}#${prNumber}: review cycle cap reached and the hammer's final adjudication is NO MERGE `
      + `(head ${String(headSha || 'unknown').slice(0, 12)}). Read its closing-status comment on the PR.`
    : `SEV1 ${repoPath}#${prNumber}: review cycle cap reached and the hammer retry cap is exhausted `
      + `(${reason}, head ${String(headSha || 'unknown').slice(0, 12)}) without a merge.`;
  try {
    // The outbox identity is stable per repo#pr@head, so a repeat tick re-uses
    // the queued or delivered page instead of paging again.
    const delivery = await deliverAlertImpl(text, {
      event: REVIEW_CYCLE_CAP_HAMMER_PAGE_EVENT,
      payload: {
        severity: 'SEV1',
        repo: repoPath,
        prNumber,
        headSha: headSha || null,
        outcome,
        reason,
        launchRequestId: amaClosureResult?.launchRequestId || null,
      },
    });
    return { paged: true, delivery };
  } catch (err) {
    logger?.error?.(
      `[watcher] review-cycle-cap hammer page failed for ${repoPath}#${prNumber}: ${err?.message || err}`
    );
    return { paged: false, error: err };
  }
}

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
  rootDir = ROOT,
  db,
  repoPath,
  prNumber,
  existing,
  subjectRef = null,
  currentRevisionRef = null,
  labelNames = [],
  cap = null,
  execFileImpl = execFileAsync,
  fetchMergeAgentCandidateImpl = fetchMergeAgentCandidate,
  buildMergeAgentDispatchJobImpl = buildMergeAgentDispatchJob,
  resolveMergeAgentCoexistenceForWatcherImpl = resolveMergeAgentCoexistenceForWatcher,
  deliverAlertImpl = defaultDeliverAlert,
  logger = console,
} = {}) {
  if (!isReviewCycleCapRoutedToHammer({ db, repoPath, prNumber, reviewRow: existing, labelNames })) {
    return { handled: false, reason: 'not-review-cycle-cap-paused' };
  }
  try {
    const candidate = await fetchMergeAgentCandidateImpl(repoPath, prNumber, { rootDir, execFileImpl });
    let reviewCycleHistory = [];
    try {
      reviewCycleHistory = db ? recentReviewCycleVerdicts(db, { repo: repoPath, prNumber, limit: cap || undefined }) : [];
    } catch (err) {
      logger?.warn?.(
        `[watcher] review-cycle-cap history read failed for ${repoPath}#${prNumber}: ${err?.message || err}`
      );
    }
    const dispatchJob = {
      ...buildMergeAgentDispatchJobImpl(rootDir, candidate, { reviewStateDb: db }),
      reviewCycleCapReached: true,
      reviewCycleCap: cap,
      reviewCycleHistory,
    };
    // Admission resets clear reviewer_head_sha. The successful verdict ledger
    // outlives those resets and pins the hammer to the last actual review,
    // never to the unreviewed live head or a later failed reviewer attempt.
    const reviewedHeadSha = reviewCycleHistory.at(-1)?.head_sha || existing?.reviewer_head_sha;
    if (!reviewedHeadSha) throw new Error('review-cycle-cap authoritative reviewed head unavailable');
    const coexistenceDecision = await resolveMergeAgentCoexistenceForWatcherImpl({
      rootDir,
      reviewStateRow: { ...existing, reviewer_head_sha: reviewedHeadSha },
      dispatchJob,
      candidate,
      labelNames: normalizeLabelNames(Array.isArray(candidate?.labels) ? candidate.labels : labelNames),
      repoPath,
      prNumber,
      currentRevisionRef,
      logger,
    });
    const { outcome, amaClosureResult } = coexistenceDecision || {};
    if (outcome === 'pr-terminal') {
      logger?.log?.(
        `[watcher] review-cycle-cap hammer route closed for ${repoPath}#${prNumber}: PR already ` +
          `${coexistenceDecision.terminalReason}`
      );
      return { handled: true, outcome, prTerminal: true };
    }
    const finalOutcome = reviewCycleCapHammerFinalOutcome(amaClosureResult);
    if (finalOutcome) {
      const headSha = candidate?.headSha || currentRevisionRef || subjectRef?.revisionRef || null;
      const page = await pageReviewCycleCapHammerOutcome({
        repoPath, prNumber, headSha, outcome: finalOutcome, amaClosureResult, deliverAlertImpl, logger,
      });
      logger?.warn?.(
        `[watcher] review-cycle-cap hammer route ended for ${repoPath}#${prNumber}: ${finalOutcome} ` +
          `(${amaClosureResult?.reason}); operator ${page.paged ? 'paged' : 'page failed'}`
      );
      return { handled: true, outcome: finalOutcome, amaClosureResult, page };
    }
    if (outcome === 'dispatch-merge-agent') {
      // AMA is disabled or failed to dispatch. The hammer is the only final
      // adjudicator on this route, so the capped PR waits for the next tick
      // rather than falling through to the legacy merge-agent lane.
      logger?.warn?.(
        `[watcher] review-cycle-cap hammer route unavailable for ${repoPath}#${prNumber}: ` +
          `${amaClosureResult?.reason || 'ama-not-dispatched'}; retrying next tick`
      );
      return { handled: true, outcome: 'hammer-unavailable', amaClosureResult };
    }
    logger?.log?.(
      `[watcher] review-cycle-cap routed ${repoPath}#${prNumber} to the hammer for final adjudication: ` +
        `${outcome || 'unknown'} (${amaClosureResult?.reason || (amaClosureResult?.dispatched ? 'dispatched' : 'pending')}) ` +
        `lrq=${amaClosureResult?.launchRequestId || amaClosureResult?.dispatchId || 'none'}`
    );
    return { handled: true, outcome, amaClosureResult };
  } catch (err) {
    logger?.error?.(
      `[watcher] review-cycle-cap hammer route failed for ${repoPath}#${prNumber}: ${err?.message || err}`
    );
    return { handled: false, error: err };
  }
}
