// ARC-11 — review pipeline kernel logic.
//
// Pure, I/O-free selection logic for the review pipeline contract defined in
// contracts.d.ts. A review is an ordered list of stages; each stage runs a
// panel of reviewer roles and folds their verdicts under an aggregation
// policy. This module owns the four decisions the kernel needs and nothing
// else: it names no concrete system, performs no I/O, and reads no clock.
//
//   - aggregatePanel        fold a stage's panel verdicts -> clean|blocked|incomplete
//   - resolveStageRoundBudget / resolveSubjectRemediationCeiling  budgets
//   - activeStageIndex / stagesToRerunAfterRemediation            stage ordering
//   - invalidateStagesOnRevisionAdvance                           head-move handling
//   - deriveLatestVerdict                                         the deprecated alias
//
// Production multi-stage enablement is ARC-13; this module is contract + logic.

/**
 * @typedef {import('./contracts.js').Verdict} Verdict
 * @typedef {import('./contracts.js').RiskClass} RiskClass
 * @typedef {import('./contracts.js').AggregationPolicy} AggregationPolicy
 * @typedef {import('./contracts.js').ReviewStage} ReviewStage
 * @typedef {import('./contracts.js').ReviewPipeline} ReviewPipeline
 * @typedef {import('./contracts.js').PanelVerdict} PanelVerdict
 * @typedef {import('./contracts.js').PipelineStageState} PipelineStageState
 * @typedef {import('./contracts.js').StageDecision} StageDecision
 */

/** The single-reviewer default: any blocking verdict blocks the stage. */
export const DEFAULT_AGGREGATION = 'any-blocking-blocks';

/**
 * A verdict is "clean" when it carries no blocking findings and its kind is
 * not `request-changes`/`unknown`. `comment-only` and `approved` are clean.
 * `unknown` is never clean — an unparseable verdict must not pass a stage.
 * @param {Verdict | null | undefined} verdict
 * @returns {boolean}
 */
export function isVerdictClean(verdict) {
  if (!verdict || typeof verdict !== 'object') return false;
  if (verdict.kind === 'request-changes' || verdict.kind === 'unknown') return false;
  const blocking = Array.isArray(verdict.blockingFindings) ? verdict.blockingFindings : [];
  return blocking.length === 0;
}

/**
 * Fold a stage's collected panel verdicts into a single decision.
 *
 * Returns `incomplete` until every panel role has a verdict pinned to the
 * candidate revision. Once complete, applies the aggregation policy. Verdicts
 * for a revision other than `revisionRef` are ignored (a head move invalidates
 * them; see invalidateStagesOnRevisionAdvance).
 *
 * @param {object} params
 * @param {readonly string[]} params.panel - reviewer roles that must vote
 * @param {AggregationPolicy} params.aggregation
 * @param {readonly PanelVerdict[]} params.panelVerdicts
 * @param {string} params.revisionRef - the candidate revision
 * @returns {{ decision: StageDecision, blockingFindings: readonly object[], missingRoles: readonly string[], reason: string }}
 */
export function aggregatePanel({ panel, aggregation, panelVerdicts, revisionRef } = {}) {
  const roles = Array.isArray(panel) ? panel : [];
  const votes = (Array.isArray(panelVerdicts) ? panelVerdicts : []).filter(
    (pv) => pv && pv.revisionRef === revisionRef,
  );
  // Keep only the newest vote per role (defensive against duplicate rows).
  const byRole = new Map();
  for (const pv of votes) byRole.set(pv.reviewerRole, pv);

  const missingRoles = roles.filter((role) => !byRole.has(role));
  const blockingFindings = [];
  for (const pv of byRole.values()) {
    if (!isVerdictClean(pv.verdict)) {
      const findings = Array.isArray(pv.verdict?.blockingFindings) ? pv.verdict.blockingFindings : [];
      blockingFindings.push(...findings);
    }
  }

  if (missingRoles.length > 0) {
    return {
      decision: 'incomplete',
      blockingFindings,
      missingRoles,
      reason: `awaiting ${missingRoles.length} of ${roles.length} panel verdict(s) at ${revisionRef}`,
    };
  }

  const cleanCount = [...byRole.values()].filter((pv) => isVerdictClean(pv.verdict)).length;
  const total = roles.length;
  const policy = normalizeAggregation(aggregation);

  let clean;
  switch (policy.kind) {
    case 'unanimous-clean':
      clean = cleanCount === total;
      break;
    case 'any-blocking-blocks':
      // Any non-clean vote blocks. This is "no reviewer requested changes",
      // NOT merely "zero structured blocking findings": a `request-changes`
      // verdict with no machine-parsed findings still blocks the stage.
      clean = cleanCount === total;
      break;
    case 'quorum':
      clean = cleanCount >= policy.n;
      break;
    case 'weighted': {
      let cleanWeight = 0;
      for (const pv of byRole.values()) {
        if (isVerdictClean(pv.verdict)) cleanWeight += policy.weights[pv.reviewerRole] ?? 0;
      }
      clean = cleanWeight >= policy.threshold;
      break;
    }
    default:
      clean = blockingFindings.length === 0;
  }

  return {
    decision: clean ? 'clean' : 'blocked',
    blockingFindings,
    missingRoles: [],
    reason: `${policy.kind}: ${cleanCount}/${total} clean`,
  };
}

