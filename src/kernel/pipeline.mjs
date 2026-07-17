// Pure kernel logic for the review pipeline contract (v2 app architecture
// §4.1–4.2). This module is runtime-free and side-effect-free: it folds panel
// verdicts through an aggregation policy, resolves per-stage round budgets and
// the subject-level remediation ceiling, computes stage invalidation on a
// revision advance, and resolves the deprecated `latestVerdict` alias.
//
// It deliberately imports nothing from the heavier follow-up/watcher modules so
// it can be unit-tested in isolation and reused by both the reviewer and
// merge-authority sides. Contract shapes live in `./contracts.d.ts`.

/**
 * @typedef {import('./contracts.js').Verdict} Verdict
 * @typedef {import('./contracts.js').RiskClass} RiskClass
 * @typedef {import('./contracts.js').Stage} Stage
 * @typedef {import('./contracts.js').StageState} StageState
 * @typedef {import('./contracts.js').ReviewPipeline} ReviewPipeline
 * @typedef {import('./contracts.js').AggregationPolicy} AggregationPolicy
 * @typedef {import('./contracts.js').PipelineDisposition} PipelineDisposition
 * @typedef {import('./contracts.js').RemediationBudgetPlan} RemediationBudgetPlan
 * @typedef {import('./contracts.js').SubjectState} SubjectState
 */

export const RISK_CLASSES = Object.freeze(['low', 'medium', 'high', 'critical']);

export const AGGREGATION_POLICY_KINDS = Object.freeze([
  'unanimous-clean',
  'any-blocking-blocks',
  'quorum',
  'weighted',
]);

const DEFAULT_RISK_CLASS = 'medium';

// Mirrors the v1 convergence budgets (`ROUND_BUDGET_BY_RISK_CLASS` in
// follow-up-jobs.mjs): higher-risk subjects get more remediation rounds before
// operator escalation. Used only as a defensive fallback when a stage omits or
// malforms a per-risk budget; well-formed `Stage.roundBudgetByRisk` supplies
// all four keys.
export const DEFAULT_ROUND_BUDGET_BY_RISK = Object.freeze({
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
});

// Subject-level remediation ceiling cap (§4.1): the default ceiling is the sum
// of per-stage budgets, capped here so a many-stage pipeline cannot multiply
// hammer cycles without bound. 8 admits two critical stages (4 + 4) at full
// budget while capping deeper pipelines; operators raise it per-subject via the
// `override` seam, not by editing this constant.
export const DEFAULT_REMEDIATION_CEILING_CAP = 8;

/**
 * @param {unknown} value
 * @param {RiskClass} [fallback]
 * @returns {RiskClass}
 */
export function normalizeRiskClass(value, fallback = DEFAULT_RISK_CLASS) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return RISK_CLASSES.includes(normalized) ? /** @type {RiskClass} */ (normalized) : fallback;
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * Fold a single verdict into its pipeline disposition. A verdict is `blocking`
 * when it requests changes OR carries any structured blocking finding (the v1
 * escalation rule); `clean` when it approves or is comment-only with no
 * blocking findings; otherwise `indeterminate` (an `unknown` verdict that is
 * neither a pass nor a block until a reviewer re-runs).
 *
 * @param {Verdict | null | undefined} verdict
 * @returns {'clean' | 'blocking' | 'indeterminate'}
 */
export function classifyVerdictDisposition(verdict) {
  if (!verdict || typeof verdict !== 'object') return 'indeterminate';
  if (verdict.kind === 'request-changes') return 'blocking';
  if (Array.isArray(verdict.blockingFindings) && verdict.blockingFindings.length > 0) {
    return 'blocking';
  }
  if (verdict.kind === 'approved' || verdict.kind === 'comment-only') return 'clean';
  return 'indeterminate';
}

/**
 * A verdict is valid review evidence for the given revision ONLY when its
 * `revisionRef` exactly matches. A verdict with no `revisionRef` matches no
 * revision (fails safe toward re-review), and no verdict matches when the
 * caller has no current revision to compare against.
 *
 * @param {Verdict | null | undefined} verdict
 * @param {string | null | undefined} revisionRef
 * @returns {boolean}
 */
export function stageVerdictAppliesToRevision(verdict, revisionRef) {
  const current = String(revisionRef ?? '').trim();
  if (!current) return false;
  const pinned = String(verdict?.revisionRef ?? '').trim();
  return pinned !== '' && pinned === current;
}

