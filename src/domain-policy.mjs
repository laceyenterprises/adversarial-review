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

function mergeRoleRegistryRoles(fallbackRoleRegistry, rawRegistry) {
  const fallbackRoles = objectOrNull(fallbackRoleRegistry?.roles) || {};
  const merged = {};
  for (const [roleId, roleDef] of Object.entries(fallbackRoles)) {
    merged[roleId] = { ...roleDef };
  }
  for (const [roleId, roleDef] of Object.entries(rawRegistry || {})) {
    const domainRoleDef = objectOrNull(roleDef);
    merged[roleId] = domainRoleDef
      ? {
          ...(objectOrNull(merged[roleId]) || {}),
          ...domainRoleDef,
        }
      : roleDef;
  }
  return merged;
}

export function resolveLegacyReviewerRouteByRoleId(roleId) {
  return LEGACY_REVIEWER_ROUTE_BY_ROLE_ID[str(roleId)] || null;
}

export function resolveReviewerRouteTableFromDomain(domainConfig, {
  fallbackRouteByBuilderClass = {},
} = {}) {
  const routing = objectOrNull(domainConfig?.reviewerRouting);
  if (!routing) return { ...fallbackRouteByBuilderClass };
  const resolved = { ...fallbackRouteByBuilderClass };
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
  const mergedRegistry = mergeRoleRegistryRoles(fallbackRoleRegistry, rawRegistry);
  const workerClassSet = workerClasses instanceof Set
    ? workerClasses
    : Array.isArray(workerClasses)
      ? new Set(workerClasses)
      : publishedWorkerClassSet(workerClassOptions);
  return validateRoleRegistry(mergedRegistry, {
    neverReviewOwnBuilderClass:
      fallbackRoleRegistry?.routing?.neverReviewOwnBuilderClass !== false,
    workerClassSet,
  });
}

export function resolveRemediatorWorkerClassFromDomain(domainConfig) {
  return str(domainConfig?.roleRegistry?.remediator?.workerClass) || null;
}

function fallbackSourceIsOperatorOverride(source) {
  const normalized = str(source);
  return normalized === 'cli'
    || normalized.startsWith('env:')
    || normalized.startsWith('local:');
}

function fallbackHasOperatorOverride(fallbackSources, dottedKey) {
  if (!fallbackSources || typeof fallbackSources !== 'object') return false;
  return fallbackSourceIsOperatorOverride(fallbackSources[dottedKey]);
}

function mergeArrayOverride(base = [], override = undefined, dottedKey = null, options = {}) {
  if (dottedKey && fallbackHasOperatorOverride(options.fallbackSources, dottedKey)) {
    return Array.isArray(base) ? [...base] : [];
  }
  return Array.isArray(override) ? [...override] : [...base];
}

function preferredScalar(fallbackValue, domainValue, dottedKey = null, options = {}) {
  if (dottedKey && fallbackHasOperatorOverride(options.fallbackSources, dottedKey)) {
    return fallbackValue;
  }
  if (domainValue !== undefined && domainValue !== null) return domainValue;
  return fallbackValue;
}

const MERGE_AUTHORITY_KEYS = Object.freeze({
  enabled: 'roles.adversarial.merge_authority.enabled',
  workerClass: 'roles.adversarial.merge_authority.worker_class',
  workerClassFallback: 'roles.adversarial.merge_authority.worker_class_fallback',
  mergeMethod: 'roles.adversarial.merge_authority.merge_method',
  strictNonBlockingRemediation: 'roles.adversarial.merge_authority.strict_non_blocking_remediation',
  autonomousMergeExecutionEnabled: 'roles.adversarial.merge_authority.autonomous_merge_execution_enabled',
  autonomousCloserCommitCleanMergeEnabled: 'roles.adversarial.merge_authority.autonomous_closer_commit_clean_merge_enabled',
  strictMode: 'roles.adversarial.merge_authority.strict_mode',
  lhaConsumeAttestations: 'roles.adversarial.merge_authority.lha.consume_attestations',
  autoHammerOnEligibilityMiss: 'roles.adversarial.merge_authority.auto_hammer_on_eligibility_miss',
  hammerLifetimeDispatchCeiling: 'roles.adversarial.merge_authority.hammer_lifetime_ceiling',
  dispatchTimeoutMs: 'roles.adversarial.merge_authority.dispatch_timeout_ms',
  riskClasses: 'roles.adversarial.merge_authority.eligibility.risk_classes',
  fastMergeLabels: 'roles.adversarial.merge_authority.eligibility.fast_merge_labels',
  highRiskRequiresTwoKey: 'roles.adversarial.merge_authority.eligibility.high_risk_requires_two_key',
  branchProtectionRequired: 'roles.adversarial.merge_authority.branch_protection.required',
});

