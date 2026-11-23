// ONS-07 — the resolved configuration object returned by every loader.
import { normalizeDisabledRepositories } from './merge-disabled-repositories.mjs';
import { normalizeLaneRoutes } from './config-lane-routes.mjs';
import { ENV_ALIASES } from './config-env-aliases.mjs';
import { MISSING, getLeaf, schemaAliasTarget } from './config-paths.mjs';
import { DEFAULT_PROFILE } from './config-profile.mjs';

export class AgentOSConfig {
  constructor({
    values,
    trace,
    sources,
    schema,
    runtimeDroppedUnknownKeys = [],
    profile = DEFAULT_PROFILE,
    profileSource = 'default',
  }) {
    this.values = values;
    // PROFILENODE-01: resolved profile (see resolveProfile) and why.
    this.profile = profile;
    this.profileSource = profileSource;
    this._trace = trace;
    this.sources = sources;
    this.schema = schema;
    this.runtimeDroppedUnknownKeys = Object.freeze(
      runtimeDroppedUnknownKeys.map((entry) => Object.freeze({ ...entry })),
    );
  }

  get(key, defaultValue = null) {
    const result = getLeaf(this.values, schemaAliasTarget(this.schema, key));
    if (result === MISSING) return defaultValue;
    return result;
  }

  resolutionTrace(key) {
    const entries = this._trace[schemaAliasTarget(this.schema, key)] || [];
    return entries.map((e) => ({ source: e.source, value: e.value, path: e.path }));
  }

  envAliasTable() {
    return ENV_ALIASES;
  }