function verdictSortKey(verdict) {
  return String(verdict?.observedAt ?? '');
}

/**
 * Newest verdict by `observedAt` (ISO strings compare chronologically); ties
 * resolve to the later array position, so a caller that appends verdicts in
 * observation order gets the most recent one.
 *
 * @param {readonly Verdict[]} verdicts
 * @returns {Verdict | null}
 */
export function newestVerdict(verdicts) {
  if (!Array.isArray(verdicts) || verdicts.length === 0) return null;
  let best = null;
  let bestKey = null;
  for (const verdict of verdicts) {
    const key = verdictSortKey(verdict);
    if (best === null || key >= bestKey) {
      best = verdict;
      bestKey = key;
    }
  }
  return best;
}

/**
 * Verdicts for a stage that apply to the given revision (pinning filter).
 *
 * @param {StageState | null | undefined} stageState
 * @param {string | null | undefined} revisionRef
 * @returns {Verdict[]}
 */
export function stageVerdictsForRevision(stageState, revisionRef) {
  const verdicts = Array.isArray(stageState?.panelVerdicts) ? stageState.panelVerdicts : [];
  return verdicts.filter((verdict) => stageVerdictAppliesToRevision(verdict, revisionRef));
}

function panelRoleIds(stage) {
  const panel = Array.isArray(stage?.panel) ? stage.panel : [];
  return panel.map((role) => role?.id).filter((id) => typeof id === 'string' && id !== '');
}

// Newest verdict per panel role. A verdict is attributed by `reviewerRoleId`;
// an unattributed verdict is credited to the sole role of a single-role panel
// (the v1 shape) and otherwise ignored for a multi-role panel.
function resolvePanelRoleVerdicts(stage, verdicts) {
  const roleIds = panelRoleIds(stage);
  const soleRole = roleIds.length === 1 ? roleIds[0] : null;
  const roleSet = new Set(roleIds);
  const byRole = new Map();
  for (const verdict of Array.isArray(verdicts) ? verdicts : []) {
    const roleId = typeof verdict?.reviewerRoleId === 'string' && verdict.reviewerRoleId !== ''
      ? verdict.reviewerRoleId
      : soleRole;
    if (roleId == null || !roleSet.has(roleId)) continue;
    const prev = byRole.get(roleId);
    if (!prev || verdictSortKey(verdict) >= verdictSortKey(prev)) {
      byRole.set(roleId, verdict);
    }
  }
  return roleIds.map((id) => ({ roleId: id, verdict: byRole.get(id) ?? null }));
}

function roleWeight(policy, roleId) {
  const weight = policy?.weights?.[roleId];
  return Number.isFinite(weight) ? weight : 1;
}

/**
 * Fold a stage's panel verdicts into a single stage decision under its
 * aggregation policy. Callers that pin to a revision should pre-filter with
 * {@link stageVerdictsForRevision}. Returns the decision plus per-disposition
 * counts for observability.
 *
 * @param {Stage} stage
 * @param {readonly Verdict[]} panelVerdicts
 * @returns {{ stageId: string, decision: PipelineDisposition, policy: string,
 *   panelSize: number, cleanCount: number, blockingCount: number,
 *   indeterminateCount: number, missingCount: number }}
 */
