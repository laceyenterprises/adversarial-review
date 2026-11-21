// agent-os-config — Node loader for the cross-language config surface (CFG).
//
// ONS-07: the schema is generated from the CFG JSON Schema that agent-os
// emits from the Python `schema_v1` (./config-schema.mjs), and this module is
// the cascade around it: code defaults -> module files -> top-level file ->
// profile overlay -> *.local.yaml -> env -> CLI. Validation mirrors
// `agent_os_config.validation` (leaf checks, unknown keys, defaults) and the
// loader's merged-config checks, so both readers accept and reject the same
// documents; test/config-cfg-parity.test.mjs replays Python-recorded verdicts.
//
// Unknown keys fail `loadConfig` in checked-in files, as in Python. Local
// overlays and the runtime/cached loaders (`loadConfigRuntime`,
// `loadConfigCached`, `getConfig`) drop them, so a key from a newer schema
// cannot crash a lagging daemon; `__strict_always` policies never tolerate.
// Remaining deliberate differences: explicit `~` on a non-nullable key fails
// here as in Python; Node-only keys and enum members live, inventoried, in
// ./config-node-keys.mjs; the Python merged-config checks for GCP profiles,
// legacy backup retention and retired Sentinel keys are not ported (this
// reader consumes none of them).

import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import * as yaml from 'js-yaml';
import { normalizeDisabledRepositories } from './merge-disabled-repositories.mjs';
import { normalizeLaneRoutes } from './config-lane-routes.mjs';
import { osgArmFields, schemaV1 } from './config-schema.mjs';
import { TOKEN_POOL_DECLARATION_PATHS, validateTokenPoolDeclarations } from './config-token-pools.mjs';
import { grokEnvAliases, grokRolePinViolations } from './config-grok.mjs';

export const __testYamlHooks = {
  load: (...args) => yaml.load(...args),
};

export const SCHEMA_VERSION = 1;
// Default top-level path resolves relative to the current user's home dir so
// the loader works on any host. Operators can override with topPath= or the
// AGENT_OS_CONFIG_PATH env var.
export const DEFAULT_TOP_LEVEL_PATH = join(homedir(), 'agent-os/config.yaml');

// -------- AgentOSConfigError ------------------------------------------------

export class AgentOSConfigError extends Error {
  constructor(message, { key, expected, got, source, envName, allowed, conflictingEnvNames } = {}) {
    super(message);
    this.name = 'AgentOSConfigError';
    this.key = key ?? null;
    this.expected = expected ?? null;
    this.got = got ?? null;
    this.source = source ?? null;
    this.envName = normalizeEnvName(
      envName ?? (typeof source === 'string' && source.startsWith('env:') ? source.slice('env:'.length) : null),
    );
    this.allowed = allowed ?? null;
    this.conflictingEnvNames = Array.isArray(conflictingEnvNames)
      ? conflictingEnvNames.map(normalizeEnvName).filter(Boolean)
      : [];
  }
}

