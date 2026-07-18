// Sequential review-pipeline driver (ARC-13). Orchestrates a resolved
// multi-stage `ReviewPipeline` (see `domain-pipeline.mjs`) over a subject's
// verdict history: it runs stages in order, gates each later stage on every
// prior stage being clean at the current revision, stops at the first blocking
// stage, renders the Win 2 rollup, and returns the updated per-stage state plus
// the remediation budget plan.
//
// The driver owns SEQUENCING and AGGREGATION only. It never spawns a process,
// reads GitHub, or writes a DB: the two side effects — running one stage's
// review, and posting the rollup — are injected (`runStageReview`, `postRollup`).
// That keeps the driver a pure function of its inputs plus those effects, so the
// fixture e2e drives it with a stub reviewer and an in-memory comms sink, while
// the watcher seam wires the real reviewer runtime + github-pr-comments adapter.
//
// Downstream-only re-review (the ARC-13 "Don't"): because each stage is
// aggregated over ONLY the verdicts pinned to `currentRevisionRef`, a stage
// whose clean verdict already pins to the current revision is carried forward
// (never re-run); the driver re-runs the failed stage and its downstream only.
// A stage-2 remediation at the same revision therefore re-runs stage 2, never
// stage 1. (A revision advance leaves stage 1 with no current-revision verdict,
// so it re-runs from the first stage — the kernel's revision-invalidation rule.)

import {
  aggregateStageVerdict,
  classifyVerdictDisposition,
  newestVerdict,
  resolveRemediationBudgetPlan,
  resolveStageRoundBudget,
  stageVerdictsForRevision,
} from './kernel/pipeline.mjs';
import { renderPipelineRollup } from './kernel/pipeline-rollup.mjs';

/**
 * @typedef {import('./kernel/contracts.js').Stage} Stage
 * @typedef {import('./kernel/contracts.js').StageState} StageState
 * @typedef {import('./kernel/contracts.js').Verdict} Verdict
 */

function toStageStateMap(stageStates) {
  const byId = new Map();
  for (const state of Array.isArray(stageStates) ? stageStates : []) {
    if (state && typeof state.stageId === 'string') {
      byId.set(state.stageId, {
        stageId: state.stageId,
        stageIndex: state.stageIndex,
        panelVerdicts: Array.isArray(state.panelVerdicts) ? [...state.panelVerdicts] : [],
      });
    }
  }
  return byId;
}

function primaryRoleId(stage) {
  const first = Array.isArray(stage?.panel) ? stage.panel[0] : null;
  return first?.id ?? null;
}

// Count the blocking findings a stage routes to remediation: the sum of
// structured `blockingFindings` across the stage's blocking current-revision
// verdicts, falling back to the count of blocking verdicts when a reviewer
// requested changes without emitting structured findings.
function countBlockingFindings(verdicts) {
  let structured = 0;
  let blockingVerdicts = 0;
  for (const verdict of verdicts) {
    if (classifyVerdictDisposition(verdict) !== 'blocking') continue;
    blockingVerdicts += 1;
    if (Array.isArray(verdict.blockingFindings)) structured += verdict.blockingFindings.length;
  }
  return structured > 0 ? structured : blockingVerdicts;
}

function stampVerdict(verdict, { stageId, roleId, revisionRef, observedAt }) {
  return {
    ...verdict,
    stageId,
    reviewerRoleId: verdict?.reviewerRoleId ?? roleId ?? undefined,
    revisionRef: verdict?.revisionRef ?? revisionRef,
    observedAt: verdict?.observedAt ?? observedAt,
  };
}

/**
 * Drive one review pass over a resolved pipeline.
 *
 * @param {{
 *   resolvedPipeline: { pipeline: readonly Stage[], stages: Array<{ stage: Stage }> },
 *   stageStates?: readonly StageState[],
 *   currentRevisionRef: string,
 *   riskClass?: string,
 *   budgetOverride?: number | null,
 *   observedAt?: string,
 *   runStageReview: (ctx: {
 *     stage: Stage, stageIndex: number, roleId: string, model?: string,
 *     revisionRef: string, round: number, roundBudget: number,
 *   }) => Promise<Verdict | null> | (Verdict | null),
 *   postRollup?: (rollup: { body: string, disposition: string, revisionRef: string }) =>
 *     Promise<unknown> | unknown,
 * }} params
 */