export function aggregateStageVerdict(stage, panelVerdicts) {
  if (!stage || typeof stage !== 'object') {
    throw new TypeError('aggregateStageVerdict requires a stage');
  }
  const policy = stage.aggregation;
  const kind = policy?.kind;
  if (!AGGREGATION_POLICY_KINDS.includes(kind)) {
    throw new TypeError(`unknown aggregation policy: ${JSON.stringify(kind)}`);
  }

  const roleVerdicts = resolvePanelRoleVerdicts(stage, panelVerdicts);
  const panelSize = roleVerdicts.length;

  let cleanCount = 0;
  let blockingCount = 0;
  let indeterminateCount = 0;
  let missingCount = 0;
  for (const { verdict } of roleVerdicts) {
    if (verdict == null) {
      missingCount += 1;
      continue;
    }
    const disposition = classifyVerdictDisposition(verdict);
    if (disposition === 'clean') cleanCount += 1;
    else if (disposition === 'blocking') blockingCount += 1;
    else indeterminateCount += 1;
  }

  const base = {
    stageId: stage.id,
    policy: kind,
    panelSize,
    cleanCount,
    blockingCount,
    indeterminateCount,
    missingCount,
  };

  let decision;
  if (panelSize === 0) {
    decision = 'pending';
  } else if (kind === 'unanimous-clean') {
    if (blockingCount > 0) decision = 'blocking';
    else if (cleanCount === panelSize) decision = 'clean';
    else decision = 'pending';
  } else if (kind === 'any-blocking-blocks') {
    // Blocks on any blocking verdict; passes once every role has reported and
    // none block (an indeterminate role does NOT withhold the pass).
    if (blockingCount > 0) decision = 'blocking';
    else if (missingCount > 0) decision = 'pending';
    else decision = 'clean';
  } else if (kind === 'quorum') {
    const need = policy.quorum;
    if (!isPositiveInt(need)) {
      throw new TypeError('quorum policy requires a positive integer `quorum`');
    }
    const reachableClean = panelSize - blockingCount;
    if (cleanCount >= need) decision = 'clean';
    else if (reachableClean < need) decision = 'blocking';
    else decision = 'pending';
  } else {
    // weighted
    const threshold = policy.threshold;
    if (!(Number.isFinite(threshold) && threshold > 0)) {
      throw new TypeError('weighted policy requires a positive `threshold`');
    }
    let cleanWeight = 0;
    let blockingWeight = 0;
    let totalWeight = 0;
    for (const { roleId, verdict } of roleVerdicts) {
      const weight = roleWeight(policy, roleId);
      totalWeight += weight;
      if (verdict == null) continue;
      const disposition = classifyVerdictDisposition(verdict);
      if (disposition === 'clean') cleanWeight += weight;
      else if (disposition === 'blocking') blockingWeight += weight;
    }
    const reachableClean = totalWeight - blockingWeight;
    if (cleanWeight >= threshold) decision = 'clean';
    else if (reachableClean < threshold) decision = 'blocking';
    else decision = 'pending';
  }

  return { ...base, decision };
}

/**
 * Resolve one stage's remediation round budget for a risk class, falling back
 * to the default per-risk budget when the stage omits or malforms the value.
 *
 * @param {Stage} stage
 * @param {RiskClass | string} riskClass
 * @returns {number}
 */
export function resolveStageRoundBudget(stage, riskClass) {
  const risk = normalizeRiskClass(riskClass);
  const declared = stage?.roundBudgetByRisk?.[risk];
  return isPositiveInt(declared) ? declared : DEFAULT_ROUND_BUDGET_BY_RISK[risk];
}

/**
 * Resolve the subject-level remediation budget plan for a pipeline and risk
 * class: each stage's per-round budget, plus the capped subject-level ceiling
 * (§4.1). The default ceiling is the sum of per-stage budgets, clamped to
 * {@link DEFAULT_REMEDIATION_CEILING_CAP} but never below the largest single
 * stage; a positive `override` (operator raised-cap) sets the ceiling directly.
 *
 * @param {ReviewPipeline} pipeline
 * @param {RiskClass | string} riskClass
 * @param {{ cap?: number, override?: number | null }} [options]
 * @returns {RemediationBudgetPlan}
 */
export function resolveRemediationBudgetPlan(pipeline, riskClass, { cap = DEFAULT_REMEDIATION_CEILING_CAP, override = null } = {}) {
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    throw new TypeError('resolveRemediationBudgetPlan requires a non-empty pipeline');
  }
  const risk = normalizeRiskClass(riskClass);
  const perStage = pipeline.map((stage) => ({
    stageId: stage.id,
    roundBudget: resolveStageRoundBudget(stage, risk),
  }));
  const sum = perStage.reduce((total, entry) => total + entry.roundBudget, 0);
  const maxSingleStage = perStage.reduce((max, entry) => Math.max(max, entry.roundBudget), 0);

  let ceiling;
  let ceilingSource;
  if (isPositiveInt(override)) {
    ceiling = override;
    ceilingSource = 'override';
  } else {
    const effectiveCap = isPositiveInt(cap) ? cap : DEFAULT_REMEDIATION_CEILING_CAP;
    ceiling = Math.max(Math.min(sum, effectiveCap), maxSingleStage);
    ceilingSource = 'sum-capped';
  }

  return { riskClass: risk, perStage, ceiling, ceilingSource };
}