function normalizeEnvName(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

const DEPRECATED_ENV_VARS = {
  AMA_ENABLED: {
    key: 'roles.adversarial.merge_authority.enabled',
    replacement: 'AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_ENABLED',
  },
};

function checkDeprecatedEnvVars(env) {
  for (const [envName, info] of Object.entries(DEPRECATED_ENV_VARS)) {
    if (!(envName in env)) continue;
    if (isFalseyDeprecatedEnvValue(env[envName])) continue;
    throw new AgentOSConfigError(
      `${info.key}: deprecated env var ${envName} is no longer supported; use ${info.replacement} instead`,
      {
        key: info.key,
        expected: `${info.replacement} or config.local.yaml`,
        got: env[envName],
        source: `env:${envName}`,
        envName,
      },
    );
  }
}

function isFalseyDeprecatedEnvValue(value) {
  const lower = String(value ?? '').trim().toLowerCase();
  return lower === '' || lower === 'false' || lower === '0';
}

// Silent by default. We deliberately do NOT console.warn unknown-key drops:
// agent-os#1738 showed a config-loader warning leaking onto stderr can corrupt
// positional config captures downstream. Opt in with ADVERSARIAL_CONFIG_DEBUG.
function configDebugLog(message) {
  if (process.env.ADVERSARIAL_CONFIG_DEBUG) {
    process.stderr.write(`[adversarial-config] ${message}\n`);
  }
}

const _RUNTIME_UNKNOWN_WARNED_KEYS = new Set();

function runtimeWarningSource(source) {
  if (!source) return '(unknown source)';
  const match = String(source).match(/^(.*):[0-9]+$/);
  if (match) return match[1];
  return String(source);
}

function warnRuntimeUnknownKeyOnce(keyPath, source, hint = '') {
  const warningSource = runtimeWarningSource(source);
  const warnedKey = `${warningSource}\0${keyPath}`;
  if (_RUNTIME_UNKNOWN_WARNED_KEYS.has(warnedKey)) return;
  _RUNTIME_UNKNOWN_WARNED_KEYS.add(warnedKey);
  const suffix = hint ? ` — ${hint.trim()}` : '';
  configDebugLog(
    `ignoring unknown key ${JSON.stringify(keyPath)} ` +
      `in runtime config ${warningSource}${suffix} (not in this reader's schema)`,
  );
}

export function resetRuntimeUnknownWarningCacheForTests() {
  _RUNTIME_UNKNOWN_WARNED_KEYS.clear();
}

// -------- Schema declaration -----------------------------------------------

// -------- Schema (generated) ---------------------------------------------

// ONS-07: schemaV1() is the CFG JSON Schema generated from the Python
// schema_v1 plus the inventoried Node-only keys; see config-schema.mjs.
// Never declare a key here.
const TYPE_STRING = 'string';
const TYPE_BOOL = 'bool';
const TYPE_INT = 'int';
const TYPE_FLOAT = 'float';
const TYPE_LIST = 'list';
const TYPE_DICT = 'dict';

const schemaEnum = (dotted) => Object.freeze([...schemaLeaf(schemaV1(), dotted).__enum]);
export const ENUM_CODEX_WORKER_ACCOUNT_ORDER = schemaEnum('roles.codex_worker_account_order');
export const ENUM_ROLES_ADVERSARIAL_ORCHESTRATION_MODE = schemaEnum('roles.adversarial.orchestration_mode');

const ROLE_FALLBACK_CLASSES = [
  'claude-code',
  'codex',
  'claude-reviewer-lacey',
  'codex-reviewer-lacey',
  'merge-agent',
  'merge-agent-failure-recovery',
  'clio-agent',
];
const MANDATORY_CI_HOSTING_EXCLUDED_WORKFLOWS = ['release-freeze-gate.yml'];

function envClassSegment(roleClass) {
  return roleClass.replaceAll('-', '_').toUpperCase();
}

function buildRoleFallbackEnvAliases() {
  return Object.fromEntries(
    ROLE_FALLBACK_CLASSES.map((roleClass) => {
      const envSegment = envClassSegment(roleClass);
      return [
        `roles.${roleClass}.fallback_path`,
        {
          canonical: `AGENT_OS_ROLES_${envSegment}_FALLBACK_PATH`,
          aliases: [[`LITELLM_VK_FALLBACK_FOR_${envSegment}`, identity]],
        },
      ];
    }),
  );
}

// SPE-01: search cross-field semantics; metadata only, no secret resolution.
const SEARCH_OPERATIONS = Object.freeze({
  brave: ['web_search', 'news_search', 'answer', 'research', 'brave.image_search', 'brave.video_search', 'brave.local_search', 'brave.place_search', 'brave.llm_context'],
  exa: ['web_search', 'fetch', 'extract', 'answer', 'research'],
  firecrawl: ['web_search', 'news_search', 'fetch', 'extract', 'firecrawl.map', 'firecrawl.crawl', 'firecrawl.agent'],
  parallel: ['web_search', 'extract', 'answer', 'research'],
  perplexity: ['web_search', 'answer', 'research', 'perplexity.reason'],
  tavily: ['web_search', 'news_search', 'fetch', 'extract', 'research', 'tavily.map', 'tavily.crawl'],
});
const SEARCH_LIMIT_PATHS = new Set(Object.keys(SEARCH_OPERATIONS).map(p => `services.hcp.search.providers.${p}.operation_limits`));
const SEARCH_MONEY_PATTERN = '^[0-9]{1,12}([.][0-9]{1,9})?$';
const SEARCH_REF_PATTERN = String.raw`^op://[^/\s?#%](?:[^/?#%\r\n]*[^/\s?#%])?/[^/\s?#%](?:[^/?#%\r\n]*[^/\s?#%])?/[^/\s?#%](?:[^/?#%\r\n]*[^/\s?#%])?$`;
const SEARCH_COUNT_LIMITS = ['max_results', 'max_pages', 'max_urls', 'max_input_tokens', 'max_output_tokens', 'max_duration_seconds'];

function validateSearch(search = {}) {
  const fail = (path, reason) => {
    const key = `services.hcp.search${path}`;
    throw new AgentOSConfigError(`${key}: ${reason}`, { key });
  };
  const money = (value, path) => {
    if (typeof value !== 'string' || !(new RegExp(SEARCH_MONEY_PATTERN).test(value)) || value.endsWith('\n')) {
      fail(path, 'expected nonnegative finite decimal USD string');
    }
    // Only positivity is compared: decimal billing arithmetic belongs to HCP.
    return /[1-9]/.test(value);
  };
  const runPositive = !Object.hasOwn(search, 'run_budget_usd') || money(search.run_budget_usd, '.run_budget_usd');
  if (Object.hasOwn(search, 'run_watch_threshold_usd')) money(search.run_watch_threshold_usd, '.run_watch_threshold_usd');
  if (search.enabled && !runPositive) fail('.run_budget_usd', 'enabled gateway requires a positive budget');
  for (const [provider, entry] of Object.entries(search.providers ?? {})) {
    const path = `.providers.${provider}`;
    if (!Object.hasOwn(SEARCH_OPERATIONS, provider)) fail(path, 'unknown provider');
    const positive = !Object.hasOwn(entry, 'budget_usd') || money(entry.budget_usd, `${path}.budget_usd`);
    if (Object.hasOwn(entry, 'watch_threshold_usd')) money(entry.watch_threshold_usd, `${path}.watch_threshold_usd`);
    for (const field of ['credential_ref', 'answers_credential_ref']) {
      if (Object.hasOwn(entry, field) && (!(new RegExp(SEARCH_REF_PATTERN).test(entry[field])) || entry[field].endsWith('\n'))) {
        fail(`${path}.${field}`, 'expected unambiguous op reference metadata');
      }
      if (entry[field]?.split('/')[3]?.trim().replace(/\s+/g, ' ').toLowerCase() === 'exa kb pat') {
        fail(`${path}.${field}`, 'Exa KB PAT is outside the search credential inventory');
      }
    }
    const operations = entry.allowed_operations ?? [];
    if (new Set(operations).size !== operations.length || operations.some(op => !SEARCH_OPERATIONS[provider].includes(op))) {
      fail(`${path}.allowed_operations`, 'expected unique supported operation IDs');
    }
    const limits = entry.operation_limits ?? {};
    for (const [operation, limit] of Object.entries(limits)) {
      const opPath = `${path}.operation_limits.${operation}`;
      if (!SEARCH_OPERATIONS[provider].includes(operation) || !operations.includes(operation)) fail(opPath, 'operation must be supported and explicitly allowed');
      if (Object.hasOwn(limit, 'max_charge_usd') && !money(limit.max_charge_usd, `${opPath}.max_charge_usd`)) fail(opPath, 'maximum charge must be positive');
      if (Object.hasOwn(limit, 'max_charge_usd') && (limit.currency !== 'USD' || typeof limit.pricing_provenance !== 'string' || !limit.pricing_provenance.trim() || /[\r\n]/.test(limit.pricing_provenance))) {
        fail(opPath, 'USD currency and pricing provenance are required');
      }
      if (Object.hasOwn(limit, 'processor') && /[\r\n]/.test(limit.processor)) fail(opPath, 'invalid processor');
      if (!SEARCH_COUNT_LIMITS.some(key => Object.hasOwn(limit, key))) fail(opPath, 'at least one request ceiling is required');
    }
    if (entry.enabled) {
      if (!positive || !runPositive) fail(path, 'configured provider and run budgets must be positive when enabled');
      if (!entry.credential_ref || !operations.length || !Object.keys(limits).length) fail(path, 'enabled provider requires credential metadata and a bounded operation');
      if (provider === 'brave' && operations.some(op => ['answer', 'research'].includes(op)) && !entry.answers_credential_ref) {
        fail(path, 'Brave answer/research requires separate Answers credential metadata');
      }
    }
  }
}


// -------- Env alias table --------------------------------------------------

function postgresRuntimeAlias(value) {
  return value.trim().toLowerCase() === 'on' ? 'postgres' : 'sqlite';
}

const identity = (v) => v;

export const ENV_ALIASES = {
  // GRK-09: canonical AGENT_OS_GROK_* names, mirrored from the Python table.
  ...grokEnvAliases(),
  'worker_pool.post_merge_actions.rca_worker_class': {
    canonical: 'AGENT_OS_WORKER_POOL_POST_MERGE_ACTIONS_RCA_WORKER_CLASS',
    aliases: [],
  },
  'apple.developer_dir': {
    canonical: 'AGENT_OS_APPLE_DEVELOPER_DIR',
    aliases: [],
  },
  ...Object.fromEntries([
    'enabled',
    'state_dir',
    'binary_path',
    'custodian_host',
    'custodian_user',
    'known_hosts_file',
    'ssh_identity_file',
    'custodian_principal',
    'custodian_port',
  ].map((key) => [`network.identity.${key}`, {
    canonical: `AGENT_OS_NETWORK_IDENTITY_${key.toUpperCase()}`, aliases: [],
  }])),
  'update.channel': {
    canonical: 'AGENT_OS_UPDATE_CHANNEL',
    aliases: [],
  },
  'ci.hosting.mode': {
    canonical: 'AGENT_OS_CI_HOSTING_MODE',
    aliases: [],
  },
  'frc.offlan_transport.enabled': {
    canonical: 'AGENT_OS_FRC_OFFLAN_TRANSPORT_ENABLED',
    aliases: [],
  },
  'frc.offlan_transport.port': {
    canonical: 'AGENT_OS_FRC_OFFLAN_TRANSPORT_PORT',
    aliases: [],
  },
  'frc.offlan_transport.kill_switch_path': {
    canonical: 'AGENT_OS_FRC_OFFLAN_TRANSPORT_KILL_SWITCH_PATH',
    aliases: [],
  },
  'roots.runtime_user': {
    canonical: 'AGENT_OS_ROOTS_RUNTIME_USER',
    aliases: [],
  },
  'roots.runtime_uid': {
    canonical: 'AGENT_OS_ROOTS_RUNTIME_UID',
    aliases: [],
  },
  'roots.admin_user': {
    canonical: 'AGENT_OS_ROOTS_ADMIN_USER',
    aliases: [],
  },
  'roots.admin_uid': {
    canonical: 'AGENT_OS_ROOTS_ADMIN_UID',
    aliases: [],
  },
  'roles.reviewer': {
    canonical: 'AGENT_OS_ROLES_REVIEWER',
    aliases: [['ADVERSARIAL_REVIEW_DEFAULT_REVIEWER', identity]],
  },
  // CFG promotion of pre-CFG adversarial-review knobs. Pre-CFG operators
  // pinned these names directly in plists; preserve them as aliases so the
  // migration is invisible to anyone who had already set a value.
  'remediation.max_concurrent_jobs': {
    canonical: 'AGENT_OS_REMEDIATION_MAX_CONCURRENT_JOBS',
    aliases: [['ADVERSARIAL_REMEDIATION_MAX_CONCURRENT_JOBS', identity]],
  },
  'remediation.max_concurrent_jobs_ceiling': {
    canonical: 'AGENT_OS_REMEDIATION_MAX_CONCURRENT_JOBS_CEILING',
    aliases: [['ADVERSARIAL_REMEDIATION_MAX_CONCURRENT_JOBS_CEILING', identity]],
  },
  'reviewer.timeout_ms': {
    canonical: 'AGENT_OS_REVIEWER_TIMEOUT_MS',
    aliases: [['ADVERSARIAL_REVIEWER_TIMEOUT_MS', identity]],
  },
  'reviewer.first_output_timeout_ms': {
    canonical: 'AGENT_OS_REVIEWER_FIRST_OUTPUT_TIMEOUT_MS',
    aliases: [['ADVERSARIAL_REVIEWER_FIRST_OUTPUT_TIMEOUT_MS', identity]],
  },
  'reviewer.quota_check_enabled': {
    canonical: 'AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED',
    aliases: [['ADVERSARIAL_REVIEW_QUOTA_CHECK_ENABLED', identity]],
  },
  'reviewer.quota_status_dir': {
    canonical: 'AGENT_OS_REVIEWER_QUOTA_STATUS_DIR',
    aliases: [['ADVERSARIAL_REVIEW_QUOTA_STATUS_DIR', identity]],
  },
  'reviewer.no_progress_timeout_ms': {
    canonical: 'AGENT_OS_REVIEWER_NO_PROGRESS_TIMEOUT_MS',
    aliases: [['ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS', identity]],
  },
  'reviewer.running_pass_timeout_seconds': {
    canonical: 'AGENT_OS_REVIEWER_RUNNING_PASS_TIMEOUT_SECONDS',
    aliases: [['ADVERSARIAL_REVIEW_RUNNING_PASS_TIMEOUT_SECONDS', identity]],
  },
  'reviewer.idle_timeout_seconds': {
    canonical: 'AGENT_OS_REVIEWER_IDLE_TIMEOUT_SECONDS',
    aliases: [['ADVERSARIAL_REVIEWER_IDLE_TIMEOUT_SECONDS', identity]],
  },
  'reviewer.ceiling_base_seconds': {
    canonical: 'AGENT_OS_REVIEWER_CEILING_BASE_SECONDS',
    aliases: [['ADVERSARIAL_REVIEWER_CEILING_BASE_SECONDS', identity]],
  },
  'reviewer.ceiling_max_seconds': {
    canonical: 'AGENT_OS_REVIEWER_CEILING_MAX_SECONDS',
    aliases: [['ADVERSARIAL_REVIEWER_CEILING_MAX_SECONDS', identity]],
  },
  'reviewer.memory.pressure.projected_headroom_floor_mb': {
    canonical: 'AGENT_OS_REVIEWER_MEMORY_PRESSURE_PROJECTED_HEADROOM_FLOOR_MB',
    aliases: [['ADVERSARIAL_REVIEWER_MEMORY_PRESSURE_PROJECTED_HEADROOM_FLOOR_MB', identity]],
  },
  'reviewer.memory.pressure.elevated_available_mb': {
    canonical: 'AGENT_OS_REVIEWER_MEMORY_PRESSURE_ELEVATED_AVAILABLE_MB',
    aliases: [['ADVERSARIAL_REVIEWER_MEMORY_PRESSURE_ELEVATED_AVAILABLE_MB', identity]],
  },
  'reviewer.memory.pressure.critical_available_mb': {
    canonical: 'AGENT_OS_REVIEWER_MEMORY_PRESSURE_CRITICAL_AVAILABLE_MB',
    aliases: [['ADVERSARIAL_REVIEWER_MEMORY_PRESSURE_CRITICAL_AVAILABLE_MB', identity]],
  },
  'reviewer.memory.pressure.elevated_swap_used_pct': {
    canonical: 'AGENT_OS_REVIEWER_MEMORY_PRESSURE_ELEVATED_SWAP_USED_PCT',
    aliases: [['ADVERSARIAL_REVIEWER_MEMORY_PRESSURE_ELEVATED_SWAP_USED_PCT', identity]],
  },
  'reviewer.memory.pressure.critical_swap_used_pct': {
    canonical: 'AGENT_OS_REVIEWER_MEMORY_PRESSURE_CRITICAL_SWAP_USED_PCT',
    aliases: [['ADVERSARIAL_REVIEWER_MEMORY_PRESSURE_CRITICAL_SWAP_USED_PCT', identity]],
  },
  'reviewer.memory.pressure.swap_pressure_available_mb': {
    canonical: 'AGENT_OS_REVIEWER_MEMORY_PRESSURE_SWAP_PRESSURE_AVAILABLE_MB',
    aliases: [['ADVERSARIAL_REVIEWER_MEMORY_PRESSURE_SWAP_PRESSURE_AVAILABLE_MB', identity]],
  },
  'reviewer.review_population_retry.max_attempts': {
    canonical: 'AGENT_OS_REVIEWER_REVIEW_POPULATION_RETRY_MAX_ATTEMPTS',
    aliases: [['ADVERSARIAL_REVIEW_POPULATION_RETRY_MAX_ATTEMPTS', identity]],
  },
  'reviewer.review_population_retry.backoff_seconds': {
    canonical: 'AGENT_OS_REVIEWER_REVIEW_POPULATION_RETRY_BACKOFF_SECONDS',
    aliases: [['ADVERSARIAL_REVIEW_POPULATION_RETRY_BACKOFF_SECONDS', identity]],
  },
  'worker_pool.tenure.enabled': {
    canonical: 'AGENT_OS_WORKER_POOL_TENURE_ENABLED',
    aliases: [],
  },
  'worker_pool.worker_process_niceness': {
    canonical: 'AGENT_OS_WORKER_POOL_WORKER_PROCESS_NICENESS',
    aliases: [],
  },
  'worker_pool.memory.dynamic.enabled': {
    canonical: 'AGENT_OS_WORKER_POOL_MEMORY_DYNAMIC_ENABLED',
    aliases: [['HQ_MEMORY_DYNAMIC_ENABLED', identity]],
  },
  'worker_pool.memory.dynamic.shadow_only': {
    canonical: 'AGENT_OS_WORKER_POOL_MEMORY_DYNAMIC_SHADOW_ONLY',
    aliases: [['HQ_MEMORY_DYNAMIC_SHADOW_ONLY', identity]],
  },
  'worker_pool.memory.dynamic.admit_percentile': {
    canonical: 'AGENT_OS_WORKER_POOL_MEMORY_DYNAMIC_ADMIT_PERCENTILE',
    aliases: [['HQ_MEMORY_DYNAMIC_ADMIT_PERCENTILE', identity]],
  },
  'worker_pool.memory.dynamic.pressure_margin_mb': {
    canonical: 'AGENT_OS_WORKER_POOL_MEMORY_DYNAMIC_PRESSURE_MARGIN_MB',
    aliases: [['HQ_MEMORY_DYNAMIC_PRESSURE_MARGIN_MB', identity]],
  },
  'worker_pool.memory.dynamic.rss_window_minutes': {
    canonical: 'AGENT_OS_WORKER_POOL_MEMORY_DYNAMIC_RSS_WINDOW_MINUTES',
    aliases: [['HQ_MEMORY_DYNAMIC_RSS_WINDOW_MINUTES', identity]],
  },
  'worker_pool.memory.dynamic.oss_model_reserve_mb': {
    canonical: 'AGENT_OS_WORKER_POOL_MEMORY_DYNAMIC_OSS_MODEL_RESERVE_MB',
    aliases: [['HQ_MEMORY_DYNAMIC_OSS_MODEL_RESERVE_MB', identity]],
  },
  'worker_pool.memory.dynamic.snapshot_stale_seconds': {
    canonical: 'AGENT_OS_WORKER_POOL_MEMORY_DYNAMIC_SNAPSHOT_STALE_SECONDS',
    aliases: [['HQ_MEMORY_DYNAMIC_SNAPSHOT_STALE_SECONDS', identity]],
  },
  'worker_pool.memory.dynamic.require_pressure_normal': {
    canonical: 'AGENT_OS_WORKER_POOL_MEMORY_DYNAMIC_REQUIRE_PRESSURE_NORMAL',
    aliases: [['HQ_MEMORY_DYNAMIC_REQUIRE_PRESSURE_NORMAL', identity]],
  },
  'worker_pool.dag.autowalk.deep_reconcile': {
    canonical: 'AGENT_OS_WORKER_POOL_DAG_AUTOWALK_DEEP_RECONCILE',
    aliases: [['HQ_AUTOWALK_DEEP_RECONCILE', identity]],
  },
  'worker_pool.memory_injection.enabled': {
    canonical: 'AGENT_OS_WORKER_POOL_MEMORY_INJECTION_ENABLED',
    aliases: [],
  },
  'worker_pool.memory_injection.max_entries': {
    canonical: 'AGENT_OS_WORKER_POOL_MEMORY_INJECTION_MAX_ENTRIES',
    aliases: [],
  },
  'worker_pool.memory_injection.max_chars': {
    canonical: 'AGENT_OS_WORKER_POOL_MEMORY_INJECTION_MAX_CHARS',
    aliases: [],
  },
  'worker_pool.memory_injection.max_per_contract': {
    canonical: 'AGENT_OS_WORKER_POOL_MEMORY_INJECTION_MAX_PER_CONTRACT',
    aliases: [],
  },
  'worker_pool.memory_injection.min_term_matches': {
    canonical: 'AGENT_OS_WORKER_POOL_MEMORY_INJECTION_MIN_TERM_MATCHES',
    aliases: [],
  },
  'worker_pool.memory_retention.enabled': {
    canonical: 'AGENT_OS_WORKER_POOL_MEMORY_RETENTION_ENABLED',
    aliases: [['HQ_MEMORY_RETENTION_ENABLED', identity]],
  },
  'worker_pool.memory_retention.shadow_only': {
    canonical: 'AGENT_OS_WORKER_POOL_MEMORY_RETENTION_SHADOW_ONLY',
    aliases: [['HQ_MEMORY_RETENTION_SHADOW_ONLY', identity]],
  },
  'worker_pool.dispatch.claude_batch_steer_enabled': {
    canonical: 'AGENT_OS_WORKER_POOL_DISPATCH_CLAUDE_BATCH_STEER_ENABLED',
    aliases: [['HQ_CLAUDE_BATCH_STEER', identity]],
  },
  'worker_pool.dispatch.codex_exec_mode': {
    canonical: 'AGENT_OS_WORKER_POOL_DISPATCH_CODEX_EXEC_MODE',
    aliases: [['HQ_CODEX_EXEC_MODE', identity]],
  },
  'worker_pool.dispatch.fleet_launch_health.enabled': {
    canonical: 'AGENT_OS_WORKER_POOL_DISPATCH_FLEET_LAUNCH_HEALTH_ENABLED',
    aliases: [['HQ_FLEET_LAUNCH_HEALTH_ENABLED', identity]],
  },
  'worker_pool.dispatch.fleet_launch_health.window_seconds': {
    canonical: 'AGENT_OS_WORKER_POOL_DISPATCH_FLEET_LAUNCH_HEALTH_WINDOW_SECONDS',
    aliases: [['HQ_FLEET_LAUNCH_HEALTH_WINDOW_SECONDS', identity]],
  },
  'worker_pool.dispatch.fleet_launch_health.min_samples': {
    canonical: 'AGENT_OS_WORKER_POOL_DISPATCH_FLEET_LAUNCH_HEALTH_MIN_SAMPLES',
    aliases: [['HQ_FLEET_LAUNCH_HEALTH_MIN_SAMPLES', identity]],
  },
  'worker_pool.dispatch.fleet_launch_health.unhealthy_fraction': {
    canonical: 'AGENT_OS_WORKER_POOL_DISPATCH_FLEET_LAUNCH_HEALTH_UNHEALTHY_FRACTION',
    aliases: [['HQ_FLEET_LAUNCH_HEALTH_UNHEALTHY_FRACTION', identity]],
  },
  'worker_pool.dispatch.fleet_launch_health.backoff_seconds': {
    canonical: 'AGENT_OS_WORKER_POOL_DISPATCH_FLEET_LAUNCH_HEALTH_BACKOFF_SECONDS',
    aliases: [['HQ_FLEET_LAUNCH_HEALTH_BACKOFF_SECONDS', identity]],
  },
  'worker_pool.dispatch.fleet_launch_health.canary_interval_seconds': {
    canonical: 'AGENT_OS_WORKER_POOL_DISPATCH_FLEET_LAUNCH_HEALTH_CANARY_INTERVAL_SECONDS',
    aliases: [['HQ_FLEET_LAUNCH_HEALTH_CANARY_INTERVAL_SECONDS', identity]],
  },
  'worker_pool.dispatch.goal_lineage.enabled': {
    canonical: 'AGENT_OS_WORKER_POOL_DISPATCH_GOAL_LINEAGE_ENABLED',
    aliases: [['HQ_GLN_LINEAGE_ENABLED', identity]],
  },
  'worker_pool.dispatch.goal_lineage.max_bytes': {
    canonical: 'AGENT_OS_WORKER_POOL_DISPATCH_GOAL_LINEAGE_MAX_BYTES',
    aliases: [['HQ_GLN_LINEAGE_MAX_BYTES', identity]],
  },
  'worker_pool.dispatch.goal_lineage.spec_excerpt_bytes': {
    canonical: 'AGENT_OS_WORKER_POOL_DISPATCH_GOAL_LINEAGE_SPEC_EXCERPT_BYTES',
    aliases: [['HQ_GLN_LINEAGE_SPEC_EXCERPT_BYTES', identity]],
  },
  'worker_pool.dispatch.substrate.swap_crit_requires_pressure': {
    canonical: 'AGENT_OS_WORKER_POOL_DISPATCH_SUBSTRATE_SWAP_CRIT_REQUIRES_PRESSURE',
    aliases: [['SUBSTRATE_SWAP_CRIT_REQUIRES_PRESSURE', identity]],
  },
  'worker_pool.dispatch.substrate.mem_pressure_crit_level': {
    canonical: 'AGENT_OS_WORKER_POOL_DISPATCH_SUBSTRATE_MEM_PRESSURE_CRIT_LEVEL',
    aliases: [['SUBSTRATE_MEM_PRESSURE_CRIT_LEVEL', identity]],
  },
  'worker_pool.shr.main_catchup_behind_threshold': {
    canonical: 'AGENT_OS_WORKER_POOL_SHR_MAIN_CATCHUP_BEHIND_THRESHOLD',
    aliases: [],
  },
  'worker_pool.shr.worker_kill_window_seconds': {
    canonical: 'AGENT_OS_WORKER_POOL_SHR_WORKER_KILL_WINDOW_SECONDS',
    aliases: [],
  },
  'worker_pool.shr.worker_kill_threshold': {
    canonical: 'AGENT_OS_WORKER_POOL_SHR_WORKER_KILL_THRESHOLD',
    aliases: [],
  },
  'worker_pool.shr.command_timeout_seconds': {
    canonical: 'AGENT_OS_WORKER_POOL_SHR_COMMAND_TIMEOUT_SECONDS',
    aliases: [],
  },
  'worker_pool.secrets.prewarm.enabled': {
    canonical: 'AGENT_OS_WORKER_POOL_SECRETS_PREWARM_ENABLED',
    aliases: [],
  },
  'worker_pool.secrets.prewarm.min_interval_seconds': {
    canonical: 'AGENT_OS_WORKER_POOL_SECRETS_PREWARM_MIN_INTERVAL_SECONDS',
    aliases: [],
  },
  'worker_pool.secrets.known_vaults': {
    canonical: 'AGENT_OS_WORKER_POOL_SECRETS_KNOWN_VAULTS',
    aliases: [],
  },
  'worker_pool.secrets.release_signing_private_key_ref': {
    canonical: 'AGENT_OS_WORKER_POOL_SECRETS_RELEASE_SIGNING_PRIVATE_KEY_REF',
    aliases: [],
  },
  'post_deploy_verify.enabled': {
    canonical: 'AGENT_OS_POST_DEPLOY_VERIFY_ENABLED',
    aliases: [['HQ_POST_DEPLOY_VERIFY_ENABLED', identity]],
  },
  'post_deploy_verify.shadow_only': {
    canonical: 'AGENT_OS_POST_DEPLOY_VERIFY_SHADOW_ONLY',
    aliases: [['HQ_POST_DEPLOY_VERIFY_SHADOW_ONLY', identity]],
  },
  'post_deploy_verify.spawn_timeout_seconds': {
    canonical: 'AGENT_OS_POST_DEPLOY_VERIFY_SPAWN_TIMEOUT_SECONDS',
    aliases: [['HQ_POST_DEPLOY_VERIFY_SPAWN_TIMEOUT_SECONDS', identity]],
  },
  'post_deploy_verify.spawn_ready_wait_seconds': {
    canonical: 'AGENT_OS_POST_DEPLOY_VERIFY_SPAWN_READY_WAIT_SECONDS',
    aliases: [['HQ_POST_DEPLOY_VERIFY_SPAWN_READY_WAIT_SECONDS', identity]],
  },
  'post_deploy_verify.boot_window_seconds': {
    canonical: 'AGENT_OS_POST_DEPLOY_VERIFY_BOOT_WINDOW_SECONDS',
    aliases: [['HQ_POST_DEPLOY_VERIFY_BOOT_WINDOW_SECONDS', identity]],
  },
  'post_deploy_verify.reminder_seconds': {
    canonical: 'AGENT_OS_POST_DEPLOY_VERIFY_REMINDER_SECONDS',
    aliases: [['HQ_POST_DEPLOY_VERIFY_REMINDER_SECONDS', identity]],
  },
  'deploy.post_merge_activation.enabled': {
    canonical: 'AGENT_OS_POST_MERGE_ACTIVATION_ENABLED',
    aliases: [['HQ_POST_MERGE_ACTIVATION_ENABLED', identity]],
  },
  'deploy.post_merge_activation.enforce': {
    canonical: 'AGENT_OS_POST_MERGE_ACTIVATION_ENFORCE',
    aliases: [['HQ_POST_MERGE_ACTIVATION_ENFORCE', identity]],
  },
  'deploy.post_merge_activation.dispatch_on_fail': {
    canonical: 'AGENT_OS_POST_MERGE_ACTIVATION_DISPATCH_ON_FAIL',
    aliases: [['HQ_POST_MERGE_ACTIVATION_DISPATCH_ON_FAIL', identity]],
  },
  'deploy.post_merge_activation.baseline_worker_boot_resolve_budget_seconds': {
    canonical: 'AGENT_OS_POST_MERGE_ACTIVATION_BASELINE_WORKER_BOOT_RESOLVE_BUDGET_SECONDS',
    aliases: [['HQ_POST_MERGE_ACTIVATION_BASELINE_WORKER_BOOT_RESOLVE_BUDGET_SECONDS', identity]],
  },
  'deploy.post_merge_activation.hold_alert_budget_seconds': {
    canonical: 'AGENT_OS_POST_MERGE_ACTIVATION_HOLD_ALERT_BUDGET_SECONDS',
    aliases: [['HQ_POST_MERGE_ACTIVATION_HOLD_ALERT_BUDGET_SECONDS', identity]],
  },
  'deploy.post_merge_activation.hold_alert_consecutive_passes': {
    canonical: 'AGENT_OS_POST_MERGE_ACTIVATION_HOLD_ALERT_CONSECUTIVE_PASSES',
    aliases: [['HQ_POST_MERGE_ACTIVATION_HOLD_ALERT_CONSECUTIVE_PASSES', identity]],
  },
  'reviewer.gemini.mode': {
    canonical: 'AGENT_OS_REVIEWER_GEMINI_MODE',
    aliases: [['ADVERSARIAL_REVIEW_GEMINI_REVIEWER_MODE', identity]],
  },
  'reviewer.gemini.runtime': {
    canonical: 'AGENT_OS_REVIEWER_GEMINI_RUNTIME',
    aliases: [['ADVERSARIAL_REVIEW_GEMINI_RUNTIME', identity]],
  },
  'reviewer.gemini.model': {
    canonical: 'AGENT_OS_REVIEWER_GEMINI_MODEL',
    aliases: [['ADVERSARIAL_REVIEW_GEMINI_MODEL', identity]],
  },
  'reviewer.gemini.antigravity.print_timeout_ms': {
    canonical: 'AGENT_OS_REVIEWER_GEMINI_ANTIGRAVITY_PRINT_TIMEOUT_MS',
    aliases: [['ADVERSARIAL_REVIEW_GEMINI_ANTIGRAVITY_PRINT_TIMEOUT_MS', identity]],
  },
  'watcher.max_drain_wait_ms': {
    canonical: 'AGENT_OS_WATCHER_MAX_DRAIN_WAIT_MS',
    aliases: [['ADVERSARIAL_WATCHER_DRAIN_MAX_MS', identity]],
  },
  'watcher.pending_draft_review_respawn_age_seconds': {
    canonical: 'AGENT_OS_WATCHER_PENDING_DRAFT_REVIEW_RESPAWN_AGE_SECONDS',
    aliases: [['ADVERSARIAL_REVIEW_PENDING_DRAFT_RESPAWN_AGE_SECONDS', identity]],
  },
  'watcher.stuck_dispatch_alert_debounce_ms': {
    canonical: 'AGENT_OS_WATCHER_STUCK_DISPATCH_ALERT_DEBOUNCE_MS',
    aliases: [['ADVERSARIAL_STUCK_DISPATCH_ALERT_DEBOUNCE_MS', identity]],
  },
  'watcher.first_pass_reviewer_pool_max_concurrent_reviewers': {
    canonical: 'AGENT_OS_WATCHER_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT_REVIEWERS',
    aliases: [
      ['ADVERSARIAL_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT', identity],
      ['ADVERSARIAL_FIRST_PASS_REVIEWER_MAX_CONCURRENT', identity],
      ['ADVERSARIAL_REVIEWER_POOL_MAX_CONCURRENT', identity],
    ],
  },
  'watcher.first_pass_review_queue_depth_failover_threshold': {
    canonical: 'AGENT_OS_WATCHER_FIRST_PASS_REVIEW_QUEUE_DEPTH_FAILOVER_THRESHOLD',
    aliases: [['ADVERSARIAL_REVIEW_FIRST_PASS_QUEUE_DEPTH_FAILOVER_THRESHOLD', identity]],
  },
  'watcher.rereview_queue_depth_failover_threshold': {
    canonical: 'AGENT_OS_WATCHER_REREVIEW_QUEUE_DEPTH_FAILOVER_THRESHOLD',
    aliases: [['ADVERSARIAL_REVIEW_REREVIEW_QUEUE_DEPTH_FAILOVER_THRESHOLD', identity]],
  },
  'watcher.ama_hammer_dispatch_mode': {
    canonical: 'AGENT_OS_WATCHER_AMA_HAMMER_DISPATCH_MODE',
    aliases: [['ADVERSARIAL_AMA_HAMMER_DISPATCH_MODE', identity]],
  },
  'watcher.review_lane_first_pass_burst_limit': {
    canonical: 'AGENT_OS_WATCHER_REVIEW_LANE_FIRST_PASS_BURST_LIMIT',
    aliases: [['ADVERSARIAL_REVIEW_LANE_FIRST_PASS_BURST_LIMIT', identity]],
  },
  'watcher.review_lane_min_share': {
    canonical: 'AGENT_OS_WATCHER_REVIEW_LANE_MIN_SHARE',
    aliases: [['ADVERSARIAL_REVIEW_LANE_MIN_SHARE', identity]],
  },
  'watcher.review_lane_first_pass_urgent_age_ms': {
    canonical: 'AGENT_OS_WATCHER_REVIEW_LANE_FIRST_PASS_URGENT_AGE_MS',
    aliases: [['ADVERSARIAL_REVIEW_LANE_FIRST_PASS_URGENT_AGE_MS', identity]],
  },
  'follow_up.hq_worker_tear_down_subprocess_timeout_ms': {
    canonical: 'AGENT_OS_FOLLOW_UP_HQ_WORKER_TEAR_DOWN_SUBPROCESS_TIMEOUT_MS',
    aliases: [['HQ_WORKER_TEAR_DOWN_TIMEOUT_MS', identity]],
  },
  'follow_up.hq_dispatch_subprocess_timeout_ms': {
    canonical: 'AGENT_OS_FOLLOW_UP_HQ_DISPATCH_SUBPROCESS_TIMEOUT_MS',
    aliases: [['HQ_DISPATCH_TIMEOUT_MS', identity]],
  },
  'roles.remediator': {
    canonical: 'AGENT_OS_ROLES_REMEDIATOR',
    // YAML and both env names share the schema's corporate alias normalization.
    aliases: [['ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR', identity]],
  },
  // The legacy env toggle from AR#859 stays honored as an alias, comma-separated.
  'roles.remediator_fallback': {
    canonical: 'AGENT_OS_ROLES_REMEDIATOR_FALLBACK',
    aliases: [['ADVERSARIAL_REVIEW_REMEDIATOR_WORKER_CLASS_FALLBACK', identity]],
  },
  'roles.merge_agent_worker_class': {
    canonical: 'AGENT_OS_ROLES_MERGE_AGENT_WORKER_CLASS',
    aliases: [['ADVERSARIAL_REVIEW_MERGE_AGENT_WORKER_CLASS', identity]],
  },
  'roles.codex_worker_account_order': {
    canonical: 'AGENT_OS_ROLES_CODEX_WORKER_ACCOUNT_ORDER',
    aliases: [],
  },
  'roles.build_pack_default_worker_class': {
    canonical: 'AGENT_OS_ROLES_BUILD_PACK_DEFAULT_WORKER_CLASS',
    aliases: [],
  },
  'roles.hermes.provider': {
    canonical: 'AGENT_OS_ROLES_HERMES_PROVIDER',
    aliases: [],
  },
  'roles.adversarial.merge_authority.enabled': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_ENABLED',
    aliases: [],
  },
  'roles.adversarial.merge_authority.autonomous_merge_execution_enabled': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_AUTONOMOUS_MERGE_EXECUTION_ENABLED',
    aliases: [],
  },
  'roles.adversarial.merge_authority.cap_rehead_enabled': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_CAP_REHEAD_ENABLED', aliases: [],
  },
  'roles.adversarial.merge_authority.cap_rehead_lifetime_cap': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_CAP_REHEAD_LIFETIME_CAP', aliases: [],
  },
  'roles.adversarial.merge_authority.merge_capability_enforcement': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_MERGE_CAPABILITY_ENFORCEMENT',
    aliases: [['MERGE_CAPABILITY_ENFORCEMENT', identity]],
  },
  'roles.adversarial.merge_authority.autonomous_closer_commit_clean_merge_enabled': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_AUTONOMOUS_CLOSER_COMMIT_CLEAN_MERGE_ENABLED',
    aliases: [],
  },
  'roles.adversarial.merge_authority.strict_mode': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_STRICT_MODE',
    aliases: [],
  },
  'roles.adversarial.merge_authority.lha.consume_attestations': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_LHA_CONSUME_ATTESTATIONS',
    aliases: [],
  },
  'roles.adversarial.merge_authority.hammer_lifetime_ceiling': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_HAMMER_LIFETIME_CEILING',
    aliases: [['AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_HAMMER_LIFETIME_DISPATCH_CEILING', identity]],
  },
  'roles.adversarial.merge_authority.hammer_lifetime_dispatch_ceiling': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_HAMMER_LIFETIME_DISPATCH_CEILING',
    aliases: [],
  },
  'roles.adversarial.merge_authority.no_ci_repositories': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_NO_CI_REPOSITORIES',
    aliases: [],
  },
  'roles.adversarial.merge_authority.required_check_contexts': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_REQUIRED_CHECK_CONTEXTS',
    aliases: [],
  },
  'roles.adversarial.orchestration_mode': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE',
    aliases: [],
  },
  'roles.adversarial.operator_logins': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_OPERATOR_LOGINS',
    aliases: [],
  },
  'roles.adversarial.operator_label_actor_enforcement': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_OPERATOR_LABEL_ACTOR_ENFORCEMENT',
    aliases: [],
  },
  'roles.adversarial.handoff.enabled': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_HANDOFF_ENABLED',
    aliases: [],
  },
  'roles.adversarial.handoff.review_to_remediation': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_HANDOFF_REVIEW_TO_REMEDIATION',
    aliases: [],
  },
  'roles.adversarial.handoff.remediation_to_rereview': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_HANDOFF_REMEDIATION_TO_REREVIEW',
    aliases: [],
  },
  'roles.adversarial.handoff.final_to_hammer': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_HANDOFF_FINAL_TO_HAMMER',
    aliases: [],
  },
  'roles.adversarial.handoff.max_per_pr_head': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_HANDOFF_MAX_PER_PR_HEAD',
    aliases: [],
  },
  ...buildRoleFallbackEnvAliases(),
  'roles.quota_probe.ok_tick_seconds': {
    canonical: 'AGENT_OS_ROLES_QUOTA_PROBE_OK_TICK_SECONDS',
    aliases: [],
  },
  'roles.quota_probe.exhausted_unknown_tick_seconds': {
    canonical: 'AGENT_OS_ROLES_QUOTA_PROBE_EXHAUSTED_UNKNOWN_TICK_SECONDS',
    aliases: [],
  },
  'roles.quota_probe.evidence_ttl_seconds': {
    canonical: 'AGENT_OS_ROLES_QUOTA_PROBE_EVIDENCE_TTL_SECONDS',
    aliases: [],
  },
  'oauth_broker.watchdog.portforward_self_heal_max_cycles': {
    canonical: 'AGENT_OS_OAUTH_BROKER_WATCHDOG_PORTFORWARD_SELF_HEAL_MAX_CYCLES',
    aliases: [['OAUTH_BROKER_WATCHDOG_PORTFORWARD_SELF_HEAL_MAX_CYCLES', Number]],
  },
  'oauth_broker.watchdog.broker_standby_readyz_url': {
    canonical: 'AGENT_OS_OAUTH_BROKER_WATCHDOG_STANDBY_READYZ_URL',
    aliases: [['OAUTH_BROKER_WATCHDOG_STANDBY_READYZ_URL', identity]],
  },
  'oauth_broker.watchdog.broker_standby_container_name': {
    canonical: 'AGENT_OS_OAUTH_BROKER_WATCHDOG_STANDBY_CONTAINER_NAME',
    aliases: [['OAUTH_BROKER_WATCHDOG_STANDBY_CONTAINER_NAME', identity]],
  },
  'oauth_broker.watchdog.bridge_startup_grace_seconds': {
    canonical: 'AGENT_OS_OAUTH_BROKER_WATCHDOG_BRIDGE_STARTUP_GRACE_SECONDS',
    aliases: [['OAUTH_BROKER_WATCHDOG_BRIDGE_STARTUP_GRACE_SECONDS', Number]],
  },
  'oauth_broker.watchdog.bridge_recovery_timeout_seconds': {
    canonical: 'AGENT_OS_OAUTH_BROKER_WATCHDOG_BRIDGE_RECOVERY_TIMEOUT_SECONDS',
    aliases: [['OAUTH_BROKER_WATCHDOG_BRIDGE_RECOVERY_TIMEOUT_SECONDS', Number]],
  },
  'oauth_broker.watchdog.credential_decay_warn_after_seconds': {
    canonical: 'AGENT_OS_OAUTH_BROKER_WATCHDOG_CREDENTIAL_DECAY_WARN_AFTER_SECONDS',
    aliases: [['OAUTH_BROKER_WATCHDOG_CREDENTIAL_DECAY_WARN_AFTER_SECONDS', Number]],
  },
  'oauth_broker.watchdog.credential_decay_crit_after_seconds': {
    canonical: 'AGENT_OS_OAUTH_BROKER_WATCHDOG_CREDENTIAL_DECAY_CRIT_AFTER_SECONDS',
    aliases: [['OAUTH_BROKER_WATCHDOG_CREDENTIAL_DECAY_CRIT_AFTER_SECONDS', Number]],
  },
  'oauth_broker.watchdog.credential_decay_last_good_crit_expiry_margin_seconds': {
    canonical:
      'AGENT_OS_OAUTH_BROKER_WATCHDOG_CREDENTIAL_DECAY_LAST_GOOD_CRIT_EXPIRY_MARGIN_SECONDS',
    aliases: [
      ['OAUTH_BROKER_WATCHDOG_CREDENTIAL_DECAY_LAST_GOOD_CRIT_EXPIRY_MARGIN_SECONDS', Number],
    ],
  },
  'oauth_broker.watchdog.refresh_wedge_threshold_seconds': {
    canonical: 'AGENT_OS_OAUTH_BROKER_WATCHDOG_REFRESH_WEDGE_THRESHOLD_SECONDS',
    aliases: [['OAUTH_BROKER_WATCHDOG_REFRESH_WEDGE_THRESHOLD_SECONDS', Number]],
  },
  'oauth_broker.claude_code_corp_bridge.port': {
    canonical: 'AGENT_OS_OAUTH_BROKER_CLAUDE_CODE_CORP_BRIDGE_PORT',
    aliases: [],
  },
  'oauth_broker.claude_code_corp_bridge.audit_context': {
    canonical: 'AGENT_OS_OAUTH_BROKER_CLAUDE_CODE_CORP_BRIDGE_AUDIT_CONTEXT',
    aliases: [],
  },
  'oauth_broker.claude_code_corp_bridge.primary_url': {
    canonical: 'AGENT_OS_OAUTH_BROKER_CLAUDE_CODE_CORP_BRIDGE_PRIMARY_URL',
    aliases: [],
  },
  'oauth_broker.claude_code_corp_bridge.standby_url': {
    canonical: 'AGENT_OS_OAUTH_BROKER_CLAUDE_CODE_CORP_BRIDGE_STANDBY_URL',
    aliases: [],
  },
  'oauth_broker.claude_code_corp_bridge.watchdog_status_url': {
    canonical: 'AGENT_OS_OAUTH_BROKER_CLAUDE_CODE_CORP_BRIDGE_WATCHDOG_STATUS_URL',
    aliases: [['OAUTH_BROKER_WATCHDOG_CLAUDE_CODE_CORP_STATUS_URL', identity]],
  },
  'oauth_broker.claude_code_corp_bridge.secret_mirror_source': {
    canonical: 'AGENT_OS_OAUTH_BROKER_CLAUDE_CODE_CORP_BRIDGE_SECRET_MIRROR_SOURCE',
    aliases: [['CLAUDE_CODE_CORP_BRIDGE_SECRET_MIRROR_SRC', identity]],
  },
  'oauth_broker.keychain_bridge.auto_unlock.enabled': {
    canonical: 'AGENT_OS_OAUTH_BROKER_KEYCHAIN_BRIDGE_AUTO_UNLOCK_ENABLED',
    aliases: [['BRIDGE_AUTO_UNLOCK_ENABLED', identity]],
  },
  'oauth_broker.keychain_bridge.auto_unlock.command': {
    canonical: 'AGENT_OS_OAUTH_BROKER_KEYCHAIN_BRIDGE_AUTO_UNLOCK_COMMAND',
    aliases: [['BRIDGE_AUTO_UNLOCK_COMMAND', identity]],
  },
  'policy.dedup.uncommitted_line_threshold': {
    canonical: 'AGENT_OS_POLICY_DEDUP_UNCOMMITTED_LINE_THRESHOLD',
    aliases: [],
  },
  'agent_control.codex_runaway_guardrails.token_budget_per_session': {
    canonical: 'AGENT_OS_AGENT_CONTROL_CODEX_RUNAWAY_GUARDRAILS_TOKEN_BUDGET_PER_SESSION',
    aliases: [],
  },
  'agent_control.codex_runaway_guardrails.vocabulary_fatigue_window_commits': {
    canonical: 'AGENT_OS_AGENT_CONTROL_CODEX_RUNAWAY_GUARDRAILS_VOCABULARY_FATIGUE_WINDOW_COMMITS',
    aliases: [],
  },
  'agent_control.codex_runaway_guardrails.vocabulary_fatigue_min_repeats': {
    canonical: 'AGENT_OS_AGENT_CONTROL_CODEX_RUNAWAY_GUARDRAILS_VOCABULARY_FATIGUE_MIN_REPEATS',
    aliases: [],
  },
  'agent_gateway.alert_bus_url': {
    canonical: 'AGENT_OS_GBI_ALERT_BUS_URL',
    aliases: [
      ['AGENT_OS_AGENT_GATEWAY_ALERT_BUS_URL', identity],
      ['AGENT_GATEWAY_ALERT_BUS_URL', identity],
    ],
  },
  'sentinel.profile': {
    canonical: 'AGENT_OS_SENTINEL_PROFILE',
    aliases: [['HQ_SENTINEL_PROFILE', identity]],
  },
  'sentinel.quiet_window': {
    canonical: 'AGENT_OS_SENTINEL_QUIET_WINDOW',
    aliases: [['HQ_SENTINEL_QUIET_WINDOW', identity]],
  },
  'sentinel.spec_drift.cycle_interval_seconds': {
    canonical: 'AGENT_OS_SENTINEL_SPEC_DRIFT_CYCLE_INTERVAL_SECONDS',
    aliases: [['HQ_SENTINEL_SPEC_DRIFT_CYCLE_INTERVAL_SECONDS', identity]],
  },
  'sentinel.deploy_checkout.repo_path': {
    canonical: 'AGENT_OS_SENTINEL_DEPLOY_CHECKOUT_REPO_PATH',
    aliases: [['HQ_SENTINEL_DEPLOY_CHECKOUT_REPO_PATH', identity]],
  },
  'sentinel.deploy_checkout.scan_interval_seconds': {
    canonical: 'AGENT_OS_SENTINEL_DEPLOY_CHECKOUT_SCAN_INTERVAL_SECONDS',
    aliases: [['HQ_SENTINEL_DEPLOY_CHECKOUT_SCAN_INTERVAL_SECONDS', identity]],
  },
  'sentinel.deploy_checkout.page_dedupe_seconds': {
    canonical: 'AGENT_OS_SENTINEL_DEPLOY_CHECKOUT_PAGE_DEDUPE_SECONDS',
    aliases: [['HQ_SENTINEL_DEPLOY_CHECKOUT_PAGE_DEDUPE_SECONDS', identity]],
  },
  'sentinel.deploy_checkout.worker_identity_emails': {
    canonical: 'AGENT_OS_SENTINEL_DEPLOY_CHECKOUT_WORKER_IDENTITY_EMAILS',
    aliases: [['HQ_SENTINEL_DEPLOY_CHECKOUT_WORKER_IDENTITY_EMAILS', identity]],
  },
  'sentinel.codex_compaction.rate_alarm_per_hour': {
    canonical: 'AGENT_OS_SENTINEL_CODEX_COMPACTION_RATE_ALARM_PER_HOUR',
    aliases: [
      ['HQ_SENTINEL_CODEX_COMPACTION_RATE_ALARM_PER_HOUR', identity],
      ['SENTINEL_CODEX_COMPACTION_RATE_ALARM_PER_HOUR', identity],
    ],
  },
  'sentinel.codex_compaction.finding_dedupe_seconds': {
    canonical: 'AGENT_OS_SENTINEL_CODEX_COMPACTION_FINDING_DEDUPE_SECONDS',
    aliases: [['HQ_SENTINEL_CODEX_COMPACTION_FINDING_DEDUPE_SECONDS', identity]],
  },
  'sentinel.convergence_stall.observed_repos': {
    canonical: 'AGENT_OS_SENTINEL_CONVERGENCE_STALL_OBSERVED_REPOS',
    aliases: [['HQ_SENTINEL_CONVERGENCE_STALL_OBSERVED_REPOS', identity]],
  },
  'sentinel.convergence_stall.commit_window_seconds': {
    canonical: 'AGENT_OS_SENTINEL_CONVERGENCE_STALL_COMMIT_WINDOW_SECONDS',
    aliases: [['HQ_SENTINEL_CONVERGENCE_STALL_COMMIT_WINDOW_SECONDS', identity]],
  },
  'sentinel.convergence_stall.min_commits': {
    canonical: 'AGENT_OS_SENTINEL_CONVERGENCE_STALL_MIN_COMMITS',
    aliases: [['HQ_SENTINEL_CONVERGENCE_STALL_MIN_COMMITS', identity]],
  },
  'sentinel.convergence_stall.file_fetch_budget_per_cycle': {
    canonical: 'AGENT_OS_SENTINEL_CONVERGENCE_STALL_FILE_FETCH_BUDGET_PER_CYCLE',
    aliases: [['HQ_SENTINEL_CONVERGENCE_STALL_FILE_FETCH_BUDGET_PER_CYCLE', identity]],
  },
  'sentinel.convergence_stall.finding_dedupe_seconds': {
    canonical: 'AGENT_OS_SENTINEL_CONVERGENCE_STALL_FINDING_DEDUPE_SECONDS',
    aliases: [['HQ_SENTINEL_CONVERGENCE_STALL_FINDING_DEDUPE_SECONDS', identity]],
  },
  'sentinel.convergence_stall.repo_backoff_seconds': {
    canonical: 'AGENT_OS_SENTINEL_CONVERGENCE_STALL_REPO_BACKOFF_SECONDS',
    aliases: [['HQ_SENTINEL_CONVERGENCE_STALL_REPO_BACKOFF_SECONDS', identity]],
  },
  'sentinel.convergence_stall.observed_worker_classes': {
    canonical: 'AGENT_OS_SENTINEL_CONVERGENCE_STALL_OBSERVED_WORKER_CLASSES',
    aliases: [['HQ_SENTINEL_CONVERGENCE_STALL_OBSERVED_WORKER_CLASSES', identity]],
  },
  'sentinel.pipeline_stability.rca_dispatch.worker_class': {
    canonical: 'AGENT_OS_SENTINEL_PIPELINE_STABILITY_RCA_DISPATCH_WORKER_CLASS',
    aliases: [['HQ_SENTINEL_PIPELINE_STABILITY_RCA_DISPATCH_WORKER_CLASS', identity]],
  },
  'sentinel.detectors.litellm_routing_tier_outage.enabled': {
    canonical: 'AGENT_OS_SENTINEL_DETECTORS_LITELLM_ROUTING_TIER_OUTAGE_ENABLED',
    aliases: [],
  },
  'sentinel.detectors.litellm_routing_tier_outage.log_path': {
    canonical: 'AGENT_OS_SENTINEL_DETECTORS_LITELLM_ROUTING_TIER_OUTAGE_LOG_PATH',
    aliases: [],
  },
  'sentinel.detectors.litellm_routing_tier_outage.window_seconds': {
    canonical: 'AGENT_OS_SENTINEL_DETECTORS_LITELLM_ROUTING_TIER_OUTAGE_WINDOW_SECONDS',
    aliases: [],
  },
  'sentinel.detectors.litellm_routing_tier_outage.event_count_threshold': {
    canonical: 'AGENT_OS_SENTINEL_DETECTORS_LITELLM_ROUTING_TIER_OUTAGE_EVENT_COUNT_THRESHOLD',
    aliases: [],
  },
  'sentinel.detectors.litellm_routing_tier_outage.severity': {
    canonical: 'AGENT_OS_SENTINEL_DETECTORS_LITELLM_ROUTING_TIER_OUTAGE_SEVERITY',
    aliases: [],
  },
  'sentinel.detectors.litellm_routing_tier_outage.comms_channels': {
    canonical: 'AGENT_OS_SENTINEL_DETECTORS_LITELLM_ROUTING_TIER_OUTAGE_COMMS_CHANNELS',
    aliases: [],
  },
  'sentinel.disk_headroom.top_consumer_roots': {
    canonical: 'AGENT_OS_SENTINEL_DISK_HEADROOM_TOP_CONSUMER_ROOTS',
    aliases: [],
  },
  'sentinel.disk_headroom.top_consumer_limit': {
    canonical: 'AGENT_OS_SENTINEL_DISK_HEADROOM_TOP_CONSUMER_LIMIT',
    aliases: [],
  },
  'sentinel.disk_headroom.df_timeout_seconds': {
    canonical: 'AGENT_OS_SENTINEL_DISK_HEADROOM_DF_TIMEOUT_SECONDS',
    aliases: [],
  },
  'sentinel.disk_headroom.du_timeout_seconds': {
    canonical: 'AGENT_OS_SENTINEL_DISK_HEADROOM_DU_TIMEOUT_SECONDS',
    aliases: [],
  },
  'sentinel.disk_headroom.sensor_failure_page_threshold': {
    canonical: 'AGENT_OS_SENTINEL_DISK_HEADROOM_SENSOR_FAILURE_PAGE_THRESHOLD',
    aliases: [],
  },
  'services.ports.hcp': {
    canonical: 'AGENT_OS_SERVICES_PORTS_HCP',
    aliases: [],
  },
  'services.hcp.bind_host': {
    canonical: 'AGENT_OS_SERVICES_HCP_BIND_HOST',
    aliases: [],
  },
  'services.hcp.audit_keep_days': {
    canonical: 'AGENT_OS_SERVICES_HCP_AUDIT_KEEP_DAYS',
    aliases: [],
  },
  'services.hcp.token_expired_keep_days': {
    canonical: 'AGENT_OS_SERVICES_HCP_TOKEN_EXPIRED_KEEP_DAYS',
    aliases: [],
  },
  'services.hcp.token_revoked_keep_days': {
    canonical: 'AGENT_OS_SERVICES_HCP_TOKEN_REVOKED_KEEP_DAYS',
    aliases: [],
  },
  'services.hcp.idempotency_keep_days': {
    canonical: 'AGENT_OS_SERVICES_HCP_IDEMPOTENCY_KEEP_DAYS',
    aliases: [],
  },
  'services.hcp.confirmation_token_keep_minutes': {
    canonical: 'AGENT_OS_SERVICES_HCP_CONFIRMATION_TOKEN_KEEP_MINUTES',
    aliases: [],
  },
  'services.hcp.comms_jobs_keep_days': {
    canonical: 'AGENT_OS_SERVICES_HCP_COMMS_JOBS_KEEP_DAYS',
    aliases: [],
  },
  'services.hcp.rotation_cadence_days': {
    canonical: 'AGENT_OS_SERVICES_HCP_ROTATION_CADENCE_DAYS',
    aliases: [],
  },
  'services.hcp.console_capability_enforcement.default': {
    canonical: 'AGENT_OS_SERVICES_HCP_CONSOLE_CAPABILITY_ENFORCEMENT_DEFAULT',
    aliases: [],
  },
  'services.hcp.destructive_capability_enforcement.default': {
    canonical: 'AGENT_OS_SERVICES_HCP_DESTRUCTIVE_CAPABILITY_ENFORCEMENT_DEFAULT',
    aliases: [],
  },
  'services.hcp.persistent_agent_principals': {
    canonical: 'AGENT_OS_SERVICES_HCP_PERSISTENT_AGENT_PRINCIPALS',
    aliases: [],
  },
  'services.hcp.op_rate_limit_regex': {
    canonical: 'AGENT_OS_SERVICES_HCP_OP_RATE_LIMIT_REGEX',
    aliases: [],
  },
  'worker_pool.comms.responder.alert_lookback_hours': {
    canonical: 'AGENT_OS_WORKER_POOL_COMMS_RESPONDER_ALERT_LOOKBACK_HOURS',
    aliases: [],
  },
  'worker_pool.comms.responder.session_ttl_hours': {
    canonical: 'AGENT_OS_WORKER_POOL_COMMS_RESPONDER_SESSION_TTL_HOURS',
    aliases: [],
  },
  'session_ledger.backend': {
    canonical: 'AGENT_OS_SESSION_LEDGER_BACKEND',
    aliases: [['AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME', postgresRuntimeAlias]],
  },
  'session_ledger.dsn': {
    canonical: 'AGENT_OS_SESSION_LEDGER_DSN',
    aliases: [],
  },
  'session_ledger.database_name': {
    canonical: 'AGENT_OS_SESSION_LEDGER_DATABASE_NAME',
    aliases: [],
  },
  'session_ledger.vdb.enabled': {
    canonical: 'AGENT_OS_SESSION_LEDGER_VDB',
    aliases: [],
  },
  'session_ledger.vdb.direct_dsn': {
    canonical: 'AGENT_OS_SESSION_LEDGER_VDB_DIRECT_DSN',
    aliases: [],
  },
  'session_ledger.vdb.allowCanonicalFallback': {
    canonical: 'AGENT_OS_SESSION_LEDGER_VDB_ALLOW_CANONICAL_FALLBACK',
    aliases: [],
  },
  'session_ledger.exposure.score_half_life_days': {
    canonical: 'AGENT_OS_SESSION_LEDGER_EXPOSURE_SCORE_HALF_LIFE_DAYS',
    aliases: [],
  },
  'session_ledger.exposure.quarantine_threshold': {
    canonical: 'AGENT_OS_SESSION_LEDGER_EXPOSURE_QUARANTINE_THRESHOLD',
    aliases: [],
  },
  'operator.email': {
    canonical: 'AGENT_OS_OPERATOR_EMAIL',
    aliases: [],
  },
  'operator.full_name': {
    canonical: 'AGENT_OS_OPERATOR_FULL_NAME',
    aliases: [],
  },
  'operator.first_name': {
    canonical: 'AGENT_OS_OPERATOR_FIRST_NAME',
    aliases: [],
  },
  'operator.github_handle': {
    canonical: 'AGENT_OS_OPERATOR_GITHUB_HANDLE',
    aliases: [],
  },
  'github.org_email_domain': {
    canonical: 'AGENT_OS_GITHUB_ORG_EMAIL_DOMAIN',
    aliases: [['AGENT_OS_GITHUB_WORKSPACE_EMAIL_DOMAIN', identity]],
  },
  'github.workspace_email_domain': {
    canonical: 'AGENT_OS_GITHUB_WORKSPACE_EMAIL_DOMAIN',
    aliases: [],
  },
  'linear.team_name': {
    canonical: 'AGENT_OS_LINEAR_TEAM_NAME',
    aliases: [],
  },
  'linear.issue_prefix': {
    canonical: 'AGENT_OS_LINEAR_ISSUE_PREFIX',
    aliases: [],
  },
  'op.vault': {
    canonical: 'AGENT_OS_OP_VAULT',
    aliases: [],
  },
  'host.name': {
    canonical: 'AGENT_OS_HOST_NAME',
    aliases: [],
  },
  'host.tailscale_hostname': {
    canonical: 'AGENT_OS_TAILSCALE_HOSTNAME',
    aliases: [['TAILSCALE_HOSTNAME', identity]],
  },
  'tailscale.workstation_ip': {
    canonical: 'AGENT_OS_TAILSCALE_WORKSTATION_IP',
    aliases: [],
  },
  'tailscale.workstation_dns_name': {
    canonical: 'AGENT_OS_TAILSCALE_WORKSTATION_DNS_NAME',
    aliases: [],
  },
  'tailscale.daily_driver_ip': {
    canonical: 'AGENT_OS_TAILSCALE_DAILY_DRIVER_IP',
    aliases: [],
  },
  'tailscale.daily_driver_dns_name': {
    canonical: 'AGENT_OS_TAILSCALE_DAILY_DRIVER_DNS_NAME',
    aliases: [],
  },
  'tailscale.ipad_ip': {
    canonical: 'AGENT_OS_TAILSCALE_IPAD_IP',
    aliases: [],
  },
  'tailscale.ipad_dns_name': {
    canonical: 'AGENT_OS_TAILSCALE_IPAD_DNS_NAME',
    aliases: [],
  },
  'tailscale.iphone_ip': {
    canonical: 'AGENT_OS_TAILSCALE_IPHONE_IP',
    aliases: [],
  },
  'tailscale.iphone_dns_name': {
    canonical: 'AGENT_OS_TAILSCALE_IPHONE_DNS_NAME',
    aliases: [],
  },
  'launchd.label_prefix': {
    canonical: 'AGENT_OS_LAUNCHD_LABEL_PREFIX',
    aliases: [],
  },
  'openclaw.live': {
    canonical: 'AGENT_OS_OPENCLAW_LIVE',
    aliases: [],
  },
  'codex.acp_state_home': {
    // OSR-04a: parse-only here; runtime shell/Python consumers use it.
    canonical: 'AGENT_OS_CODEX_ACP_STATE_HOME',
    aliases: [],
  },
  // Per-task-kind dispatch default worker class env aliases. One canonical
  // env var per leaf — matches the Python sibling at
  // `platform/agent-os-config/src/agent_os_config/__init__.py`.
  'dispatch.default_worker_class_by_task_kind.coding': {
    canonical: 'AGENT_OS_DISPATCH_DEFAULT_WORKER_CLASS_BY_TASK_KIND_CODING',
    aliases: [],
  },
  'dispatch.default_worker_class_by_task_kind.research': {
    canonical: 'AGENT_OS_DISPATCH_DEFAULT_WORKER_CLASS_BY_TASK_KIND_RESEARCH',
    aliases: [],
  },
  'dispatch.default_worker_class_by_task_kind.drafting': {
    canonical: 'AGENT_OS_DISPATCH_DEFAULT_WORKER_CLASS_BY_TASK_KIND_DRAFTING',
    aliases: [],
  },
  'dispatch.default_worker_class_by_task_kind.analysis': {
    canonical: 'AGENT_OS_DISPATCH_DEFAULT_WORKER_CLASS_BY_TASK_KIND_ANALYSIS',
    aliases: [],
  },
  'dispatch.default_worker_class_by_task_kind.other': {
    canonical: 'AGENT_OS_DISPATCH_DEFAULT_WORKER_CLASS_BY_TASK_KIND_OTHER',
    aliases: [],
  },
  'dispatch.default_worker_class_by_task_kind.merge': {
    canonical: 'AGENT_OS_DISPATCH_DEFAULT_WORKER_CLASS_BY_TASK_KIND_MERGE',
    aliases: [],
  },
  'dispatch.default_worker_class_by_task_kind.merge_conflict_resolution': {
    canonical: 'AGENT_OS_DISPATCH_DEFAULT_WORKER_CLASS_BY_TASK_KIND_MERGE_CONFLICT_RESOLUTION',
    aliases: [],
  },
  'dispatch.default_worker_class_by_task_kind.merge_comment_only_followups': {
    canonical: 'AGENT_OS_DISPATCH_DEFAULT_WORKER_CLASS_BY_TASK_KIND_MERGE_COMMENT_ONLY_FOLLOWUPS',
    aliases: [],
  },
  'dispatch.default_worker_class_by_task_kind.merge_agent_failure_recovery': {
    canonical: 'AGENT_OS_DISPATCH_DEFAULT_WORKER_CLASS_BY_TASK_KIND_MERGE_AGENT_FAILURE_RECOVERY',
    aliases: [],
  },
  'feature_flags.merge_agent_final_pass_on_request_changes': {
    canonical: 'AGENT_OS_FEATURE_FLAGS_MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES',
    aliases: [['MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES', identity]],
  },
  'feature_flags.dismiss_stale_request_changes_on_resolved': {
    canonical: 'AGENT_OS_FEATURE_FLAGS_DISMISS_STALE_REQUEST_CHANGES_ON_RESOLVED',
    aliases: [['DISMISS_STALE_REQUEST_CHANGES_ON_RESOLVED', identity]],
  },
  'feature_flags.merge_agent_deterministic_convergence_terminal': {
    canonical: 'AGENT_OS_FEATURE_FLAGS_MERGE_AGENT_DETERMINISTIC_CONVERGENCE_TERMINAL',
    aliases: [['MERGE_AGENT_DETERMINISTIC_CONVERGENCE_TERMINAL', identity]],
  },
  'feature_flags.allow_missing_alert_to': {
    canonical: 'AGENT_OS_FEATURE_FLAGS_ALLOW_MISSING_ALERT_TO',
    aliases: [['ADVERSARIAL_REVIEW_ALLOW_MISSING_ALERT_TO', identity]],
  },
  'feature_flags.resume_context_envelope': {
    canonical: 'AGENT_OS_FEATURE_FLAGS_RESUME_CONTEXT_ENVELOPE',
    aliases: [],
  },
  'roles.merge_agent_failure_recovery.worker_class': {
    canonical: 'AGENT_OS_ROLES_MERGE_AGENT_FAILURE_RECOVERY_WORKER_CLASS',
    aliases: [['MERGE_AGENT_FAILURE_RECOVERY_WORKER_CLASS', identity]],
  },
  'roles.merge_agent_failure_recovery.fallback_path': {
    canonical: 'AGENT_OS_ROLES_MERGE_AGENT_FAILURE_RECOVERY_FALLBACK_PATH',
    aliases: [['LITELLM_VK_FALLBACK_FOR_MERGE_AGENT_FAILURE_RECOVERY', identity]],
  },
  'handoff.final_to_hammer': {
    canonical: 'AGENT_OS_HANDOFF_FINAL_TO_HAMMER',
    aliases: [['ADVERSARIAL_REVIEW_HANDOFF_FINAL_TO_HAMMER', identity]],
  },
};