/**
 * Normalize an aggregation policy into a discriminated object with a `kind`.
 * @param {AggregationPolicy | null | undefined} aggregation
 */
export function normalizeAggregation(aggregation) {
  if (aggregation === 'unanimous-clean') return { kind: 'unanimous-clean' };
  if (aggregation === 'any-blocking-blocks' || aggregation == null) {
    return { kind: 'any-blocking-blocks' };
  }
  if (typeof aggregation === 'object' && aggregation.kind === 'quorum') {
    const n = Number.isInteger(aggregation.n) && aggregation.n > 0 ? aggregation.n : 1;
    return { kind: 'quorum', n };
  }
  if (typeof aggregation === 'object' && aggregation.kind === 'weighted') {
    return {
      kind: 'weighted',
      weights: aggregation.weights && typeof aggregation.weights === 'object' ? aggregation.weights : {},
      threshold: typeof aggregation.threshold === 'number' ? aggregation.threshold : 0,
    };
  }
  throw new PipelineContractError(`unknown aggregation policy: ${JSON.stringify(aggregation)}`, {
    reason: 'unknown-aggregation',
  });
}

/**
 * Resolve the remediation-round budget for a single stage at a risk class.
 * Falls back to the domain-level riskClasses budget, then 0.
 *
 * @param {object} params
 * @param {ReviewStage} params.stage
 * @param {RiskClass} params.riskClass
 * @param {{ [K in RiskClass]?: { maxRemediationRounds?: number } }} [params.domainRiskClasses]
 * @returns {number}
 */
export function resolveStageRoundBudget({ stage, riskClass, domainRiskClasses } = {}) {
  const stageBudget = stage?.roundBudgetByRisk?.[riskClass];
  if (Number.isInteger(stageBudget) && stageBudget >= 0) return stageBudget;
  const domainBudget = domainRiskClasses?.[riskClass]?.maxRemediationRounds;
  if (Number.isInteger(domainBudget) && domainBudget >= 0) return domainBudget;
  return 0;
}

/**
 * Resolve the subject-level remediation ceiling: the sum of per-stage budgets
 * for the risk class, capped by an explicit `subjectRemediationCeiling` when
 * the pipeline sets one. This is what stops a multi-stage pipeline from
 * multiplying hammer cycles past the operator's tolerance.
 *
 * @param {object} params
 * @param {ReviewPipeline} params.pipeline
 * @param {RiskClass} params.riskClass
 * @param {{ [K in RiskClass]?: { maxRemediationRounds?: number } }} [params.domainRiskClasses]
 * @returns {number}
 */
export function resolveSubjectRemediationCeiling({ pipeline, riskClass, domainRiskClasses } = {}) {
  const stages = pipeline?.stages ?? [];
  const sum = stages.reduce(
    (acc, stage) => acc + resolveStageRoundBudget({ stage, riskClass, domainRiskClasses }),
    0,
  );
  const explicit = pipeline?.subjectRemediationCeiling;
  if (Number.isInteger(explicit) && explicit >= 0) return Math.min(sum, explicit);
  return sum;
}

/**
 * Index of the active (first not-yet-clean) stage at a revision. A later stage
 * runs only when every prior stage is clean at `revisionRef`. Returns the
 * pipeline length when all stages are clean (nothing left to run).
 *
 * @param {object} params
 * @param {ReviewPipeline} params.pipeline
 * @param {readonly PipelineStageState[]} params.stageStates
 * @param {string} params.revisionRef
 * @returns {number}
 */
export function activeStageIndex({ pipeline, stageStates, revisionRef } = {}) {
  const stages = pipeline?.stages ?? [];
  for (let i = 0; i < stages.length; i += 1) {
    const stage = stages[i];
    const state = (stageStates ?? []).find((s) => s.stageId === stage.id);
    const decision = aggregatePanel({
      panel: stage.panel,
      aggregation: stage.aggregation,
      panelVerdicts: state?.panelVerdicts ?? [],
      revisionRef,
    }).decision;
    if (decision !== 'clean') return i;
  }
  return stages.length;
}

