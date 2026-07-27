import { validateRoleRegistry } from './role-registry.mjs';
import { publishedWorkerClassSet } from './hq-worker-classes.mjs';

const LEGACY_REVIEWER_ROUTE_BY_ROLE_ID = Object.freeze({
  'claude-reviewer-lacey': Object.freeze({
    reviewerModel: 'claude',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
  }),
  'codex-reviewer-lacey': Object.freeze({
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  }),
  'gemini-reviewer-lacey': Object.freeze({
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
  }),
});

function str(value) {
  return String(value ?? '').trim();
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function resolveLegacyReviewerRouteByRoleId(roleId) {
  return LEGACY_REVIEWER_ROUTE_BY_ROLE_ID[str(roleId)] || null;
}

export function resolveReviewerRouteTableFromDomain(domainConfig, {
  fallbackRouteByBuilderClass = {},
} = {}) {
  const routing = objectOrNull(domainConfig?.reviewerRouting);
  if (!routing) return { ...fallbackRouteByBuilderClass };
  const resolved = {};
  for (const [builderClass, roleId] of Object.entries(routing)) {
    const route = resolveLegacyReviewerRouteByRoleId(roleId);
    if (!route) {
      throw new Error(
        `[domain-policy] domain "${str(domainConfig?.id) || 'unknown'}" reviewerRouting.${builderClass} ` +
          `references unknown reviewer role ${JSON.stringify(roleId)}`,
      );
    }
    resolved[builderClass] = { ...route };
  }
  return resolved;
}

export function resolveRoleRegistryFromDomain(domainConfig, {
  fallbackRoleRegistry = null,
  workerClasses = null,
  workerClassOptions = {},
} = {}) {
  const rawRegistry = objectOrNull(domainConfig?.roleRegistry);
  if (!rawRegistry) return fallbackRoleRegistry;
  const workerClassSet = workerClasses instanceof Set
    ? workerClasses
    : Array.isArray(workerClasses)
      ? new Set(workerClasses)
      : publishedWorkerClassSet(workerClassOptions);
  return validateRoleRegistry(rawRegistry, {
    workerClassSet,
  });
}

export function resolveRemediatorWorkerClassFromDomain(domainConfig) {
  return str(domainConfig?.roleRegistry?.remediator?.workerClass) || null;
}

function mergeArrayOverride(base = [], override = undefined) {
  return Array.isArray(override) ? [...override] : [...base];
}

function preferredScalar(fallbackValue, domainValue) {
  if (fallbackValue !== undefined && fallbackValue !== null) return fallbackValue;
  return domainValue;
}

export function resolveMergeAuthorityConfigFromDomain(domainConfig, fallbackCfg = {}) {
  const policy = objectOrNull(domainConfig?.mergeAuthority);
  if (!policy) return {
    ...fallbackCfg,
    eligibility: {
      ...(fallbackCfg?.eligibility || {}),
      riskClasses: [...(fallbackCfg?.eligibility?.riskClasses || [])],
      fastMergeLabels: [...(fallbackCfg?.eligibility?.fastMergeLabels || [])],
    },
    branchProtection: {
      ...(fallbackCfg?.branchProtection || {}),
    },
    workerClassFallback: [...(fallbackCfg?.workerClassFallback || [])],
  };
  return {
    ...fallbackCfg,
    enabled: preferredScalar(fallbackCfg.enabled, policy.enabled),
    workerClass: preferredScalar(fallbackCfg.workerClass, str(policy.workerClass) || undefined),
    workerClassFallback: (fallbackCfg.workerClassFallback || []).length > 0
      ? [...fallbackCfg.workerClassFallback]
      : mergeArrayOverride([], policy.workerClassFallback),
    mergeMethod: preferredScalar(fallbackCfg.mergeMethod, str(policy.mergeMethod) || undefined),
    strictNonBlockingRemediation:
      preferredScalar(fallbackCfg.strictNonBlockingRemediation, policy.strictNonBlockingRemediation),
    autonomousMergeExecutionEnabled:
      preferredScalar(fallbackCfg.autonomousMergeExecutionEnabled, policy.autonomousMergeExecutionEnabled),
    strictMode: preferredScalar(fallbackCfg.strictMode, policy.strictMode),
    lha: {
      ...(fallbackCfg?.lha || {}),
      consumeAttestations:
        preferredScalar(fallbackCfg?.lha?.consumeAttestations, policy?.lha?.consumeAttestations),
    },
    autoHammerOnEligibilityMiss:
      preferredScalar(fallbackCfg.autoHammerOnEligibilityMiss, policy.autoHammerOnEligibilityMiss),
    hammerLifetimeDispatchCeiling:
      preferredScalar(fallbackCfg.hammerLifetimeDispatchCeiling, policy.hammerLifetimeDispatchCeiling),
    dispatchTimeoutMs: preferredScalar(fallbackCfg.dispatchTimeoutMs, policy.dispatchTimeoutMs),
    eligibility: {
      ...(fallbackCfg?.eligibility || {}),
      riskClasses: (fallbackCfg?.eligibility?.riskClasses || []).length > 0
        ? [...fallbackCfg.eligibility.riskClasses]
        : mergeArrayOverride([], policy?.eligibility?.riskClasses),
      fastMergeLabels: (fallbackCfg?.eligibility?.fastMergeLabels || []).length > 0
        ? [...fallbackCfg.eligibility.fastMergeLabels]
        : mergeArrayOverride([], policy?.eligibility?.fastMergeLabels),
      highRiskRequiresTwoKey:
        preferredScalar(fallbackCfg?.eligibility?.highRiskRequiresTwoKey, policy?.eligibility?.highRiskRequiresTwoKey),
    },
    branchProtection: {
      ...(fallbackCfg?.branchProtection || {}),
      required: preferredScalar(fallbackCfg?.branchProtection?.required, policy?.branchProtection?.required),
    },
  };
}