const ENTITLEMENT_ENV_ALIAS_IDS = [
  'claude-worker',
  'codex-worker-lacey',
  'gemini-worker',
  'pi-worker',
  'hermes-worker',
  'opencode-worker',
  'merge-agent-worker',
  'merge-agent-lacey',
  'post-merge-actions-worker',
  'clio-agent-worker',
  'foundry-draft-worker',
  'sentinel-talk',
  'sre-worker',
  'stub-worker',
];

const ENTITLEMENT_ENV_ALIAS_FIELDS = [
  'git_name',
  'git_email',
  'gh_token_var',
  'gh_token_op_ref',
  'gh_token_op_ref_fallback',
  'gh_bot_login',
];

for (const entitlementId of ENTITLEMENT_ENV_ALIAS_IDS) {
  const entitlementEnvId = entitlementId.toUpperCase().replaceAll('-', '_');
  for (const field of ENTITLEMENT_ENV_ALIAS_FIELDS) {
    ENV_ALIASES[`entitlements.${entitlementId}.${field}`] = {
      canonical: `AGENT_OS_ENTITLEMENTS_${entitlementEnvId}_${field.toUpperCase()}`,
      aliases: [],
    };
  }
}

// -------- YAML 1.2 strict-bool loader --------------------------------------

// js-yaml's DEFAULT_SCHEMA is already YAML 1.2 — `yes`/`no`/`on`/`off`
// parse as strings out of the box. We re-affirm here by NOT using
// JS_COMPAT_SCHEMA. The schema-validator catches them downstream.