  /**
   * Resolved `roles.adversarial.merge_authority` subtree with camelCase
   * keys for direct JS consumption.
   *
   * AMA-02 — the eligibility predicate
   * (`tools/adversarial-review/src/ama/eligibility.mjs`) takes this shape
   * as its `cfg` argument. Returning a plain object (not a getter
   * proxy) keeps the predicate easy to test — fixtures can build a
   * matching literal and pass it directly without mocking the loader.
   *
   * The Python loader and the underlying YAML schema keep snake_case;
   * the conversion is only applied at this surface for JS ergonomic
   * reasons. Adding new merge-authority fields requires extending both
   * the schema above AND this getter together.
   */
  getMergeAuthorityConfig() {
    const hammerLifetimeCeiling = this.get(
      'roles.adversarial.merge_authority.hammer_lifetime_ceiling',
      6,
    );
    const legacyHammerLifetimeCeiling = this.get(
      'roles.adversarial.merge_authority.hammer_lifetime_dispatch_ceiling',
      null,
    );
    const requiredCheckContexts = this.get(
      'roles.adversarial.merge_authority.required_check_contexts',
      [],
    );
    const requiredCheckContextsByRepository = this.get(
      'roles.adversarial.merge_authority.required_check_contexts_by_repository',
      [],
    );
    const noCiRepositories = this.get('roles.adversarial.merge_authority.no_ci_repositories', []);
    return {
      disabledRepositories: normalizeDisabledRepositories(this.get('roles.adversarial.merge_authority.disabled_repositories', [])),
      laneRoutes: normalizeLaneRoutes(this.get('roles.adversarial.merge_authority.lane_routes', [])),
      noCiRepositories: Array.isArray(noCiRepositories) ? [...noCiRepositories] : [],
      enabled: this.get('roles.adversarial.merge_authority.enabled', false),
      operatorLogins: [...this.get(
        'roles.adversarial.operator_logins',
        [],
      )],
      operatorLabelActorEnforcement: this.get(
        'roles.adversarial.operator_label_actor_enforcement',
        'observe',
      ),
      workerClass: this.get(
        'roles.adversarial.merge_authority.worker_class',
        'hammer',
      ),
      workerClassFallback: [...this.get(
        'roles.adversarial.merge_authority.worker_class_fallback',
        // Merge-capable default matching the schema default and HHR design
        // intent: hammer-claude is the codex-quota fallback MERGE class (it
        // supports task-kind `merge`). claude-code does NOT support `merge`, so
        // defaulting to it made every codex-exhausted hammer close fail with
        // 'worker class claude-code does not support task kind merge'.
        ['hammer-claude'],
      )],
      mergeMethod: this.get(
        'roles.adversarial.merge_authority.merge_method',
        'squash',
      ),
      strictNonBlockingRemediation: this.get(
        'roles.adversarial.merge_authority.strict_non_blocking_remediation',
        true,
      ),
      autonomousMergeExecutionEnabled: this.get(
        'roles.adversarial.merge_authority.autonomous_merge_execution_enabled',
        true,
      ),
      capReheadEnabled: this.get('roles.adversarial.merge_authority.cap_rehead_enabled', true),
      capReheadLifetimeCap: this.get('roles.adversarial.merge_authority.cap_rehead_lifetime_cap', 2),
      mergeCapabilityEnforcement: this.get(
        'roles.adversarial.merge_authority.merge_capability_enforcement',
        'observe',
      ),
      autonomousCloserCommitCleanMergeEnabled: this.get(
        'roles.adversarial.merge_authority.autonomous_closer_commit_clean_merge_enabled',
        true,
      ),
      strictMode: this.get(
        'roles.adversarial.merge_authority.strict_mode',
        true,
      ),
      lha: {
        consumeAttestations: this.get(
          'roles.adversarial.merge_authority.lha.consume_attestations',
          true,
        ),
      },
      autoHammerOnEligibilityMiss: this.get(
        'roles.adversarial.merge_authority.auto_hammer_on_eligibility_miss',
        false,
      ),
      requiredCheckContexts: Array.isArray(requiredCheckContexts)
        ? [...requiredCheckContexts]
        : [],
      // MRQ-20: repository-scoped contexts; see required-check-contexts.mjs.
      requiredCheckContextsByRepository: Array.isArray(requiredCheckContextsByRepository)
        ? requiredCheckContextsByRepository.map(entry => ({
          repository: entry?.repository,
          contexts: Array.isArray(entry?.contexts) ? [...entry.contexts] : [],
        }))
        : [],
      hammerLifetimeDispatchCeiling: legacyHammerLifetimeCeiling !== null && hammerLifetimeCeiling === 6
        ? legacyHammerLifetimeCeiling
        : hammerLifetimeCeiling,
      dispatchTimeoutMs: this.get(
        'roles.adversarial.merge_authority.dispatch_timeout_ms',
        600000,
      ),
      closerInconclusiveRetry: {
        surfaceAfterAttempts: this.get(
          'roles.adversarial.merge_authority.closer_inconclusive_retry.surface_after_attempts', 3),
        backoffBaseMs: this.get(
          'roles.adversarial.merge_authority.closer_inconclusive_retry.backoff_base_ms', 300000),
        backoffMaxMs: this.get(
          'roles.adversarial.merge_authority.closer_inconclusive_retry.backoff_max_ms', 3600000),
      },
      eligibility: {
        riskClasses: [...this.get(
          'roles.adversarial.merge_authority.eligibility.risk_classes',
          ['low'],
        )],
        fastMergeLabels: [...this.get(
          'roles.adversarial.merge_authority.eligibility.fast_merge_labels',
          ['fast-merge:test-fixtures', 'fast-merge:docs'],
        )],
        highRiskRequiresTwoKey: this.get(
          'roles.adversarial.merge_authority.eligibility.high_risk_requires_two_key',
          true,
        ),
      },
      branchProtection: {
        required: this.get(
          'roles.adversarial.merge_authority.branch_protection.required',
          true,
        ),
      },
    };
  }

  getOrchestrationMode() {
    return this.get('roles.adversarial.orchestration_mode');
  }

  getAdditionalWatchedOrgs() {
    return [...this.get('github.additional_orgs', [])];
  }

  getHandoffConfig() {
    return {
      enabled: this.get('roles.adversarial.handoff.enabled', false),
      reviewToRemediation: this.get('roles.adversarial.handoff.review_to_remediation', false),
      remediationToRereview: this.get('roles.adversarial.handoff.remediation_to_rereview', false),
      finalToHammer: this.get('roles.adversarial.handoff.final_to_hammer', false),
      maxPerPrHead: this.get('roles.adversarial.handoff.max_per_pr_head', 20),
    };
  }
}

// -------- Public loader API ------------------------------------------------