export async function runReviewPipeline({
  resolvedPipeline,
  stageStates = [],
  currentRevisionRef,
  riskClass,
  budgetOverride = null,
  observedAt,
  runStageReview,
  postRollup = null,
} = {}) {
  const pipeline = resolvedPipeline?.pipeline;
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    throw new TypeError('runReviewPipeline requires a resolved, non-empty pipeline');
  }
  if (typeof runStageReview !== 'function') {
    throw new TypeError('runReviewPipeline requires a runStageReview effect');
  }
  const revisionRef = String(currentRevisionRef ?? '').trim();
  if (!revisionRef) {
    throw new TypeError('runReviewPipeline requires a currentRevisionRef to pin verdicts to');
  }
  const stampAt = observedAt || new Date().toISOString();

  const stateById = toStageStateMap(stageStates);
  const rows = [];
  const ranStageIds = [];
  const carriedForwardStageIds = [];
  const notRunStageIds = [];

  let gateOpen = true;
  let disposition = 'clean';
  let blockingStageId = null;
  let pendingStageId = null;
  let blockingFindingsCount = 0;

  for (let stageIndex = 0; stageIndex < pipeline.length; stageIndex += 1) {
    const stage = pipeline[stageIndex];
    const roleId = primaryRoleId(stage);
    const panelSeat = Array.isArray(stage.panel) ? stage.panel[0] : null;
    const roundBudget = resolveStageRoundBudget(stage, riskClass);

    let state = stateById.get(stage.id);
    if (!state) {
      state = { stageId: stage.id, stageIndex, panelVerdicts: [] };
      stateById.set(stage.id, state);
    } else {
      state.stageIndex = stageIndex;
    }

    // The gate is closed: an upstream stage blocked or is pending, so this stage
    // does not run this pass.
    if (!gateOpen) {
      notRunStageIds.push(stage.id);
      rows.push({ stageId: stage.id, roleId, verdict: null, round: null, roundBudget });
      continue;
    }

    // Carry forward a stage that is already clean at the current revision: its
    // pinned clean verdict stands, so the stage is not re-reviewed.
    const currentBefore = stageVerdictsForRevision(state, revisionRef);
    const aggregatedBefore = aggregateStageVerdict(stage, currentBefore);
    if (aggregatedBefore.decision === 'clean') {
      carriedForwardStageIds.push(stage.id);
      const newest = newestVerdict(currentBefore);
      rows.push({
        stageId: stage.id,
        roleId: newest?.reviewerRoleId ?? roleId,
        verdict: newest?.kind ?? null,
        round: currentBefore.length,
        roundBudget,
      });
      continue;
    }

    // Run the stage: one review per panel seat (panel size 1 today; the loop
    // generalizes to parallel panels without kernel rework).
    const seats = Array.isArray(stage.panel) && stage.panel.length > 0 ? stage.panel : [panelSeat];
    for (const seat of seats) {
      const seatRoleId = seat?.id ?? roleId;
      const priorForRole = state.panelVerdicts.filter((v) =>
        (v?.reviewerRoleId ?? roleId) === seatRoleId && v?.revisionRef === revisionRef);
      const round = priorForRole.length + 1;
      const produced = await runStageReview({
        stage,
        stageIndex,
        roleId: seatRoleId,
        model: seat?.model,
        revisionRef,
        round,
        roundBudget,
      });
      if (produced) {
        state.panelVerdicts.push(stampVerdict(produced, {
          stageId: stage.id,
          roleId: seatRoleId,
          revisionRef,
          observedAt: stampAt,
        }));
      }
    }
    ranStageIds.push(stage.id);

    const currentAfter = stageVerdictsForRevision(state, revisionRef);
    const aggregatedAfter = aggregateStageVerdict(stage, currentAfter);
    const newest = newestVerdict(currentAfter);
    const priorForPrimary = state.panelVerdicts.filter((v) =>
      (v?.reviewerRoleId ?? roleId) === roleId && v?.revisionRef === revisionRef);
    rows.push({
      stageId: stage.id,
      roleId: newest?.reviewerRoleId ?? roleId,
      verdict: newest?.kind ?? 'unknown',
      round: priorForPrimary.length,
      roundBudget,
    });

    if (aggregatedAfter.decision === 'blocking') {
      gateOpen = false;
      disposition = 'blocking';
      blockingStageId = stage.id;
      blockingFindingsCount = countBlockingFindings(currentAfter);
    } else if (aggregatedAfter.decision !== 'clean') {
      // pending / indeterminate: withhold the downstream gate but do not treat
      // as a block (no remediation routed) — the stage simply has no verdict yet.
      gateOpen = false;
      disposition = disposition === 'blocking' ? disposition : 'pending';
      pendingStageId = pendingStageId ?? stage.id;
    }
  }

  const updatedStageStates = pipeline.map((stage, stageIndex) => {
    const state = stateById.get(stage.id) || { stageId: stage.id, stageIndex, panelVerdicts: [] };
    const verdicts = [...state.panelVerdicts];
    // Persist the full markdown `body` only for the newest verdict per role;
    // strip it from older ones so pipeline_stage_states_json does not
    // accumulate tens of KB per push/round over a PR's lifetime — only the
    // newest per-role verdict is needed for carry-forward extraction
    // (review #634). Body is recoverable from the comms channel if ever needed.
    const newestIndexByRole = new Map();
    verdicts.forEach((v, i) => newestIndexByRole.set(v?.reviewerRoleId ?? '', i));
    const panelVerdicts = verdicts.map((v, i) =>
      newestIndexByRole.get(v?.reviewerRoleId ?? '') === i || v?.body === undefined
        ? v
        : { ...v, body: undefined });
    return { stageId: stage.id, stageIndex, panelVerdicts };
  });

  const rollupBody = renderPipelineRollup({
    revisionRef,
    rows,
    disposition,
    blockingStageId,
    pendingStageId,
    blockingFindingsCount,
  });

  let rollupReceipt = null;
  // Do NOT post a rollup for a `pending` disposition (a reviewer returned no
  // verdict, e.g. a transient subprocess failure). A pending rollup would burn
  // the revision+round delivery-dedupe slot, so the successful retry's real
  // rollup (blocking/clean) is silently dropped as a duplicate and the PR is
  // stranded showing "PENDING" (review #634). The next tick re-runs and posts
  // the true verdict rollup.
  if (typeof postRollup === 'function' && disposition !== 'pending') {
    rollupReceipt = await postRollup({ body: rollupBody, disposition, revisionRef, rows });
  }

  return {
    disposition,
    complete: disposition === 'clean',
    blockingStageId,
    pendingStageId,
    blockingFindingsCount,
    rows,
    ranStageIds,
    carriedForwardStageIds,
    notRunStageIds,
    stageStates: updatedStageStates,
    budget: resolveRemediationBudgetPlan(pipeline, riskClass, { override: budgetOverride }),
    rollupBody,
    rollupReceipt,
  };
}