function parseYaml(text, sourcePath) {
  if (String(text ?? '').trim() === '') return null;
  try {
    return __testYamlHooks.load(text, {
      schema: yaml.DEFAULT_SCHEMA,
      filename: sourcePath,
      // Convert warnings into fail-loud errors. The warning's `.mark` carries
      // the line/column so we surface the offending statement to the operator.
      onWarning: (warn) => {
        const line = extractYamlErrorLine(warn);
        const where = line !== null ? `${sourcePath}:${line}` : sourcePath;
        const reason = warn && warn.reason ? warn.reason : (warn && warn.message) || String(warn);
        throw new AgentOSConfigError(
          `malformed YAML in ${where}: ${reason}`,
          { source: where },
        );
      },
    });
  } catch (err) {
    if (err instanceof AgentOSConfigError) throw err;
    if (isEmptyYamlDocumentError(err)) return null;
    const line = extractYamlErrorLine(err);
    const where = line !== null ? `${sourcePath}:${line}` : sourcePath;
    const reason = err && err.reason ? err.reason : (err && err.message) || String(err);
    throw new AgentOSConfigError(
      `malformed YAML in ${where}: ${reason}`,
      { source: where },
    );
  }
}

function isEmptyYamlDocumentError(err) {
  const reason = err && err.reason ? err.reason : '';
  const message = err && err.message ? err.message : '';
  return reason === 'expected a document, but the input is empty' || message.includes('expected a document, but the input is empty');
}

