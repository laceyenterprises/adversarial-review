// Domain → review-pipeline resolver (ARC-13). Turns a domain config's optional
// `pipeline` block into the kernel's `ReviewPipeline` (`Stage[]`, contracts.d.ts
// §4.1), resolving each stage's panel role ids against the ARC-12 role registry
// and deriving per-stage remediation budgets from the domain's risk classes.
//
// The whole surface is behind a config gate that defaults OFF:
//   - `pipeline` absent, or `pipeline.enabled !== true` → `{ enabled: false }`,
//     and the caller runs the unchanged v1 single-stage path. Resolution is a
//     no-op in that case: the role registry is never consulted, so a checkout
//     with an inert (empty) registry keeps booting byte-for-byte as v1.
//   - `pipeline.enabled === true` → the block is validated and compiled into a
//     `ReviewPipeline`, failing loud on any malformed stage, unknown panel role,
//     or a panel role that is not a `taskKind: 'review'` role.
//
// This module is dependency-light (kernel pipeline helpers + the passed-in
// registry only); the reviewer/comms adapters are never imported here so the
// resolver can be unit-tested in isolation and reused by the watcher seam and
// the pipeline driver alike.

import {
  AGGREGATION_POLICY_KINDS,
  DEFAULT_ROUND_BUDGET_BY_RISK,
  RISK_CLASSES,
  normalizeRiskClass,
} from './kernel/pipeline.mjs';

/**
 * @typedef {import('./kernel/contracts.js').Stage} Stage
 * @typedef {import('./kernel/contracts.js').ReviewPipeline} ReviewPipeline
 * @typedef {import('./kernel/contracts.js').RoleRegistry} RoleRegistry
 * @typedef {import('./kernel/contracts.js').RoleDefinition} RoleDefinition
 * @typedef {import('./kernel/contracts.js').RoundBudgetByRisk} RoundBudgetByRisk
 */

const DEFAULT_AGGREGATION = Object.freeze({ kind: 'unanimous-clean' });

class DomainPipelineError extends Error {
  constructor(message, { domainId } = {}) {
    super(message);
    this.name = 'DomainPipelineError';
    if (domainId) this.domainId = domainId;
  }
}