/**
 * Compute the re-review plan for a pipeline at the current revision. Each
 * stage's decision is aggregated over ONLY the verdicts pinned to
 * `currentRevisionRef`, so a revision advance (every prior verdict now stale)
 * invalidates all stages and restarts evaluation at the first stage (§4.1).
 * The active stage is the first non-clean stage; `stagesToRun` is that stage
 * plus every downstream stage (the failed stage and all stages it gates), in
 * pipeline order.
 *
 * @param {{ pipeline: ReviewPipeline, stageStates?: readonly StageState[],
 *   currentRevisionRef: string, riskClass?: RiskClass | string,
 *   budgetOverride?: number | null }} params
 */
export function planPipelineReReview({
  pipeline,
  stageStates = [],
  currentRevisionRef,
  riskClass,
  budgetOverride = null,
} = {}) {
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    throw new TypeError('planPipelineReReview requires a non-empty pipeline');
  }
  const stateById = new Map();
  for (const state of Array.isArray(stageStates) ? stageStates : []) {
    if (state && typeof state.stageId === 'string') stateById.set(state.stageId, state);
  }

  const decisions = pipeline.map((stage, index) => {
    const state = stateById.get(stage.id);
    const liveVerdicts = stageVerdictsForRevision(state, currentRevisionRef);
    const aggregated = aggregateStageVerdict(stage, liveVerdicts);
    return {
      ...aggregated,
      stageIndex: index,
      hadPriorVerdicts: (state?.panelVerdicts?.length ?? 0) > 0,
    };
  });

  const activeIndex = decisions.findIndex((decision) => decision.decision !== 'clean');
  const complete = activeIndex === -1;
  const stagesToRun = complete ? [] : decisions.slice(activeIndex).map((decision) => decision.stageId);
  // Downstream stages that carried verdicts before this revision but are being
  // re-run — the observable "invalidated on revision advance" set.
  const invalidatedStageIds = complete
    ? []
    : decisions
      .slice(activeIndex + 1)
      .filter((decision) => decision.hadPriorVerdicts)
      .map((decision) => decision.stageId);

  return {
    riskClass: normalizeRiskClass(riskClass),
    currentRevisionRef: String(currentRevisionRef ?? '') || null,
    decisions,
    complete,
    activeStageIndex: complete ? null : activeIndex,
    activeStageId: complete ? null : decisions[activeIndex].stageId,
    stagesToRun,
    invalidatedStageIds,
    budget: resolveRemediationBudgetPlan(pipeline, riskClass, { override: budgetOverride }),
  };
}

/**
 * The active stage of a subject's recorded pipeline: the furthest-progressed
 * stage that has produced a verdict for the subject's current revision. In the
 * sequential gating model a later stage only runs once the prior stage is
 * clean, so the highest-index stage with current-revision verdicts is the stage
 * currently under evaluation. Stale verdicts from prior revisions are never
 * active review evidence.
 *
 * @param {SubjectState | null | undefined} subjectState
 * @returns {StageState | null}
 */
export function resolveActiveStage(subjectState) {
  const pipeline = Array.isArray(subjectState?.pipeline) ? subjectState.pipeline : [];
  const currentRevisionRef = subjectState?.ref?.revisionRef;
  let active = null;
  for (const stageState of pipeline) {
    if (stageVerdictsForRevision(stageState, currentRevisionRef).length === 0) {
      continue;
    }
    if (active === null || (stageState.stageIndex ?? 0) >= (active.stageIndex ?? 0)) {
      active = stageState;
    }
  }
  return active;
}

/**
 * Resolve the deprecated `latestVerdict` alias (§4.2): the newest verdict of
 * the active stage, restricted to the subject's current revision. Falls back
 * to the legacy `SubjectState.latestVerdict` field when the subject carries no
 * pipeline history. A populated pipeline containing only stale verdicts fails
 * safe to `null` instead of resurrecting the legacy alias.
 *
 * @param {SubjectState | null | undefined} subjectState
 * @returns {Verdict | null}
 */
export function resolveLatestVerdict(subjectState) {
  const active = resolveActiveStage(subjectState);
  if (active) {
    const newest = newestVerdict(stageVerdictsForRevision(active, subjectState?.ref?.revisionRef));
    if (newest) return newest;
  }
  const pipeline = Array.isArray(subjectState?.pipeline) ? subjectState.pipeline : [];
  const hasPipelineHistory = pipeline.some((stageState) => (
    Array.isArray(stageState?.panelVerdicts) && stageState.panelVerdicts.length > 0
  ));
  if (hasPipelineHistory) return null;
  return subjectState?.latestVerdict ?? null;
}