function extractYamlErrorLine(err) {
  if (!err) return null;
  // js-yaml YAMLException carries .mark with .line (0-indexed).
  const mark = err.mark;
  if (mark && typeof mark.line === 'number') return mark.line + 1;
  // Fallback: js-yaml's message text trails with `(L:C)` — parse it.
  const msg = err.message || '';
  const match = msg.match(/\((\d+):\d+\)/);
  if (match) return Number(match[1]);
  return null;
}

// -------- Validation -------------------------------------------------------

function fmtEnum(values) {
  return '[' + values.map((v) => JSON.stringify(v)).join(', ') + ']';
}

function jsTypeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// Mirrors agent_os_config.validation._check_leaf; keep both in step.
function checkLeaf(value, schema, keyPath, source, tolerateUnknown = false, nested = {}) {
  const fail = (message, expected, got = value) => {
    throw new AgentOSConfigError(`${keyPath}: ${message}`, { key: keyPath, expected, got, source });
  };
  const normalizeWith = (normalize) => {
    try { return normalize(value); } catch (error) { throw new AgentOSConfigError(`${keyPath}: ${error.message}`, { key: keyPath, source }); }
  };
  if (schema.__repository_list) return normalizeWith(normalizeDisabledRepositories);
  if (schema.__lane_routes) return normalizeWith(normalizeLaneRoutes);
  const expected = schema.__type;
  if (expected === 'any') return value; // validated atomically after the cascade
  if (value === null || value === undefined) {
    if (schema.__nullable) return null;
    // Explicit null (`key: ~`) is not "omitted"; defaults never reach here.
    fail(`expected ${expected}, got null${Object.hasOwn(schema, '__default') ? ' (omit the key to keep the default)' : ''}`, expected, null);
  }
  const shown = JSON.stringify(value);
  if (expected === TYPE_BOOL) {
    if (typeof value !== 'boolean') {
      const instr = typeof value === 'string' ? 'use `true` or `false` (YAML 1.2 booleans only)' : 'boolean required';
      fail(`expected bool, got ${jsTypeName(value)} (${shown}); ${instr}`, 'bool');
    }
  } else if (expected === TYPE_INT) {
    if (!Number.isInteger(value)) fail(`expected int, got ${jsTypeName(value)} (${shown})`, 'int');
  } else if (expected === TYPE_FLOAT) {
    if (typeof value !== 'number') fail(`expected float, got ${jsTypeName(value)} (${shown})`, 'float');
    if (!Number.isFinite(value)) fail(`expected finite float, got ${value}`, 'finite float');
  } else if (expected === TYPE_STRING) {
    if (schema.__coerce_number_to_string && typeof value === 'number' && Number.isFinite(value)) value = String(value);
    if (typeof value !== 'string') fail(`expected string, got ${jsTypeName(value)} (${shown})`, 'string');
    if (schema.__lowercase) value = value.toLowerCase();
    if (schema.__pattern !== undefined && !new RegExp(schema.__pattern).test(value)) {
      const description = schema.__pattern_description || schema.__pattern;
      fail(`value ${JSON.stringify(value)} does not match ${description}`, description);
    }
  } else if (expected === TYPE_DICT) {
    return validateDictPresentKeysOnly(value, schema, keyPath, source, null, tolerateUnknown, nested);
  } else if (expected === TYPE_LIST) {
    if (!Array.isArray(value)) fail(`expected list, got ${jsTypeName(value)} (${shown})`, 'list');
    if (schema.__item) value = value.map((item, index) => checkLeaf(item, schema.__item, `${keyPath}[${index}]`, source, tolerateUnknown, nested));
    if (schema.__unique) value = [...new Map(value.map(item => [JSON.stringify(item), item])).values()];
    if (schema.__min_items !== undefined && value.length < schema.__min_items) {
      fail(`expected at least ${schema.__min_items} item(s), got ${value.length}`, `>= ${schema.__min_items} item(s)`);
    }
    if (schema.__max_items !== undefined && value.length > schema.__max_items) {
      fail(`expected at most ${schema.__max_items} item(s), got ${value.length}`, `<= ${schema.__max_items} item(s)`);
    }
  }
  if (typeof value === 'number') {
    if (schema.__min !== undefined && value < schema.__min && !(schema.__allow_zero && value === 0)) {
      fail(`expected >= ${schema.__min}, got ${value}`, `>= ${schema.__min}`);
    }
    // Only enforced maxima exist: CFG projects no advisory __max.
    if (schema.__max !== undefined && value > schema.__max) fail(`expected <= ${schema.__max}, got ${value}`, `<= ${schema.__max}`);
  }
  if (schema.__enum && !schema.__enum.includes(value)) {
    throw new AgentOSConfigError(`${keyPath}: value ${shown} not in allowlist ${fmtEnum(schema.__enum)}`, {
      key: keyPath, expected: `one of ${fmtEnum(schema.__enum)}`, allowed: schema.__enum, got: value, source,
    });
  }
  if (schema.__disallow?.includes(value)) fail(`value ${shown} is not allowed`, `not one of ${fmtEnum(schema.__disallow)}`);
  if (schema.__normalize && Object.hasOwn(schema.__normalize, value)) return schema.__normalize[value];
  return value;
}

function nearestValidKey(unknown, allowed) {
  let best = null;
  let bestScore = 0;
  for (const candidate of allowed) {
    const score = stringSimilarity(unknown, candidate);
    if (score > bestScore && score >= 0.6) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function stringSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (longer.length === 0) return 1;
  const dist = levenshtein(longer, shorter);
  return (longer.length - dist) / longer.length;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function annotateLine(source, lineMap, key) {
  if (!source) return null;
  if (!lineMap || !(key in lineMap)) return source;
  return `${source}:${lineMap[key]}`;
}

function buildLineMap(text, allowedTopKeys) {
  const out = {};
  const allowed = new Set(allowedTopKeys);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.replace(/^[\s]+/, '');
    if (!stripped || stripped.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:/);
    if (match && line[0] !== ' ' && line[0] !== '\t') {
      const key = match[1];
      if (allowed.has(key) && !(key in out)) out[key] = i + 1;
    }
  }
  return out;
}

// Mirrors agent_os_config.validation._validate_dict_present_keys_only:
// returns only present keys (no default fill). `tolerateUnknown` (operator
// overlays and runtime loads) drops unknown keys at any depth instead of
// raising, so a key from a newer schema cannot crash a lagging daemon;
// consumed atomic policies (`__strict_always`) never tolerate.
function validateDictPresentKeysOnly(
  doc,
  schema,
  keyPath,
  source,
  lineMap,
  tolerateUnknown = false,
  { warnUnknownOnce = false, warningSource = null, droppedUnknownKeys = null } = {},
) {
  const strictAlways = Boolean(schema.__strict_always);
  if ((doc === null || doc === undefined) && strictAlways) {
    throw new AgentOSConfigError(`${keyPath}: expected mapping`, { key: keyPath, source });
  }
  if (doc === null || doc === undefined) return {};
  const allowed = schema.__keys || {};
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    const scalarKey = schema.__scalar_default_key;
    if (typeof scalarKey === 'string' && Object.hasOwn(allowed, scalarKey)) {
      return { [scalarKey]: checkLeaf(doc, allowed[scalarKey], keyPath ? `${keyPath}.${scalarKey}` : scalarKey, source, tolerateUnknown, { warnUnknownOnce, warningSource, droppedUnknownKeys }) };
    }
    const anchor = keyPath || '(root)';
    throw new AgentOSConfigError(`${anchor}: expected mapping, got ${jsTypeName(doc)}`, {
      key: anchor, expected: 'mapping', got: jsTypeName(doc), source,
    });
  }
  if (strictAlways) {
    tolerateUnknown = false;
    if (Object.keys(doc).some(key => key.startsWith('__'))) {
      throw new AgentOSConfigError(`${keyPath}: unknown policy key`, { key: keyPath, source });
    }
  }
  // CFG requires complete atomic declarations (array items, keyed policies,
  // and version); keep Python parity rather than deferring security completeness.
  for (const [key, child] of Object.entries(allowed)) {
    if (child.__required && !Object.hasOwn(doc, key)) {
      const full = keyPath ? `${keyPath}.${key}` : key;
      throw new AgentOSConfigError(`${full}: required key is missing`, { key: full, expected: 'required key', got: null, source });
    }
  }
  const strict = schema.__strict !== false;
  const extraSchema = schema.__extra_keys_schema || null;
  const nested = { warnUnknownOnce, warningSource: warningSource || source, droppedUnknownKeys };
  const out = {};
  for (const [key, raw] of Object.entries(doc)) {
    // Metadata keys (`__aliases`, ...) are skipped, as in Python.
    if (key.startsWith('__') && !strictAlways) continue;
    const full = keyPath ? `${keyPath}.${key}` : key;
    const childSource = annotateLine(source, lineMap, key);
    if (!Object.hasOwn(allowed, key)) {
      if (!strict && extraSchema) {
        out[key] = extraSchema.__type === TYPE_DICT
          ? validateDictPresentKeysOnly(raw, extraSchema, full, childSource, null, tolerateUnknown, nested)
          : checkLeaf(raw, extraSchema, full, childSource, tolerateUnknown, nested);
      } else if (strict) {
        const near = nearestValidKey(key, Object.keys(allowed));
        const hint = near ? ` did you mean ${keyPath ? `${keyPath}.` : ''}${JSON.stringify(near)}?` : '';
        if (!tolerateUnknown) {
          throw new AgentOSConfigError(`${full}: unknown key (strict schema)${hint}`, {
            key: full, expected: `one of ${JSON.stringify(Object.keys(allowed).sort())}`, got: key, source: childSource,
          });
        }
        if (warnUnknownOnce) {
          warnRuntimeUnknownKeyOnce(full, nested.warningSource, hint);
          droppedUnknownKeys?.push({ key: full, source: runtimeWarningSource(nested.warningSource), hint: hint.trim() });
        } else {
          configDebugLog(`dropping unknown key ${JSON.stringify(full)}${source ? ` (${source})` : ''} — not in this reader's schema`);
        }
      } // An open section without a typed extra schema drops the child, as in Python.
      continue;
    }
    const child = allowed[key];
    if (child.__type === TYPE_DICT) {
      out[key] = validateDictPresentKeysOnly(raw, child, full, childSource, null, tolerateUnknown, nested);
      continue;
    }
    if (child.__read_only) {
      throw new AgentOSConfigError(`${full}: read-only diagnostic value (${child.__read_only})`, {
        key: full, expected: 'not configured in YAML', got: raw, source: childSource,
      });
    }
    out[key] = checkLeaf(raw, child, full, childSource, tolerateUnknown, nested);
  }
  return out;
}

// Mirrors agent_os_config.validation._validate_secrets_config (rejection only;
// this reader consumes no vault policy, so it does not normalize one).
function validateWorkerClassVaults(secrets) {
  if (!secrets || typeof secrets !== 'object') return;
  const shared = Array.isArray(secrets.shared_vaults) ? secrets.shared_vaults : [];
  const policies = Object.entries(secrets.worker_class_vaults ?? {}).map(([name, policy]) => [`worker_pool.secrets.worker_class_vaults.${name}`, policy]);
  const fallback = secrets.default_vault_policy;
  if (fallback && Object.values(fallback).some(value => ![null, '', undefined].includes(value)
    && !(Array.isArray(value) && !value.length))) policies.push(['worker_pool.secrets.default_vault_policy', fallback]);
  for (const [key, policy] of policies) {
    const { vault = null, service_account_token_ref: ref = null } = policy ?? {};
    const optin = policy?.shared_vault_optin ?? [];
    const fail = (leaf, message) => {
      throw new AgentOSConfigError(`${key}.${leaf}: ${message}`, { key: `${key}.${leaf}` });
    };
    if (!Array.isArray(optin)) fail('shared_vault_optin', 'expected list');
    if (vault === null && ref === null && !optin.length) continue;
    if (typeof vault !== 'string' || !vault.trim()) fail('vault', 'required non-empty string');
    if (typeof ref !== 'string' || !/^op:\/\/([^/]+)\/(.+)\/([^/]+)$/.test(ref.trim())) {
      fail('service_account_token_ref', 'expected full op://<vault>/<item>/<field> ref');
    }
    optin.forEach((item, index) => {
      if (!shared.includes(item)) fail(`shared_vault_optin[${index}]`, `${JSON.stringify(item)} not present in worker_pool.secrets.shared_vaults`);
    });
  }
}