function str(value) {
  return String(value ?? '').trim();
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * Whether a domain config declares an *enabled* review pipeline. Cheap and
 * side-effect-free: it never touches the role registry, so the watcher can call
 * it on the hot path to decide between the pipeline and the v1 single-stage
 * route without paying registry resolution when the gate is off.
 *
 * @param {{ pipeline?: { enabled?: unknown } } | null | undefined} domainConfig
 * @returns {boolean}
 */
export function isPipelineEnabled(domainConfig) {
  return domainConfig?.pipeline?.enabled === true;
}

/**
 * Derive a stage's `roundBudgetByRisk` from the domain's `riskClasses`
 * (`maxRemediationRounds` per class), falling back to the kernel default per
 * class when the domain omits a class. Every stage inherits this unless it
 * declares its own `roundBudgetByRisk` override.
 *
 * @param {{ riskClasses?: Record<string, { maxRemediationRounds?: number }> } | null} domainConfig
 * @returns {RoundBudgetByRisk}
 */
export function domainRoundBudgetByRisk(domainConfig) {
  const riskClasses = domainConfig?.riskClasses;
  const budget = {};
  for (const risk of RISK_CLASSES) {
    const declared = riskClasses?.[risk]?.maxRemediationRounds;
    budget[risk] = isPositiveInt(declared) ? declared : DEFAULT_ROUND_BUDGET_BY_RISK[risk];
  }
  return Object.freeze(budget);
}

function normalizeStageBudget(rawBudget, fallback, { stageId, domainId }) {
  if (rawBudget === undefined || rawBudget === null) return fallback;
  if (typeof rawBudget !== 'object' || Array.isArray(rawBudget)) {
    throw new DomainPipelineError(
      `[domain-pipeline] domain "${domainId}" stage "${stageId}" roundBudgetByRisk must be an object`,
      { domainId },
    );
  }
  const budget = {};
  for (const risk of RISK_CLASSES) {
    const declared = rawBudget[risk];
    budget[risk] = isPositiveInt(declared) ? declared : fallback[risk];
  }
  return Object.freeze(budget);
}

function normalizeAggregation(rawAggregation, { stageId, domainId }) {
  if (rawAggregation === undefined || rawAggregation === null) {
    return { ...DEFAULT_AGGREGATION };
  }
  if (typeof rawAggregation !== 'object' || Array.isArray(rawAggregation)) {
    throw new DomainPipelineError(
      `[domain-pipeline] domain "${domainId}" stage "${stageId}" aggregation must be an object`,
      { domainId },
    );
  }
  const kind = str(rawAggregation.kind);
  if (!AGGREGATION_POLICY_KINDS.includes(kind)) {
    throw new DomainPipelineError(
      `[domain-pipeline] domain "${domainId}" stage "${stageId}" aggregation.kind must be one of: ` +
        `${AGGREGATION_POLICY_KINDS.join(', ')}; got ${JSON.stringify(rawAggregation.kind ?? null)}`,
      { domainId },
    );
  }
  // Carry the policy-specific parameters (quorum / weights / threshold) through
  // verbatim; the kernel's `aggregateStageVerdict` validates them at fold time.
  return { ...rawAggregation, kind };
}

function normalizePanel(rawPanel, roles, { stageId, domainId }) {
  if (!Array.isArray(rawPanel) || rawPanel.length === 0) {
    throw new DomainPipelineError(
      `[domain-pipeline] domain "${domainId}" stage "${stageId}" must declare a non-empty panel`,
      { domainId },
    );
  }
  const seen = new Set();
  const panel = [];
  const panelRoles = [];
  for (const entry of rawPanel) {
    // A panel seat is either a bare role-id string or `{ roleId }` / `{ id }`.
    const roleId = typeof entry === 'string'
      ? str(entry)
      : str(entry?.roleId ?? entry?.id);
    if (!roleId) {
      throw new DomainPipelineError(
        `[domain-pipeline] domain "${domainId}" stage "${stageId}" has a panel seat with no role id`,
        { domainId },
      );
    }
    if (seen.has(roleId)) {
      throw new DomainPipelineError(
        `[domain-pipeline] domain "${domainId}" stage "${stageId}" repeats panel role "${roleId}"`,
        { domainId },
      );
    }
    seen.add(roleId);
    const role = roles?.[roleId];
    if (!role) {
      throw new DomainPipelineError(
        `[domain-pipeline] domain "${domainId}" stage "${stageId}" panel role "${roleId}" is not defined ` +
          'in the role registry (roles.registry)',
        { domainId },
      );
    }
    if (role.taskKind !== 'review') {
      throw new DomainPipelineError(
        `[domain-pipeline] domain "${domainId}" stage "${stageId}" panel role "${roleId}" has ` +
          `taskKind=${JSON.stringify(role.taskKind)}; a pipeline panel seat must be a review role`,
        { domainId },
      );
    }
    // The kernel `ReviewerRole.model` is the harness/worker-class hint the
    // runtime spawns; persona-backed roles carry the persona id instead.
    const model = str(role.workerClass) || str(role.persona) || undefined;
    panel.push(model ? { id: roleId, model } : { id: roleId });
    panelRoles.push({ roleId, role });
  }
  return { panel, panelRoles };
}

/**
 * Compile a domain config's `pipeline` block into a validated
 * `{ enabled, pipeline, stages, rolesById }`. When the gate is off the return
 * is `{ enabled: false, pipeline: null }` and the role registry is never read.
 *
 * @param {object} domainConfig - parsed `domains/<id>.json`
 * @param {{ roleRegistry?: RoleRegistry | null }} [options]
 * @returns {{
 *   enabled: boolean,
 *   domainId: string,
 *   pipeline: ReviewPipeline | null,
 *   stages: Array<{ stage: Stage, panelRoles: Array<{ roleId: string, role: RoleDefinition }> }>,
 *   rolesById: Record<string, RoleDefinition>,
 * }}
 */
export function resolveDomainPipeline(domainConfig, { roleRegistry = null } = {}) {
  const domainId = str(domainConfig?.id) || 'unknown';

  if (!isPipelineEnabled(domainConfig)) {
    return { enabled: false, domainId, pipeline: null, stages: [], rolesById: {} };
  }

  const rawStages = domainConfig.pipeline.stages;
  if (!Array.isArray(rawStages) || rawStages.length === 0) {
    throw new DomainPipelineError(
      `[domain-pipeline] domain "${domainId}" enabled a pipeline but declared no stages`,
      { domainId },
    );
  }

  const roles = roleRegistry?.roles;
  if (!roles || typeof roles !== 'object') {
    throw new DomainPipelineError(
      `[domain-pipeline] domain "${domainId}" enabled a pipeline but no role registry (roles.registry) ` +
        'was provided to resolve its panel roles',
      { domainId },
    );
  }

  const fallbackBudget = domainRoundBudgetByRisk(domainConfig);
  const stages = [];
  const rolesById = {};
  const seenStageIds = new Set();

  for (const rawStage of rawStages) {
    if (!rawStage || typeof rawStage !== 'object' || Array.isArray(rawStage)) {
      throw new DomainPipelineError(
        `[domain-pipeline] domain "${domainId}" has a pipeline stage that is not an object`,
        { domainId },
      );
    }
    const stageId = str(rawStage.id);
    if (!stageId) {
      throw new DomainPipelineError(
        `[domain-pipeline] domain "${domainId}" has a pipeline stage with no id`,
        { domainId },
      );
    }
    if (seenStageIds.has(stageId)) {
      throw new DomainPipelineError(
        `[domain-pipeline] domain "${domainId}" repeats pipeline stage id "${stageId}"`,
        { domainId },
      );
    }
    seenStageIds.add(stageId);

    const { panel, panelRoles } = normalizePanel(rawStage.panel, roles, { stageId, domainId });
    for (const { roleId, role } of panelRoles) rolesById[roleId] = role;

    /** @type {Stage} */
    const stage = {
      id: stageId,
      panel,
      aggregation: normalizeAggregation(rawStage.aggregation, { stageId, domainId }),
      roundBudgetByRisk: normalizeStageBudget(rawStage.roundBudgetByRisk, fallbackBudget, { stageId, domainId }),
    };
    stages.push({ stage, panelRoles });
  }

  return {
    enabled: true,
    domainId,
    pipeline: stages.map((entry) => entry.stage),
    stages,
    rolesById,
  };
}

export { DomainPipelineError, normalizeRiskClass };