export function resolveMergeAuthorityConfigFromDomain(domainConfig, fallbackCfg = {}, options = {}) {
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
    enabled: preferredScalar(fallbackCfg.enabled, policy.enabled, MERGE_AUTHORITY_KEYS.enabled, options),
    workerClass: preferredScalar(
      fallbackCfg.workerClass,
      str(policy.workerClass) || undefined,
      MERGE_AUTHORITY_KEYS.workerClass,
      options,
    ),
    workerClassFallback: mergeArrayOverride(
      fallbackCfg.workerClassFallback,
      policy.workerClassFallback,
      MERGE_AUTHORITY_KEYS.workerClassFallback,
      options,
    ),
    mergeMethod: preferredScalar(
      fallbackCfg.mergeMethod,
      str(policy.mergeMethod) || undefined,
      MERGE_AUTHORITY_KEYS.mergeMethod,
      options,
    ),
    strictNonBlockingRemediation:
      preferredScalar(
        fallbackCfg.strictNonBlockingRemediation,
        policy.strictNonBlockingRemediation,
        MERGE_AUTHORITY_KEYS.strictNonBlockingRemediation,
        options,
      ),
    autonomousMergeExecutionEnabled:
      preferredScalar(
        fallbackCfg.autonomousMergeExecutionEnabled,
        policy.autonomousMergeExecutionEnabled,
        MERGE_AUTHORITY_KEYS.autonomousMergeExecutionEnabled,
        options,
      ),
    autonomousCloserCommitCleanMergeEnabled:
      preferredScalar(
        fallbackCfg.autonomousCloserCommitCleanMergeEnabled,
        policy.autonomousCloserCommitCleanMergeEnabled,
        MERGE_AUTHORITY_KEYS.autonomousCloserCommitCleanMergeEnabled,
        options,
      ),
    strictMode: preferredScalar(
      fallbackCfg.strictMode,
      policy.strictMode,
      MERGE_AUTHORITY_KEYS.strictMode,
      options,
    ),
    lha: {
      ...(fallbackCfg?.lha || {}),
      consumeAttestations:
        preferredScalar(
          fallbackCfg?.lha?.consumeAttestations,
          policy?.lha?.consumeAttestations,
          MERGE_AUTHORITY_KEYS.lhaConsumeAttestations,
          options,
        ),
    },
    autoHammerOnEligibilityMiss:
      preferredScalar(
        fallbackCfg.autoHammerOnEligibilityMiss,
        policy.autoHammerOnEligibilityMiss,
        MERGE_AUTHORITY_KEYS.autoHammerOnEligibilityMiss,
        options,
      ),
    hammerLifetimeDispatchCeiling:
      preferredScalar(
        fallbackCfg.hammerLifetimeDispatchCeiling,
        policy.hammerLifetimeDispatchCeiling,
        MERGE_AUTHORITY_KEYS.hammerLifetimeDispatchCeiling,
        options,
      ),
    dispatchTimeoutMs: preferredScalar(
      fallbackCfg.dispatchTimeoutMs,
      policy.dispatchTimeoutMs,
      MERGE_AUTHORITY_KEYS.dispatchTimeoutMs,
      options,
    ),
    eligibility: {
      ...(fallbackCfg?.eligibility || {}),
      riskClasses: mergeArrayOverride(
        fallbackCfg?.eligibility?.riskClasses,
        policy?.eligibility?.riskClasses,
        MERGE_AUTHORITY_KEYS.riskClasses,
        options,
      ),
      fastMergeLabels: mergeArrayOverride(
        fallbackCfg?.eligibility?.fastMergeLabels,
        policy?.eligibility?.fastMergeLabels,
        MERGE_AUTHORITY_KEYS.fastMergeLabels,
        options,
      ),
      highRiskRequiresTwoKey:
        preferredScalar(
          fallbackCfg?.eligibility?.highRiskRequiresTwoKey,
          policy?.eligibility?.highRiskRequiresTwoKey,
          MERGE_AUTHORITY_KEYS.highRiskRequiresTwoKey,
          options,
        ),
    },
    branchProtection: {
      ...(fallbackCfg?.branchProtection || {}),
      required: preferredScalar(
        fallbackCfg?.branchProtection?.required,
        policy?.branchProtection?.required,
        MERGE_AUTHORITY_KEYS.branchProtectionRequired,
        options,
      ),
    },
  };
}