function validatePublicHygiene(policy = {}) {
  policy ??= {};
  const refuse = field => { throw new AgentOSConfigError(
    `worker_pool.public_hygiene.${field}: invalid public hygiene policy; repair host configuration`,
    { key: `worker_pool.public_hygiene.${field}` },
  ); };
  policy.repos ??= [];
  policy.identities ??= {};
  const repos = policy.repos;
  if (!Array.isArray(repos) || repos.some(repo => typeof repo !== 'string'
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
    || repo.endsWith('.git') || repo.split('/').some(part => ['.', '..'].includes(part)))) refuse('repos');
  const identities = policy.identities ?? {};
  for (const [workerClass, identity] of Object.entries(identities)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(workerClass) || !identity
      || Object.keys(identity).sort().join(',') !== 'email,name'
      || Object.values(identity).some(value => typeof value !== 'string' || !value.trim() || /[|\r\n\0]/.test(value))) refuse('identities');
  }
  if (repos.length || Object.hasOwn(policy, 'denylist_path')) {
    const path = policy.denylist_path;
    if (typeof path !== 'string' || !path.startsWith('/') || /[\r\n\0]/.test(path)) refuse('denylist_path');
    try {
      if (!statSync(path).isFile()) refuse('denylist_path');
      new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
    } catch { refuse('denylist_path'); }
  }
}

export function validateSchema(doc, options = {}) {
  const validated = validateSchemaLayer(doc, options);
  validateOAuthDeclarations(validated.oauth ?? {}, null, options.source);
  validateSearch(validated.services?.hcp?.search);
  validatePublicHygiene(validated.worker_pool?.public_hygiene);
  return validated;
}

// Cascade layers may reference accounts from another layer or be superseded.
// Only the public single-document validator and final merged config validate
// declaration semantics; this private layer validator preserves atomic maps.
function validateSchemaLayer(
  doc,
  {
    source = null,
    rawText = null,
    tolerateUnknown = false,
    warnUnknownOnce = false,
    droppedUnknownKeys = null,
  } = {},
) {
  const schema = schemaV1();
  const lineMap = rawText ? buildLineMap(rawText, Object.keys(schema.__keys)) : null;
  if (doc === null || doc === undefined) {
    throw new AgentOSConfigError(
      `missing schema version: top-level config must declare \`version: ${SCHEMA_VERSION}\``,
      { key: 'version', expected: String(SCHEMA_VERSION), got: '<missing>', source },
    );
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new AgentOSConfigError(
      `top-level YAML must be a mapping, got ${jsTypeName(doc)}`,
      { source },
    );
  }
  if (!('version' in doc)) {
    throw new AgentOSConfigError(
      `missing schema version: top-level config must declare \`version: ${SCHEMA_VERSION}\``,
      { key: 'version', expected: String(SCHEMA_VERSION), got: '<missing>', source },
    );
  }
  if (doc.version !== SCHEMA_VERSION) {
    throw new AgentOSConfigError(
      `unknown schema version: ${JSON.stringify(doc.version)} (expected ${SCHEMA_VERSION})`,
      { key: 'version', expected: String(SCHEMA_VERSION), got: doc.version, source },
    );
  }
  if (Object.hasOwn(doc, 'osg')) validateOsgShape(doc.osg, source);

  return validateDictPresentKeysOnly(
    doc,
    schema,
    '',
    source,
    lineMap,
    tolerateUnknown,
    {
      warnUnknownOnce,
      warningSource: source,
      droppedUnknownKeys,
    },
  );
}

// -------- Module file validation -------------------------------------------

function flatten(doc, prefix = '', preserveEmptyMap = () => false, atomicPaths = new Set()) {
  const out = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith('__')) continue;
    const full = prefix ? `${prefix}.${key}` : key;
    if (atomicPaths.has(full) || SEARCH_LIMIT_PATHS.has(full)) {
      out[full] = value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (Object.keys(value).length > 0) {
        Object.assign(out, flatten(value, full, preserveEmptyMap, atomicPaths));
      } else if (preserveEmptyMap(full)) {
        out[full] = value;
      }
    } else {
      out[full] = value;
    }
  }
  return out;
}

const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function assertSafePathSegment(segment, dottedKey) {
  if (UNSAFE_PATH_SEGMENTS.has(segment)) {
    throw new AgentOSConfigError(
      `config path ${JSON.stringify(dottedKey)} contains unsafe segment ${JSON.stringify(segment)}`,
      { key: dottedKey, expected: 'safe dotted path', got: segment },
    );
  }
}

function setLeaf(target, dottedKey, value) {
  const parts = dottedKey.split('.');
  setLeafPath(target, parts, value, { dottedKey, rejectUnsafeSegments: true });
}

function setLeafPath(
  target,
  parts,
  value,
  { dottedKey = parts.join('.'), rejectUnsafeSegments = false } = {},
) {
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (rejectUnsafeSegments) assertSafePathSegment(part, dottedKey);
    let existing = Object.prototype.hasOwnProperty.call(cursor, part)
      ? cursor[part]
      : undefined;
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      existing = {};
      Object.defineProperty(cursor, part, {
        value: existing,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    cursor = existing;
  }
  const leaf = parts[parts.length - 1];
  if (rejectUnsafeSegments) assertSafePathSegment(leaf, dottedKey);
  Object.defineProperty(cursor, leaf, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function getLeaf(source, dottedKey) {
  const parts = dottedKey.split('.');
  let cursor = source;
  for (const part of parts) {
    if (UNSAFE_PATH_SEGMENTS.has(part)) return MISSING;
    if (
      !cursor ||
      typeof cursor !== 'object' ||
      !Object.prototype.hasOwnProperty.call(cursor, part)
    ) {
      return MISSING;
    }
    cursor = cursor[part];
  }
  return cursor;
}

const MISSING = Symbol('missing');

function validateModuleDoc(
  doc,
  source,
  rawText,
  {
    tolerateUnknown = false,
    preserveEmptyMaps = false,
    warnUnknownOnce = false,
    droppedUnknownKeys = null,
  } = {},
) {
  if (doc === null || doc === undefined) return { validated: {}, aliases: {} };
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new AgentOSConfigError(
      `${source}: top-level YAML must be a mapping, got ${jsTypeName(doc)}`,
      { source },
    );
  }
  if ('version' in doc) {
    throw new AgentOSConfigError(
      `${source}: module config.yaml must NOT declare \`version\` (top-level lock only)`,
      { key: 'version', source },
    );
  }
  const schema = schemaV1();
  const aliasesRaw = doc.__aliases || {};
  if (typeof aliasesRaw !== 'object' || Array.isArray(aliasesRaw)) {
    throw new AgentOSConfigError(
      `${source}: __aliases must be a mapping`,
      { key: '__aliases', expected: 'mapping', got: jsTypeName(aliasesRaw), source },
    );
  }
  const aliases = {};
  const unreadAliases = new Set();
  const schemaForAliasCheck = schemaV1();
  for (const [moduleKey, canonicalKey] of Object.entries(aliasesRaw)) {
    if (typeof moduleKey !== 'string' || typeof canonicalKey !== 'string') {
      throw new AgentOSConfigError(
        `${source}: __aliases entries must map string→string (${JSON.stringify(moduleKey)}→${JSON.stringify(canonicalKey)})`,
        { source },
      );
    }
    if (!isValidSchemaPath(schemaForAliasCheck, canonicalKey)) {
      const parts = canonicalKey.split('.');
      const consumedAtomicPath = [...TOKEN_POOL_DECLARATION_PATHS]
        .some(path => canonicalKey.startsWith(`${path}.`))
        || parts.some((_, index) =>
          schemaLeaf(schemaForAliasCheck, parts.slice(0, index + 1).join('.'))?.__strict_always);
      if (!consumedAtomicPath) {
        unreadAliases.add(moduleKey);
        configDebugLog(`ignoring alias ${JSON.stringify(moduleKey)} to unread key ${JSON.stringify(canonicalKey)}`);
        continue;
      }
      throw new AgentOSConfigError(
        `${source}: __aliases canonical key ${JSON.stringify(canonicalKey)} (target of ${JSON.stringify(moduleKey)}) is not in the schema`,
        {
          key: canonicalKey,
          expected: 'known canonical schema key',
          got: canonicalKey,
          source,
        },
      );
    }
    aliases[moduleKey] = canonicalKey;
  }

  const body = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k !== '__aliases') body[k] = v;
  }

  // Local overrides preserve accepted empty maps; unknown empty maps retain
  // their historical drop behavior, and module normalization stays unchanged.
  // Preserve the strict search subtree until schema validation, including
  // metadata-prefixed keys and empty maps that generic flattening drops.
  const atomicPaths = new Set([...TOKEN_POOL_DECLARATION_PATHS, 'services.hcp.search']);
  const rawFlat = flatten(body, '', (key) =>
    preserveEmptyMaps && isValidSchemaPath(schema, aliases[key] || key),
    new Set([
      ...atomicPaths,
      ...Object.entries(aliases).filter(([, canonical]) => atomicPaths.has(canonical)).map(([key]) => key),
    ]),
  );
  for (const [moduleKey, canonicalKey] of Object.entries(aliases)) {
    if (moduleKey in rawFlat && canonicalKey in rawFlat) {
      const mv = rawFlat[moduleKey];
      const cv = rawFlat[canonicalKey];
      if (!sameValue(mv, cv)) {
        if (TOKEN_POOL_DECLARATION_PATHS.has(canonicalKey)) {
          throw new AgentOSConfigError(
            `${source}: ${canonicalKey}: conflicting declarations; set one only`,
            { key: canonicalKey, expected: 'single declaration', source },
          );
        }
        throw new AgentOSConfigError(
          `${source}: same-file alias conflict — ${moduleKey}=${JSON.stringify(mv)} but ${canonicalKey}=${JSON.stringify(cv)}; set one only`,
          {
            key: canonicalKey,
            expected: 'single value or matching across aliased keys',
            got: `${moduleKey}=${JSON.stringify(mv)}, ${canonicalKey}=${JSON.stringify(cv)}`,
            source,
          },
        );
      }
    }
  }

  const canonicalFlat = {};
  for (const [key, value] of Object.entries(rawFlat)) {
    if ([...unreadAliases].some(alias => key === alias || key.startsWith(`${alias}.`))) continue;
    const canonical = aliases[key] || key;
    canonicalFlat[canonical] = value;
  }

  const canonicalBody = {};
  for (const [dotted, value] of Object.entries(canonicalFlat)) {
    setLeaf(canonicalBody, dotted, value);
  }

  if (Object.hasOwn(canonicalBody, 'osg')) validateOsgShape(canonicalBody.osg, source);
  const moduleSchema = {
    __type: TYPE_DICT,
    __strict: schema.__strict,
    __keys: {},
  };
  for (const [k, v] of Object.entries(schema.__keys)) {
    if (k !== 'version') moduleSchema.__keys[k] = v;
  }
  const lineMap = rawText ? buildLineMap(rawText, Object.keys(moduleSchema.__keys)) : null;
  const validated = validateDictPresentKeysOnly(
    canonicalBody,
    moduleSchema,
    '',
    source,
    lineMap,
    tolerateUnknown,
    {
      warnUnknownOnce,
      warningSource: source,
      droppedUnknownKeys,
    },
  );
  return { validated, aliases };
}

function sameValue(a, b) {
  // Order-independent deep equality so dict-typed alias values don't trigger
  // spurious "same-file alias conflict" errors on key-order coincidence.
  return isDeepStrictEqual(a, b);
}

// -------- Defaults builder -------------------------------------------------

// Mirrors agent_os_config.validation._build_defaults_dict.
function buildDefaultsDict(schema) {
  const out = {};
  for (const [key, child] of Object.entries(schema.__keys || {})) {
    if (key === 'version' || child.__alias_of) continue;
    if (child.__type === TYPE_DICT) {
      out[key] = buildDefaultsDict(child);
    } else if (Object.hasOwn(child, '__default')) {
      out[key] = structuredClone(child.__default);
    }
  }
  return out;
}

// -------- Env layer --------------------------------------------------------

function checkEnvOverlap(key, canonicalEnv, aliases, env) {
  const seen = [];
  if (canonicalEnv in env) seen.push([canonicalEnv, env[canonicalEnv]]);
  for (const [aliasName, coerce] of aliases) {
    if (aliasName in env) seen.push([aliasName, coerce(env[aliasName])]);
  }
  if (seen.length === 0) return [null, null];
  if (seen.length === 1) return seen[0];
  const distinct = new Set(seen.map(([, v]) => v));
  if (distinct.size === 1) {
    for (const [name, value] of seen) {
      if (name === canonicalEnv) return [name, value];
    }
    return seen[0];
  }
  const pairs = seen.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(', ');
  throw new AgentOSConfigError(
    `${key}: env-alias conflict — multiple env vars set with different values (${pairs})`,
    {
      key,
      expected: 'single env value or matching aliases',
      got: pairs,
      conflictingEnvNames: seen.map(([name]) => name),
    },
  );
}

function coerceEnvValue(key, value, schemaLeaf, source = null) {
  const expected = schemaLeaf.__type;
  if (expected === TYPE_BOOL) {
    const lower = value.trim().toLowerCase();
    if (lower === '') return false;
    if (lower === 'true' || lower === '1') return true;
    if (lower === 'false' || lower === '0') return false;
    throw new AgentOSConfigError(
      `${key}: env value ${JSON.stringify(value)} is not a recognized boolean (use 'true'/'false', '1'/'0', or empty string for false)`,
      { key, expected: 'bool', got: value, source },
    );
  }
  if (expected === TYPE_INT) {
    const n = Number(value);
    // Niceness must not silently disable scheduling isolation on a blank env.
    // Preserve legacy blank-to-zero handling for existing integer contracts.
    if ((key === 'worker_pool.worker_process_niceness' && value.trim() === '') || !Number.isInteger(n)) {
      throw new AgentOSConfigError(
        `${key}: env value ${JSON.stringify(value)} is not an integer`,
        { key, expected: 'int', got: value, source },
      );
    }
    return n;
  }
  if (expected === TYPE_FLOAT) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new AgentOSConfigError(
        `${key}: env value ${JSON.stringify(value)} is not a float`,
        { key, expected: 'float', got: value, source },
      );
    }
    return n;
  }
  if (expected === TYPE_LIST) {
    const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
    // Coerce items the way a scalar leaf of the item type is coerced, so an
    // int list (main_catchup.pull_retry_delays_seconds) validates as numbers.
    const item = schemaLeaf.__item;
    if (item && [TYPE_BOOL, TYPE_INT, TYPE_FLOAT].includes(item.__type)) {
      return parts.map((part, index) => coerceEnvValue(`${key}[${index}]`, part, item, source));
    }
    return parts;
  }
  return value;
}

function schemaLeaf(schema, key) {
  const parts = key.split('.');
  let cursor = schema;
  for (const part of parts) {
    if (cursor.__type !== TYPE_DICT) return null;
    const keys = cursor.__keys || {};
    if (Object.prototype.hasOwnProperty.call(keys, part)) {
      cursor = keys[part];
      continue;
    }
    if (cursor.__strict === false && cursor.__extra_keys_schema) {
      cursor = cursor.__extra_keys_schema;
      continue;
    }
    return null;
  }
  return cursor;
}

function* flattenSchemaLeaves(doc, schema, path = []) {
  // A layer replaces a provider's complete declaration, even with {}.
  // Operation IDs may contain dots and must never become provenance paths.
  if (SEARCH_LIMIT_PATHS.has(path.join('.'))) {
    yield { dotted: path.join('.'), path, value: doc };
    return;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    yield { dotted: path.join('.'), path, value: doc };
    return;
  }
  if (!schema || schema.__type !== TYPE_DICT) {
    yield { dotted: path.join('.'), path, value: doc };
    return;
  }
  if (schema.__strict === false && schema.__extra_keys_schema) {
    for (const [key, value] of Object.entries(doc)) {
      if (key.startsWith('__')) continue;
      yield* flattenSchemaLeaves(value, schema.__extra_keys_schema, [...path, key]);
    }
    return;
  }
  const keys = schema.__keys || {};
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith('__')) continue;
    yield* flattenSchemaLeaves(value, keys[key], [...path, key]);
  }
}

function schemaAliasTarget(schema, key) {
  return schemaLeaf(schema, key)?.__alias_of || key;
}

function* canonicalSchemaLeaves(doc, schema, source) {
  const leaves = new Map();
  for (const entry of flattenSchemaLeaves(doc, schema)) {
    const target = schemaAliasTarget(schema, entry.dotted);
    const prior = leaves.get(target);
    if (prior && !sameValue(prior.value, entry.value)) {
      throw new AgentOSConfigError(
        `${source}: schema alias conflict — ${prior.dotted} and ${entry.dotted}; set one only`,
        { key: target, source, expected: 'matching values across aliased schema keys' },
      );
    }
    leaves.set(target, { ...entry, path: target === entry.dotted ? entry.path : target.split('.') });
  }
  for (const [dotted, entry] of leaves) yield { ...entry, dotted };
}

const APP_ENV_SUFFIXES = {
  MODE: 'mode',
  SUBSCRIBES: 'subscribes',
  CONTRACT_VERSION: 'contract_version',
};

function appIdFromEnvSegment(segment) {
  return segment.toLowerCase().replaceAll('_', '-');
}

function dynamicAppEnvAliases(env) {
  const out = [];
  const prefix = 'AGENT_OS_APPS_';
  for (const envName of Object.keys(env).sort()) {
    if (!envName.startsWith(prefix)) continue;
    const tail = envName.slice(prefix.length);
    for (const [suffix, leaf] of Object.entries(APP_ENV_SUFFIXES)) {
      const marker = `_${suffix}`;
      if (tail.endsWith(marker) && tail.slice(0, -marker.length)) {
        const appId = appIdFromEnvSegment(tail.slice(0, -marker.length));
        const key = `apps.${appId}.${leaf}`;
        out.push([
          key,
          {
            canonical: envName,
            aliases: [],
            appId,
            writePath: ['apps', appId, leaf],
          },
        ]);
        break;
      }
    }
  }
  return out;
}