/**
 * Stage ids to re-run after a remediation: the stage that blocked plus every
 * downstream stage. Upstream clean stages are NOT re-run for the same
 * revision — remediation for a stage-2 finding re-runs stage 2 (and beyond),
 * not stage 1.
 *
 * @param {object} params
 * @param {ReviewPipeline} params.pipeline
 * @param {string} params.failedStageId
 * @returns {readonly string[]}
 */
export function stagesToRerunAfterRemediation({ pipeline, failedStageId } = {}) {
  const stages = pipeline?.stages ?? [];
  const idx = stages.findIndex((s) => s.id === failedStageId);
  if (idx < 0) return [];
  return stages.slice(idx).map((s) => s.id);
}

/**
 * Handle a head move: any stage that is not clean at the new revision is
 * invalidated (its verdicts pinned to the old revision no longer count). A
 * stage already clean at the new revision — because its panel re-voted on it —
 * is preserved. Returns the new stage-state array with stale verdicts dropped.
 *
 * @param {object} params
 * @param {ReviewPipeline} params.pipeline
 * @param {readonly PipelineStageState[]} params.stageStates
 * @param {string} params.newRevisionRef
 * @returns {readonly PipelineStageState[]}
 */
export function invalidateStagesOnRevisionAdvance({ pipeline, stageStates, newRevisionRef } = {}) {
  const stages = pipeline?.stages ?? [];
  return stages.map((stage, stageIndex) => {
    const prior = (stageStates ?? []).find((s) => s.stageId === stage.id);
    const keptVerdicts = (prior?.panelVerdicts ?? []).filter(
      (pv) => pv.revisionRef === newRevisionRef,
    );
    return { stageId: stage.id, stageIndex, panelVerdicts: keptVerdicts };
  });
}

/**
 * The deprecated `latestVerdict` alias: the newest verdict of the active
 * stage. "Newest" is the last verdict recorded for the active stage's panel;
 * when the pipeline is absent (single-stage legacy subject) this returns the
 * subject's own `latestVerdict` unchanged so every existing consumer stays
 * green.
 *
 * @param {object} subjectState - a SubjectState-shaped object
 * @param {object} [opts]
 * @param {ReviewPipeline} [opts.pipeline]
 * @returns {Verdict | undefined}
 */
export function deriveLatestVerdict(subjectState, { pipeline } = {}) {
  const stageStates = subjectState?.pipeline;
  if (!Array.isArray(stageStates) || stageStates.length === 0) {
    return subjectState?.latestVerdict;
  }
  const revisionRef = subjectState?.ref?.revisionRef ?? subjectState?.headSha;
  const idx = pipeline
    ? activeStageIndex({ pipeline, stageStates, revisionRef })
    : stageStates.length - 1;
  // When all stages are clean, the alias reflects the last stage's newest
  // verdict; otherwise the active (blocking/incomplete) stage's newest verdict.
  const active = stageStates[Math.min(idx, stageStates.length - 1)];
  const verdicts = active?.panelVerdicts ?? [];
  if (verdicts.length === 0) return subjectState?.latestVerdict;
  return verdicts[verdicts.length - 1].verdict;
}

/**
 * Build the single-stage pipeline that is behaviourally identical to the
 * pre-pipeline model: one stage, one reviewer role, any-blocking-blocks. Used
 * so a domain without an explicit `pipeline` still flows through this contract.
 *
 * @param {object} params
 * @param {string} [params.stageId]
 * @param {string} params.reviewerRole
 * @param {{ [K in RiskClass]?: { maxRemediationRounds?: number } }} [params.domainRiskClasses]
 * @returns {ReviewPipeline}
 */
export function singleStagePipeline({ stageId = 'code-review', reviewerRole, domainRiskClasses } = {}) {
  const roundBudgetByRisk = {};
  for (const risk of ['low', 'medium', 'high', 'critical']) {
    const budget = domainRiskClasses?.[risk]?.maxRemediationRounds;
    if (Number.isInteger(budget)) roundBudgetByRisk[risk] = budget;
  }
  return {
    stages: [
      {
        id: stageId,
        panel: [reviewerRole],
        aggregation: DEFAULT_AGGREGATION,
        roundBudgetByRisk,
      },
    ],
  };
}

/** Classified error for malformed pipeline contract inputs. */
export class PipelineContractError extends Error {
  constructor(message, { reason = null } = {}) {
    super(message);
    this.name = 'PipelineContractError';
    this.class = 'pipeline-contract';
    this.reason = reason;
  }
}