// App ids mentioned by `AGENT_OS_APPS_*` env aliases. The caller compares this
// set against the already-merged file/local app ids to find entries materialized
// purely by env and tag their backfilled defaults distinctly.
function dynamicAppEnvIds(env) {
  const ids = new Set();
  for (const [, info] of dynamicAppEnvAliases(env)) {
    if (info.appId) ids.add(info.appId);
  }
  return ids;
}

function ownMapEntryIds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Set();
  return new Set(Object.keys(value));
}

// Yields [parentPath, extraSchema] for every non-strict dict that declares an
// `__extra_keys_schema` (the keyed-map extension points, e.g. `apps.<id>`).
// Mirrors the Python `_iter_extra_key_dict_schemas`.
function* iterExtraKeyDictSchemas(schema, prefix = '') {
  if (!schema || schema.__type !== TYPE_DICT) return;
  const extraSchema = schema.__extra_keys_schema;
  if (
    schema.__strict === false &&
    extraSchema &&
    extraSchema.__type === TYPE_DICT
  ) {
    yield [prefix, extraSchema];
  }
  for (const [key, child] of Object.entries(schema.__keys || {})) {
    if (!child || child.__type !== TYPE_DICT) continue;
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    yield* iterExtraKeyDictSchemas(child, childPrefix);
  }
}

const ENV_REGISTERED_APP_DEFAULT_SOURCE = 'code-default (env-registered app)';

function setEntryDefault(entryValue, leaf, value) {
  const parts = leaf.split('.');
  setLeafPath(entryValue, parts, value, { dottedKey: leaf, rejectUnsafeSegments: true });
}

function entryHasLeaf(entryValue, leaf) {
  const parts = leaf.split('.');
  let cursor = entryValue;
  for (const part of parts) {
    if (UNSAFE_PATH_SEGMENTS.has(part)) return false;
    if (
      !cursor ||
      typeof cursor !== 'object' ||
      !Object.prototype.hasOwnProperty.call(cursor, part)
    ) {
      return false;
    }
    cursor = cursor[part];
  }
  return true;
}

// Backfill schema defaults into keyed-map entries that were materialized
// without going through `validateDictPresentKeysOnly` — chiefly entries
// introduced purely via env aliases (e.g. `AGENT_OS_APPS_FOO_MODE`), which
// `setLeaf` writes as `{ mode }` with no defaults for the sibling fields.
// Without this, an env-only app and a YAML-declared app with the same intent
// produce structurally different records (the env one missing `subscribes`/
// `contract_version`), crashing consumers that iterate `apps.<id>.subscribes`.
// Mirrors the Python loader's `_backfill_extra_key_entry_defaults`.
function backfillExtraKeyEntryDefaults(merged, schema, dynamicAppIds, trace) {
  for (const [parentPath, extraSchema] of iterExtraKeyDictSchemas(schema)) {
    const parentValue = getLeaf(merged, parentPath);
    if (
      parentValue === MISSING ||
      !parentValue ||
      typeof parentValue !== 'object' ||
      Array.isArray(parentValue)
    ) {
      continue;
    }
    const entryDefaults = flatten(buildDefaultsDict(extraSchema));
    if (Object.keys(entryDefaults).length === 0) continue;
    for (const entryId of Object.keys(parentValue).sort()) {
      const entryValue = parentValue[entryId];
      if (
        !entryValue ||
        typeof entryValue !== 'object' ||
        Array.isArray(entryValue)
      ) {
        continue;
      }
      for (const [leaf, defaultValue] of Object.entries(entryDefaults)) {
        if (entryHasLeaf(entryValue, leaf)) continue;
        const value = structuredClone(defaultValue);
        setEntryDefault(entryValue, leaf, value);
        const source =
          parentPath === 'apps' && dynamicAppIds.has(entryId)
            ? ENV_REGISTERED_APP_DEFAULT_SOURCE
            : 'code-default';
        const dotted = `${parentPath}.${entryId}.${leaf}`;
        (trace[dotted] = trace[dotted] || []).push({ source, value, path: null });
      }
    }
  }
}

function validateGoalLineageConfig(merged, trace) {
  const maxKey = 'worker_pool.dispatch.goal_lineage.max_bytes';
  const excerptKey = 'worker_pool.dispatch.goal_lineage.spec_excerpt_bytes';
  const maxBytes = getLeaf(merged, maxKey);
  const specExcerptBytes = getLeaf(merged, excerptKey);
  if (maxBytes === MISSING || specExcerptBytes === MISSING) return;
  if (Number(specExcerptBytes) <= Number(maxBytes)) return;
  const entries = trace[excerptKey] || [];
  const source = entries.length ? entries[entries.length - 1].source : 'merged-config';
  throw new AgentOSConfigError(
    `${excerptKey}: expected <= ${maxKey} (${maxBytes}), got ${specExcerptBytes}`,
    {
      key: excerptKey,
      expected: `<= ${maxKey} (${maxBytes})`,
      got: specExcerptBytes,
      source,
    },
  );
}

// GRK-09: a role pin may name a Grok lane only while that lane is enabled.
// Lane enablement mirrors _validate_grok_role_pins in the Python loader.
// GRK-12's pending-v2 closer refusal also requires the Agent OS companion
// loader/fixture update before deployment (docs/changes/GRK-12.md).
function validateGrokRolePins(merged, trace) {
  for (const key of ['roles.merge_agent_worker_class',
    'roles.adversarial.merge_authority.worker_class',
    'roles.adversarial.merge_authority.worker_class_fallback']) {
    const value = getLeaf(merged, key);
    if ((Array.isArray(value) ? value : [value]).some(pin => String(pin ?? '').trim() === 'hammer-grok')) {
      throw new AgentOSConfigError(`${key}: grok-closer-pending-merge-authority-v2`, {
        key, expected: 'Merge Authority v2 executor', got: value, source: 'merged-config',
      });
    }
  }
  const [violation] = grokRolePinViolations(merged);
  if (!violation) return;
  const { key, value, required } = violation;
  const entries = trace[key] || [];
  const source = entries.length ? entries[entries.length - 1].source : 'merged-config';
  throw new AgentOSConfigError(
    `${key}: ${JSON.stringify(value)} selects a disabled Grok lane; set ${required}: true `
      + 'to make it dispatchable, or choose another value',
    { key, expected: `${required}: true`, got: value, source },
  );
}

function enforceCiHostingSecurityInvariants(merged, trace) {
  const excluded = getLeaf(merged, 'ci.hosting.excluded_workflows');
  if (!Array.isArray(excluded)) return;
  const normalized = [
    ...MANDATORY_CI_HOSTING_EXCLUDED_WORKFLOWS,
    ...excluded.filter(
      (workflow) => !MANDATORY_CI_HOSTING_EXCLUDED_WORKFLOWS.includes(workflow),
    ),
  ];
  if (
    normalized.length === excluded.length &&
    normalized.every((workflow, index) => workflow === excluded[index])
  ) return;
  setLeaf(merged, 'ci.hosting.excluded_workflows', normalized);
  const key = 'ci.hosting.excluded_workflows';
  (trace[key] = trace[key] || []).push({
    source: 'security-invariant',
    value: normalized,
    path: null,
  });
}

// True iff `key` is a path the schema accepts. Walks like schemaLeaf, but
// also accepts paths that descend into a non-strict dict (extension point,
// e.g. `submodules.X.Y`) where no further leaf is declared. Used by
// __aliases validation so canonical-key typos fail loud while legitimate
// pass-through targets are allowed.
function isValidSchemaPath(schema, key) {
  const parts = key.split('.');
  let cursor = schema;
  for (let i = 0; i < parts.length; i++) {
    if (!cursor || cursor.__type !== TYPE_DICT) return false;
    const keys = cursor.__keys || {};
    const part = parts[i];
    if (!Object.prototype.hasOwnProperty.call(keys, part)) {
      if (cursor.__strict === false && cursor.__extra_keys_schema) {
        cursor = cursor.__extra_keys_schema;
        continue;
      }
      return cursor.__strict === false;
    }
    cursor = keys[part];
  }
  return cursor !== null && cursor !== undefined;
}

// -------- File reading helpers ---------------------------------------------

function loadLayerFile(path) {
  if (!existsSync(path)) return { doc: null, rawText: '' };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new AgentOSConfigError(
      `could not read ${path}: ${err.message || err}`,
      { source: path },
    );
  }
  const doc = parseYaml(text, path);
  return { doc, rawText: text };
}

// Returns the Layer-4 sibling path for `path`, or null if `path` doesn't end
// in `.yaml`/`.yml`. Non-YAML extensions (e.g. operator points
// AGENT_OS_CONFIG_PATH at `/etc/agent-os/config` or `…/config.conf`) used to
// silently fall back to `${name}.local`, producing oddly-named siblings that
// the YAML parser would happily try to load. Refusing makes the rule legible:
// pick a `.yaml` / `.yml` path or the loader doesn't synthesize a sibling.
function localSibling(path) {
  const dir = dirname(path);
  const name = basename(path);
  if (name.endsWith('.yaml')) {
    return join(dir, `${name.slice(0, -'.yaml'.length)}.local.yaml`);
  }
  if (name.endsWith('.yml')) {
    return join(dir, `${name.slice(0, -'.yml'.length)}.local.yml`);
  }
  return null;
}

// PROFILENODE-01: profile overlay. Mirrors the platform loaders' ANY-02
// contract. Resolution order: explicit `profile:` key, env AGENT_OS_PROFILE,
// `reference-host` when the overlay file exists next to the top file, else
// `core`. Only the `reference-host` profile has an overlay file.
export const PROFILE_ENV = 'AGENT_OS_PROFILE';
export const DEFAULT_PROFILE = 'core';
export const OVERLAY_PROFILE = 'reference-host';

// `<stem>.profile.<profile>.yaml` beside the top file (`config.yaml` ->
// `config.profile.reference-host.yaml`); null for non-YAML top paths, like
// localSibling.
function profileOverlaySibling(path, profile = OVERLAY_PROFILE) {
  const dir = dirname(path);
  const name = basename(path);
  if (name.endsWith('.yaml')) {
    return join(dir, `${name.slice(0, -'.yaml'.length)}.profile.${profile}.yaml`);
  }
  if (name.endsWith('.yml')) {
    return join(dir, `${name.slice(0, -'.yml'.length)}.profile.${profile}.yml`);
  }
  return null;
}

function nonBlankString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function resolveProfile({ explicit, env, overlayExists }) {
  const fromKey = nonBlankString(explicit);
  if (fromKey) return { profile: fromKey, source: 'explicit' };
  const fromEnv = nonBlankString(env?.[PROFILE_ENV]);
  if (fromEnv) return { profile: fromEnv, source: 'env' };
  if (overlayExists) return { profile: OVERLAY_PROFILE, source: 'overlay-present' };
  return { profile: DEFAULT_PROFILE, source: 'default' };
}

// -------- AgentOSConfig (public class) -------------------------------------

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

export function loadConfig({
  topPath = null,
  modulePaths = [],
  env = null,
  cliOverrides = null,
} = {}) {
  return loadConfigImpl({
    topPath,
    modulePaths,
    env,
    cliOverrides,
    tolerateCheckedInUnknown: false,
  });
}

export function loadConfigRuntime({
  topPath = null,
  modulePaths = [],
  env = null,
  cliOverrides = null,
} = {}) {
  return loadConfigImpl({
    topPath,
    modulePaths,
    env,
    cliOverrides,
    tolerateCheckedInUnknown: true,
  });
}

// Worker proposal projection only: an undeclared identity has no pool contract
// to validate. Global/startup readers retain strict declaration validation.
export function loadConfigForIdentityTokenPool({ identity, ...options } = {}) {
  return loadConfigImpl({ ...options, tokenPoolIdentity: identity });
}

function loadConfigImpl({
  topPath = null,
  modulePaths = [],
  env = null,
  cliOverrides = null,
  tolerateCheckedInUnknown = false,
  tokenPoolIdentity,
  legacyGeminiReviewer = false,
} = {}) {
  const envView = env || process.env;
  // Compose's ${VAR:-} forwards an absent setting as "": absent for every
  // leaf type and alias form, as in Python. envView keeps loader controls.
  const envOverrides = Object.fromEntries(Object.entries(envView).filter(([, value]) => value !== ''));
  checkDeprecatedEnvVars(envOverrides);
  const schema = schemaV1();

  const defaults = buildDefaultsDict(schema);
  const merged = {};
  const trace = {};
  const runtimeDroppedUnknownKeys = [];
  for (const [dotted, value] of Object.entries(flatten(defaults))) {
    setLeaf(merged, dotted, value);
    (trace[dotted] = trace[dotted] || []).push({
      source: 'code-default',
      value,
      path: null,
    });
  }
  // flatten() intentionally omits empty dictionaries. These new override maps
  // have an observable empty-map default, so retain it in the resolved config.
  for (const dotted of [
    'oauth.broker_instances',
    'oauth.token_accounts',
    'oauth.identity_token_pools',
    'worker_pool.dispatch.codex_exec_timeout_by_worker_class',
    'worker_pool.dispatch.codex_exec_stall_timeout_by_worker_class',
    'worker_pool.public_hygiene.identities',
  ]) {
    setLeaf(merged, dotted, {});
    (trace[dotted] = trace[dotted] || []).push({
      source: 'code-default', value: {}, path: null,
    });
  }

  // --- Layer 2: module files ---
  const moduleAliases = {};
  for (const rawPath of modulePaths) {
    const { doc, rawText } = loadLayerFile(rawPath);
    if (doc === null || doc === undefined) continue;
    const { validated, aliases } = validateModuleDoc(doc, rawPath, rawText, {
      tolerateUnknown: tolerateCheckedInUnknown,
      warnUnknownOnce: tolerateCheckedInUnknown,
      droppedUnknownKeys: runtimeDroppedUnknownKeys,
    });
    for (const [moduleKey, canonicalKey] of Object.entries(aliases)) {
      const prior = moduleAliases[moduleKey];
      if (prior && prior !== canonicalKey) {
        throw new AgentOSConfigError(
          `${rawPath}: __aliases conflict — '${moduleKey}' aliases to both '${prior}' and '${canonicalKey}'`,
          { source: rawPath },
        );
      }
      moduleAliases[moduleKey] = canonicalKey;
    }
    for (const { dotted, path, value } of canonicalSchemaLeaves(validated, schema, rawPath)) {
      setLeafPath(merged, path, value);
      (trace[dotted] = trace[dotted] || []).push({
        source: `module:${rawPath}`,
        value,
        path: rawPath,
      });
    }
  }

  // --- Layer 3: top-level file ---
  const topPathResolved =
    topPath || envView.AGENT_OS_CONFIG_PATH || DEFAULT_TOP_LEVEL_PATH;
  const { doc: topDoc, rawText: topRaw } = loadLayerFile(topPathResolved);
  if (topDoc !== null && topDoc !== undefined && !isEmptyDoc(topDoc)) {
    const validated = validateSchemaLayer(topDoc, {
      source: topPathResolved,
      rawText: topRaw,
      tolerateUnknown: tolerateCheckedInUnknown,
      warnUnknownOnce: tolerateCheckedInUnknown,
      droppedUnknownKeys: runtimeDroppedUnknownKeys,
    });
    for (const { dotted, path, value } of canonicalSchemaLeaves(validated, schema, topPathResolved)) {
      if (dotted === 'version') continue;
      setLeafPath(merged, path, value);
      (trace[dotted] = trace[dotted] || []).push({
        source: 'top',
        value,
        path: topPathResolved,
      });
    }
  }

  // --- Layer 3.5 / 4: profile overlay, then *.local.yaml siblings ---
  // localSibling returns null for non-yaml/yml top paths; we skip Layer 4
  // entirely for those rather than synthesize a `${name}.local` sibling.
  const topLocal = localSibling(topPathResolved);
  const layerDocs = new Map();
  const readLayer = (path) => {
    if (!layerDocs.has(path)) layerDocs.set(path, loadLayerFile(path));
    return layerDocs.get(path);
  };
  const topLocalPresent = Boolean(topLocal && existsSync(topLocal));

  // PROFILENODE-01: profile resolution. The explicit `profile:` key follows
  // normal layering (top, then the top-level local sibling wins). The overlay
  // itself cannot select its own profile.
  const explicitProfileOf = (doc) =>
    doc && typeof doc === 'object' && !Array.isArray(doc) ? doc.profile : undefined;
  const explicitProfile = nonBlankString(
    topLocalPresent ? explicitProfileOf(readLayer(topLocal).doc) : undefined,
  ) ?? nonBlankString(explicitProfileOf(topDoc));
  const overlayPath = profileOverlaySibling(topPathResolved);
  const overlayExists = Boolean(overlayPath && existsSync(overlayPath));
  const { profile, source: profileSource } = resolveProfile({
    explicit: explicitProfile,
    env: envView,
    overlayExists,
  });

  const layerSources = [];
  if (profile === OVERLAY_PROFILE && overlayExists) {
    layerSources.push({ path: overlayPath, kind: 'profile', label: `profile:${overlayPath}` });
  }
  if (topLocalPresent) layerSources.push({ path: topLocal, kind: 'top', label: `local:${topLocal}` });
  for (const rawPath of modulePaths) {
    const moduleLocal = localSibling(rawPath);
    if (moduleLocal && existsSync(moduleLocal)) {
      layerSources.push({ path: moduleLocal, kind: 'module', label: `local:${moduleLocal}` });
    }
  }
  for (const { path: local, label } of layerSources) {
    const { doc: localDoc, rawText: localRaw } = readLayer(local);
    if (localDoc === null || localDoc === undefined || isEmptyDoc(localDoc)) continue;
    let validatedLocal;
    if (
      localDoc &&
      typeof localDoc === 'object' &&
      !Array.isArray(localDoc) &&
      'version' in localDoc
    ) {
      validatedLocal = validateSchemaLayer(localDoc, {
        source: local,
        rawText: localRaw,
        tolerateUnknown: true,
      });
    } else {
      const { validated, aliases } = validateModuleDoc(localDoc, local, localRaw, {
        tolerateUnknown: true,
        preserveEmptyMaps: true,
      });
      validatedLocal = validated;
      for (const [moduleKey, canonicalKey] of Object.entries(aliases)) {
        if (!(moduleKey in moduleAliases)) moduleAliases[moduleKey] = canonicalKey;
      }
    }
    for (const { dotted, path, value } of canonicalSchemaLeaves(validatedLocal, schema, local)) {
      if (dotted === 'version') continue;
      setLeafPath(merged, path, value);
      (trace[dotted] = trace[dotted] || []).push({
        source: label,
        value,
        path: local,
      });
    }
  }

  // --- Layer 5: env vars ---
  const appIdsBeforeEnv = ownMapEntryIds(getLeaf(merged, 'apps'));
  const dynamicAppIds = dynamicAppEnvIds(envOverrides);
  const envAliasEntries = [
    ...Object.entries(ENV_ALIASES),
    ...dynamicAppEnvAliases(envOverrides),
  ];
  for (const [key, info] of envAliasEntries) {
    const leaf = schemaLeaf(schema, key);
    if (leaf === null) continue;
    const [winning, rawValue] = checkEnvOverlap(
      key,
      info.canonical,
      info.aliases,
      envOverrides,
    );
    if (winning === null) continue;
    let value;
    if (typeof rawValue === 'string') {
      value = coerceEnvValue(key, rawValue, leaf, `env:${winning}`);
    } else {
      value = rawValue;
    }
    value = checkLeaf(value, leaf, key, `env:${winning}`);
    const target = schemaAliasTarget(schema, key);
    if (info.writePath) {
      setLeafPath(merged, info.writePath, value, { dottedKey: target });
    } else {
      setLeaf(merged, target, value);
    }
    (trace[target] = trace[target] || []).push({
      source: `env:${winning}`,
      value,
      path: null,
    });
  }

  // --- Layer 6: CLI overrides ---
  if (cliOverrides) {
    for (const [key, value] of Object.entries(cliOverrides)) {
      const leaf = schemaLeaf(schema, key);
      if (leaf === null) {
        throw new AgentOSConfigError(
          `cli override key ${JSON.stringify(key)} is not in the schema`,
          { key, expected: 'known schema key', got: key },
        );
      }
      const checked = checkLeaf(value, leaf, key, 'cli');
      const target = schemaAliasTarget(schema, key);
      setLeaf(merged, target, checked);
      (trace[target] = trace[target] || []).push({
        source: 'cli',
        value: checked,
        path: null,
      });
    }
  }

  const envMaterializedAppIds = new Set(
    [...dynamicAppIds].filter((appId) => !appIdsBeforeEnv.has(appId)),
  );

  // Backfill defaults into keyed-map entries (e.g. env-only `apps.<id>`) so
  // env- and YAML-declared entries converge on the same defaulted shape.
  backfillExtraKeyEntryDefaults(merged, schema, envMaterializedAppIds, trace);

  enforceCiHostingSecurityInvariants(merged, trace);
  validateGoalLineageConfig(merged, trace);
  validateGrokRolePins(merged, trace);
  const pools = merged.oauth?.identity_token_pools;
  if (tokenPoolIdentity !== undefined && pools !== null && typeof pools === 'object'
    && !Array.isArray(pools) && !Object.hasOwn(pools, tokenPoolIdentity)) return null;
  // A reviewer without its own pool still uses legacy holders. Unrelated
  // pool errors must not break its runtime/model/holder config reads. Keep
  // malformed mappings and every declared reviewer pool fully validated.
  const undeclaredGemini = pools && typeof pools === 'object' && !Array.isArray(pools)
    && !Object.hasOwn(pools, 'gemini-reviewer');
  if (!legacyGeminiReviewer || !undeclaredGemini) validateOAuthDeclarations(merged.oauth, trace);
  validateOsgShape(merged.osg);
  validateSearch(merged.services?.hcp?.search);
  validatePublicHygiene(merged.worker_pool?.public_hygiene);
  validateWorkerClassVaults(merged.worker_pool?.secrets);

  const sources = {};
  for (const [key, entries] of Object.entries(trace)) {
    sources[key] = entries[entries.length - 1].source;
  }

  return new AgentOSConfig({
    values: merged,
    trace,
    sources,
    schema,
    runtimeDroppedUnknownKeys,
    profile,
    profileSource,
  });
}

function validateOsgShape(value, source = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentOSConfigError('osg: expected mapping', { key: 'osg', source });
  }
  for (const key of ['policy', 'double_blind', 'router']) {
    if (Object.hasOwn(value, key) && (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key]))) {
      throw new AgentOSConfigError(`osg.${key}: expected mapping`, { key: `osg.${key}`, source });
    }
  }
  if (Array.isArray(value.arms)) {
    const fields = Object.keys(osgArmFields());
    for (const arm of value.arms) {
      if (!arm || fields.some(key => !Object.hasOwn(arm, key))) {
        throw new AgentOSConfigError('osg.arms: incomplete arm', { key: 'osg.arms', source });
      }
    }
  }
}

function validateOAuthDeclarations(oauth, trace = null, source = null) {
  try {
    validateTokenPoolDeclarations(oauth);
  } catch (error) {
    // Never copy trace values: descriptors and bindings must remain redacted.
    const declarationSources = Object.fromEntries([...TOKEN_POOL_DECLARATION_PATHS].map(key => {
      const winner = trace?.[key]?.at(-1);
      return [key, { source: winner?.source ?? source, path: winner?.path ?? source }];
    }));
    const key = error.message.split(':', 1)[0];
    const mapKey = [...TOKEN_POOL_DECLARATION_PATHS].find(path => key === path || key.startsWith(`${path}.`));
    const winner = declarationSources[mapKey];
    const origins = Object.entries(declarationSources)
      .filter(([, origin]) => origin.path || origin.source)
      .map(([path, origin]) => `${path} from ${origin.path || origin.source}`);
    const wrapped = new AgentOSConfigError(
      `${error.message}${origins.length ? ` (${origins.join('; ')})` : ''}`,
      { key, expected: 'valid token pool declaration', source: winner?.path || winner?.source },
    );
    wrapped.declarationSources = declarationSources;
    throw wrapped;
  }
}

function isEmptyDoc(doc) {
  if (doc === null || doc === undefined) return true;
  if (typeof doc !== 'object') return false;
  if (Array.isArray(doc)) return false;
  return Object.keys(doc).length === 0;
}

// -------- Convenience wrapper ----------------------------------------------

// `getConfig` and `loadConfigCached` share a per-call-shape cache that
// invalidates when ANY watched file's mtime / inode changes. "Watched" =
// the top-level path + its `*.local.yaml` sibling + each module path in
// the call + each module's `*.local.yaml` sibling + the profile overlay
// + the resolved public-hygiene denylist, when configured.
//
// Env-var rotations are part of the cache key for declared CFG aliases
// (canonical + legacy names in ENV_ALIASES), so per-call env overlays
// cannot reuse a config object resolved under a different env value.
// Callers should still call `resetConfigCache()` (or
// `resetRoleConfigCache()` from `role-config.mjs`) at their per-tick /
// per-job boundary so removed env vars and unrelated process-global
// changes cannot bleed across long-lived loops.
//
// Cache structure: a Map keyed by
// JSON({resolvedTopPath, modulePaths, envAliases}),
// each entry holding the resolved AgentOSConfig + the file signature it
// was loaded under. The cache key ALWAYS uses the env-resolved top
// (`topPath || env.AGENT_OS_CONFIG_PATH || DEFAULT_TOP_LEVEL_PATH`) so
// two callers with the same call shape but different
// `env.AGENT_OS_CONFIG_PATH` get distinct slots — without that, the
// signature half (which already resolves via env) and the key half
// (which previously didn't) would ping-pong, defeating the cache.
//
// Capacity: the cache is LRU-capped at `_CACHE_MAX_SLOTS` so a process
// that repeatedly creates one-shot call shapes (e.g. a test suite that
// mkdtemps a new `modulePaths` per case) cannot grow it unboundedly.
// Production callers (watcher per-tick, follow-up consumer per-job)
// reset at their boundary so the cap is invisible in practice; it only
// fires in long-running test processes and pathological misuse.
//
// Cost note: every `loadConfigCached` / `getConfig` call re-stats the
// watched files even on cache hits — net win vs.
// a full YAML parse, but not free. Don't call in tight inner loops
// outside the documented per-tick / per-job hot paths.
const _CACHE_MAX_SLOTS = 16;
const _SIGNATURE_HASH_TTL_MS = 1000;
const _configCache = new Map();
const _configSignatures = new Map();
const _signatureFileCache = new Map();

function _watchedPathsForCall({ topPath, modulePaths, env, cachedConfig }) {
  const envView = env || process.env;
  const resolvedTop = topPath || envView.AGENT_OS_CONFIG_PATH || DEFAULT_TOP_LEVEL_PATH;
  const watched = [resolvedTop];
  // PROFILENODE-01: the overlay is read between the top file and its local
  // sibling, so edits to it must invalidate cached loads.
  const topOverlay = profileOverlaySibling(resolvedTop);
  if (topOverlay) watched.push(topOverlay);
  const topLocal = localSibling(resolvedTop);
  if (topLocal) watched.push(topLocal);
  for (const modulePath of modulePaths || []) {
    watched.push(modulePath);
    const moduleLocal = localSibling(modulePath);
    if (moduleLocal) watched.push(moduleLocal);
  }
  // Resolve dependencies from the validated cascade, including local/module
  // overrides. The shared signature digest cache keeps hot reads at stat-cost.
  const denylistPath = cachedConfig?.get('worker_pool.public_hygiene.denylist_path');
  if (denylistPath) watched.push(denylistPath);
  return watched;
}

function _statIdentity(st) {
  return `${st.mtimeMs}|${st.ino}|${st.size}|${st.ctimeMs}`;
}

function _contentDigestForPath(path, st, { forceHash = false, nowMs = Date.now() } = {}) {
  const identity = _statIdentity(st);
  const cached = _signatureFileCache.get(path);
  const cacheFresh =
    cached
    && cached.identity === identity
    && Number.isFinite(cached.hashedAtMs)
    && nowMs - cached.hashedAtMs < _SIGNATURE_HASH_TTL_MS;
  if (!forceHash && cacheFresh) return cached.digest;

  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  _signatureFileCache.set(path, { identity, digest, hashedAtMs: nowMs });
  return digest;
}

function _currentSignature({ topPath, modulePaths, env, cachedConfig }, options = {}) {
  return _signatureForPaths(_watchedPathsForCall({ topPath, modulePaths, env, cachedConfig }), options);
}

function _signatureForPaths(watched, options = {}) {
  const parts = [];
  for (const path of watched) {
    try {
      const st = statSync(path);
      // CFGSTALE-01: metadata alone is not a content identity. Restore tools
      // can write in place and restore the original timestamps, leaving both
      // inode and mtime unchanged while the bytes differ. Hash the bytes so a
      // long-lived daemon cannot retain the pre-restore config indefinitely.
      // Cache hits reuse that digest until metadata changes or this short TTL
      // expires, keeping ordinary config reads at stat-cost.
      const digest = _contentDigestForPath(path, st, options);
      parts.push(`${path}|${st.mtimeMs}|${st.ino}|${st.size}|${st.ctimeMs}|${digest}`);
    } catch {
      _signatureFileCache.delete(path);
      parts.push(`${path}|null|null|null|null|null`);
    }
  }
  return parts.join('::');
}

function _cacheKeyFor({ topPath, modulePaths, env, legacyGeminiReviewer = false }) {
  // Fold the env-resolved top into the cache key so two callers with
  // the same explicit call shape but different `env.AGENT_OS_CONFIG_PATH`
  // get distinct slots (matches the signature's view of which file is
  // actually being read). Without this, the signature would invalidate
  // the slot on every env switch and the cache would never hit.
  const envView = env || process.env;
  const resolvedTop = topPath || envView.AGENT_OS_CONFIG_PATH || DEFAULT_TOP_LEVEL_PATH;
  const envAliases = [];
  const envAliasInfos = [
    ...Object.values(ENV_ALIASES),
    ...dynamicAppEnvAliases(envView).map(([, info]) => info),
  ];
  for (const info of envAliasInfos) {
    const names = [info.canonical, ...(info.aliases || []).map(([name]) => name)];
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(envView, name)) {
        envAliases.push([name, envView[name]]);
      }
    }
  }
  // PROFILENODE-01: AGENT_OS_PROFILE selects the profile, so it is part of the
  // slot identity like the declared env aliases. Key on the value
  // resolveProfile actually reads (trimmed, blank = unset) so a blank or
  // padded value shares the slot of the profile it resolves to.
  const envProfile = nonBlankString(envView[PROFILE_ENV]);
  if (envProfile) {
    envAliases.push([PROFILE_ENV, envProfile]);
  }
  envAliases.sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    resolvedTopPath: resolvedTop,
    modulePaths: [...(modulePaths || [])],
    envAliases,
    legacyGeminiReviewer,
  });
}

function _touchCacheLru(cacheKey) {
  // Map iteration order is insertion order; re-setting moves the entry
  // to the most-recent position. Cheap O(1) LRU touch.
  if (!_configCache.has(cacheKey)) return;
  const value = _configCache.get(cacheKey);
  const sig = _configSignatures.get(cacheKey);
  _configCache.delete(cacheKey);
  _configSignatures.delete(cacheKey);
  _configCache.set(cacheKey, value);
  _configSignatures.set(cacheKey, sig);
}

function _evictCacheLruIfNeeded() {
  while (_configCache.size > _CACHE_MAX_SLOTS) {
    const oldestKey = _configCache.keys().next().value;
    if (oldestKey === undefined) break;
    _configCache.delete(oldestKey);
    _configSignatures.delete(oldestKey);
  }
}

function _ensureFreshConfig({ topPath, modulePaths, env, legacyGeminiReviewer = false } = {}) {
  const cacheKey = _cacheKeyFor({ topPath, modulePaths, env, legacyGeminiReviewer });
  const cached = _configCache.get(cacheKey);
  // Retain the pre-load YAML signature: an edit during parsing must trigger
  // another load, not stamp old values with the edited file's signature.
  const inputSignature = _currentSignature({ topPath, modulePaths, env });
  const signatureForConfig = config => {
    const path = config?.get('worker_pool.public_hygiene.denylist_path');
    return path ? `${inputSignature}::${_signatureForPaths([path])}` : inputSignature;
  };
  const sig = signatureForConfig(cached);
  if (cached === undefined || _configSignatures.get(cacheKey) !== sig) {
    // Runtime-tolerant load: daemons must not crash when ANOTHER module adds
    // a key to the shared top-level config.yaml (2026-07-17 watcher outage:
    // main_catchup.pg_schema_gate_allow_destructive_revisions landed via the
    // parent repo and every cached load — watcher, role-config, getConfig —
    // fail-louded at startup for ~1h). Startup and cached runtime readers now
    // share unknown-key scoping; supported values and consumed atomic policies
    // retain strict validation. Runtime additionally records dropped paths.
    const fresh = loadConfigImpl({ topPath, modulePaths, env, tolerateCheckedInUnknown: true, legacyGeminiReviewer });
    _configCache.set(cacheKey, fresh);
    _configSignatures.set(cacheKey, signatureForConfig(fresh));
    _evictCacheLruIfNeeded();
    return fresh;
  }
  _touchCacheLru(cacheKey);
  return cached;
}

// loadConfigCached — public cached entry point for callers that pass
// non-default {topPath, modulePaths, env} (the role-config cascade is
// the principal consumer). Slots are keyed by (env-resolved topPath +
// modulePaths) and capped LRU at `_CACHE_MAX_SLOTS`; reset via
// `resetConfigCache()` or the role-scoped `resetRoleConfigCache()`
// re-export in `role-config.mjs`.
export function loadConfigCached({ topPath, modulePaths, env } = {}) {
  return _ensureFreshConfig({ topPath, modulePaths, env });
}

// Separate cache slots prevent this legacy-only view from weakening ordinary
// config readers. This is solely for Antigravity reviewer holder admission.
export function loadGeminiReviewerConfigCached({ topPath, modulePaths, env } = {}) {
  return _ensureFreshConfig({ topPath, modulePaths, env, legacyGeminiReviewer: true });
}

export function getConfig(key, defaultValue = null) {
  return _ensureFreshConfig().get(key, defaultValue);
}

export function resolutionTrace(key) {
  return _ensureFreshConfig().resolutionTrace(key);
}

export function resetConfigCache() {
  _configCache.clear();
  _configSignatures.clear();
  _signatureFileCache.clear();
}

export function configSignatureStatus({ topPath, modulePaths, env } = {}) {
  const cacheKey = _cacheKeyFor({ topPath, modulePaths, env });
  const diskSignature = _currentSignature(
    { topPath, modulePaths, env, cachedConfig: _configCache.get(cacheKey) },
    { forceHash: true }
  );
  const loadedSignature = _configSignatures.get(cacheKey) ?? null;
  return {
    algorithm: 'sha256',
    loadedSignature,
    diskSignature,
    inSync: loadedSignature === null ? null : loadedSignature === diskSignature,
  };
}
