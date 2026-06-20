// agent-os-config — Node loader for the cross-language config surface (CFG).
//
// Behavior contract: ../../../projects/cfg/LOADER-CONTRACT.md in the
// agent-os repo is the canonical source for what this loader (and the Python
// sibling at `platform/agent-os-config/src/agent_os_config/__init__.py`) must
// do. The conformance suite in `test/config-loader.test.mjs` exercises the
// same fixture cases as the Python `tests/test_loader.py`.
//
// This file aims for behavior-equivalence with the Python sibling, NOT
// byte-equivalence. Deliberate divergences from the current Python sibling
// (each one strictly tightens the contract; tracked for alignment in the
// agent-os PR landing the Python helper):
//   1. Explicit `~` / null on non-nullable keys: this loader fails the
//      schema; the Python sibling reverts to defaults.
//   2. Same-file alias conflict: this loader compares the canonical-target
//      values with deep structural equality (isDeepStrictEqual); the Python
//      sibling uses identity. Trivially-deep-equal dicts merge cleanly here.
//   3. localSibling for non-`.yaml`/`.yml` top-level paths: this loader
//      refuses to compute a sibling and skips Layer 4 for that file; the
//      Python sibling appends `.local` literally (producing odd siblings
//      like `config.conf.local`).
// LOADER-CONTRACT.md should land these as the canonical contract on the
// agent-os side so the divergences narrow back to zero.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import yaml from 'js-yaml';

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

function isLocalYamlSource(source) {
  if (typeof source !== 'string' || !source) return false;
  const name = basename(source);
  return name.endsWith('.local.yaml') || name.endsWith('.local.yml');
}

// Silent by default. We deliberately do NOT console.warn unknown-key drops:
// agent-os#1738 showed a config-loader warning leaking onto stderr can corrupt
// positional config captures downstream. Opt in with ADVERSARIAL_CONFIG_DEBUG.
function configDebugLog(message) {
  if (process.env.ADVERSARIAL_CONFIG_DEBUG) {
    process.stderr.write(`[adversarial-config] ${message}\n`);
  }
}

// -------- Schema declaration -----------------------------------------------

const ENUM_ROLES_REVIEWER = ['claude-code', 'codex', 'claude', 'gemini', 'adversarial'];
const ENUM_ROLES_REMEDIATOR = ['claude-code', 'codex', 'gemini', 'adversarial'];
// `hammer` is the universal end-of-budget rescue worker (codex-backed, runs under
// the merge-agent app identity); allowed here so the budget-exhausted final pass
// can dispatch it. See worker-pool hq_resolve_worker_identity (merge-agent-lacey).
const ENUM_ROLES_MERGE_AGENT_WORKER_CLASS = ['merge-agent', 'codex', 'claude-code', 'hammer'];
const ENUM_ROLES_BUILD_PACK_DEFAULT_WORKER_CLASS = ['codex', 'claude-code'];
export const ENUM_ROLES_ADVERSARIAL_ORCHESTRATION_MODE = ['native', 'agentos'];
const ENUM_ROLES_ADVERSARIAL_MERGE_AUTHORITY_RISK_CLASS = ['low', 'medium', 'high', 'critical'];
const ENUM_ROLES_FALLBACK_PATH = ['none', 'litellm-vk', 'litellm-vk-then-deferral'];
// GMW-02 — gemini always-on-third-reviewer selection mode. Module-scoped knob
// (`reviewer.gemini.mode`); see the routing layer in
// adapters/subject/github-pr/routing.mjs.
const ENUM_REVIEWER_GEMINI_MODE = ['off', 'fallback', 'always-on'];
const FOREIGN_TOP_LEVEL_SECTIONS = new Set([
  // LOADER-CONTRACT §2 permits each reader to ignore only root sections
  // explicitly foreign to that reader in top-level config.local.yaml.
  //
  // `worker_pool` is no longer listed here: as of the deep-reconcile CFG knob
  // (2026-06-19) this reader carries a PARTIAL `worker_pool` schema (only
  // `dag.autowalk.deep_reconcile`) so the watcher tolerates that key in the
  // canonical config.yaml. worker_pool is therefore a known (not foreign) root;
  // its other keys are still Python-owned and are tolerated-dropped per-key in
  // config.local.yaml via the nested-unknown drop. Re-add a root here only if a
  // whole top-level section is genuinely owned by another reader and unmirrored.
]);
// Keep this per-role fallback surface in lockstep with the Python
// agent_os_config schema. The child dicts are intentionally strict so a
// Python-only key must not land without adding the same key here first.
// Role-class keys are hyphenated to mirror worker class tokens, while older
// role-level knobs remain snake_case. Strict-schema errors should keep nearest
// key suggestions useful for operator typos across both shapes.
const ROLE_FALLBACK_CLASSES = [
  'claude-code',
  'codex',
  'claude-reviewer-lacey',
  'codex-reviewer-lacey',
  'merge-agent',
  'merge-agent-failure-recovery',
  'clio-agent',
];
// Worker-class options for `dispatch.default_worker_class_by_task_kind` leaves.
// Mirrors `_ENUM_DISPATCH_DEFAULT_WORKER_CLASS` in
// `platform/agent-os-config/src/agent_os_config/__init__.py`. Constrained to
// the supported coding-family worker classes plus `merge-agent` for the merge
// family. Operators can still pass
// `--worker-class` at the call site to escape this constraint.
const ENUM_DISPATCH_DEFAULT_WORKER_CLASS = ['codex', 'claude-code', 'merge-agent'];
const ENUM_SESSION_LEDGER_BACKEND = ['sqlite', 'postgres'];
const ENUM_SESSION_LEDGER_DUAL_WRITE_MODE = [null, 'postgres', 'sqlite', 'off'];
const ENUM_SESSION_LEDGER_SERVICE_LOG_LEVEL = ['CRITICAL', 'ERROR', 'WARNING', 'INFO', 'DEBUG'];
const ENUM_APP_MODE = ['agent-os', 'standalone'];
const ENUM_UPDATE_CHANNEL = ['rolling', 'stable', 'pinned'];
const PATTERN_LINEAR_ISSUE_PREFIX = '^[A-Z][A-Z0-9]{1,9}$';
const PATTERN_LINEAR_ISSUE_PREFIX_DESCRIPTION = 'Linear issue prefix /^[A-Z][A-Z0-9]{1,9}$/';
const PATTERN_SQL_IDENTIFIER = '^[A-Za-z_][A-Za-z0-9_]{0,62}$';
const PATTERN_SQL_IDENTIFIER_DESCRIPTION = 'SQL identifier /^[A-Za-z_][A-Za-z0-9_]{0,62}$/';
const PATTERN_LOCAL_USERNAME = '^[A-Za-z_][A-Za-z0-9_-]{0,63}$';
const PATTERN_LOCAL_USERNAME_DESCRIPTION = 'local username /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/';

const TYPE_STRING = 'string';
const TYPE_BOOL = 'bool';
const TYPE_INT = 'int';
const TYPE_FLOAT = 'float';
const TYPE_LIST = 'list';
const TYPE_DICT = 'dict';

function buildRoleFallbackSchemaKeys() {
  return Object.fromEntries(
    ROLE_FALLBACK_CLASSES.map((roleClass) => [
      roleClass,
      {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          fallback_path: {
            __type: TYPE_STRING,
            __default: 'none',
            __enum: ENUM_ROLES_FALLBACK_PATH,
          },
        },
      },
    ]),
  );
}

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

function schemaV1() {
  return {
    __type: TYPE_DICT,
    __strict: true,
    __keys: {
      version: { __type: TYPE_INT, __required: true, __enum: [1] },
      review_cycle_cap: { __type: TYPE_INT, __default: 5, __min: 1 },
      review_cycle_window_hours: { __type: TYPE_INT, __default: 24, __min: 1 },
      update: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          channel: {
            __type: TYPE_STRING,
            __default: 'rolling',
            __enum: ENUM_UPDATE_CHANNEL,
          },
        },
      },
      // main_catchup is a PARTIAL mirror. Python owns the full main-catchup
      // daemon schema; this Node reader exposes only the adversarial-review
      // drain knobs that may appear in checked-in config.yaml. Other
      // main_catchup.* keys remain Python-owned and must fail loud in
      // checked-in config, while operator-local config.local.yaml can
      // tolerate-drop them through nested-local tolerance.
      main_catchup: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          adversarial_review_drain_timeout_seconds: {
            __type: TYPE_INT,
            __default: 1200,
            __min: 1,
          },
          adversarial_watcher_drain_bounce_slack_seconds: {
            __type: TYPE_INT,
            __default: 600,
            __min: 0,
          },
        },
      },
      roots: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          hq: { __type: TYPE_STRING, __default: null, __nullable: true },
          deploy: { __type: TYPE_STRING, __default: null, __nullable: true },
          // OSR-03 — operator account-home roots. These pair with
          // `AGENT_OS_ROOTS_RUNTIME_HOME` / `AGENT_OS_ROOTS_ADMIN_HOME`
          // env aliases on the Python side. Forks override per-host.
          runtime_home: { __type: TYPE_STRING, __default: null, __nullable: true },
          admin_home: { __type: TYPE_STRING, __default: null, __nullable: true },
          // OSR-03 account-name extension. The Node loader does not consume
          // these values directly, but strict CFG parity means top-level
          // config.yaml must parse in every language sibling.
          runtime_user: {
            __type: TYPE_STRING,
            __default: null,
            __nullable: true,
            __pattern: PATTERN_LOCAL_USERNAME,
            __pattern_description: PATTERN_LOCAL_USERNAME_DESCRIPTION,
          },
          admin_user: {
            __type: TYPE_STRING,
            __default: null,
            __nullable: true,
            __pattern: PATTERN_LOCAL_USERNAME,
            __pattern_description: PATTERN_LOCAL_USERNAME_DESCRIPTION,
          },
        },
      },
      openclaw: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          // OSR-04b: top-level keys must be accepted by every strict CFG
          // loader even when only one language consumes the value at runtime.
          install_root: { __type: TYPE_STRING, __default: null, __nullable: true },
        },
      },
      codex: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          // OSR-04a: parent Agent OS promotes this for shell/Python consumers;
          // the Node loader keeps it parseable to preserve strict-schema parity.
          acp_state_home: { __type: TYPE_STRING, __default: null, __nullable: true },
        },
      },
      agent_control: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          codex_runaway_guardrails: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              observed_repos: {
                __type: TYPE_LIST,
                __item: { __type: TYPE_STRING },
                __default: ['laceyenterprises/agent-os', 'laceyenterprises/adversarial-review'],
              },
              convergence_stall_commit_window_seconds: { __type: TYPE_INT, __default: 3600, __min: 1 },
              convergence_stall_min_commits: { __type: TYPE_INT, __default: 3, __min: 1 },
              convergence_stall_file_fetch_budget_per_cycle: { __type: TYPE_INT, __default: 20, __min: 1 },
              convergence_stall_finding_dedupe_seconds: { __type: TYPE_INT, __default: 900, __min: 1 },
              convergence_stall_repo_backoff_seconds: { __type: TYPE_INT, __default: 60, __min: 1 },
              convergence_stall_observed_worker_classes: {
                __type: TYPE_LIST,
                __item: { __type: TYPE_STRING },
                __default: ['codex', 'claude-code', 'clio-agent'],
              },
              compaction_rate_alarm_per_hour: { __type: TYPE_INT, __default: 3, __min: 1 },
              compaction_rate_alarm_finding_dedupe_seconds: { __type: TYPE_INT, __default: 86400, __min: 1 },
              token_budget_per_session: { __type: TYPE_INT, __default: 50000000, __min: 0 },
              pr_class_additive_only_allowlist: {
                __type: TYPE_LIST,
                __item: { __type: TYPE_STRING },
                __default: [
                  'projects/*',
                  'modules/worker-pool/post-merge-actions/*',
                  'docs/POSTMORTEM-*.md',
                  'docs/AUDIT-*.md',
                ],
              },
              vocabulary_fatigue_window_commits: { __type: TYPE_INT, __default: 5, __min: 1 },
              vocabulary_fatigue_min_repeats: { __type: TYPE_INT, __default: 3, __min: 1 },
            },
          },
        },
      },
      // OAuth broker watchdog tuning. Mirrors the Python authority
      // (`oauth_broker.watchdog` in
      // platform/agent-os-config/src/agent_os_config/__init__.py). The Node
      // loader does not consume these values at runtime, but strict CFG parity
      // (LOADER-CONTRACT §2) requires every checked-in config.yaml key to parse
      // under every sibling loader. The first six knobs landed in PR-C1
      // (e04c7d61); the port-forward-wedge tier (broker_container_name,
      // docker_bin, broker_internal_healthz_url,
      // portforward_wedge_restart_max_attempts) landed in #1958, both
      // Python-only — this section heals the drift.
      oauth_broker: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          watchdog: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              health_poll_interval_seconds: {
                __type: TYPE_FLOAT,
                __default: 30.0,
                __min: 1.0,
                __max: 3600.0,
              },
              health_probe_timeout_seconds: {
                __type: TYPE_FLOAT,
                __default: 4.0,
                __min: 0.5,
                __max: 600.0,
              },
              recovery_action_timeout_seconds: {
                __type: TYPE_FLOAT,
                __default: 20.0,
                __min: 1.0,
                __max: 1800.0,
              },
              max_recovery_attempts_per_outage: {
                __type: TYPE_INT,
                __default: 3,
                __min: 1,
                __max: 100,
              },
              recovery_backoff_initial_seconds: {
                __type: TYPE_FLOAT,
                __default: 5.0,
                __min: 0.0,
                __max: 3600.0,
              },
              recovery_backoff_max_seconds: {
                __type: TYPE_FLOAT,
                __default: 30.0,
                __min: 0.0,
                __max: 3600.0,
              },
              // Port-forward-wedge remediation tiers (#1958, PFW-05).
              broker_container_name: {
                __type: TYPE_STRING,
                __default: 'litellm-oauth-broker-1',
              },
              broker_compose_file: {
                __type: TYPE_STRING,
                __default:
                  '/Users/airlock/agent-os/modules/model-routing-budget-control/runtime/config/docker-compose.yml',
              },
              broker_compose_project_name: {
                __type: TYPE_STRING,
                __default: 'litellm',
              },
              broker_compose_service_name: {
                __type: TYPE_STRING,
                __default: 'oauth-broker',
              },
              broker_docker_network: {
                __type: TYPE_STRING,
                __default: 'litellm_default',
              },
              docker_bin: {
                __type: TYPE_STRING,
                __default: 'docker',
              },
              broker_internal_healthz_url: {
                __type: TYPE_STRING,
                __default: 'http://127.0.0.1:4002/healthz',
              },
              portforward_wedge_restart_max_attempts: {
                __type: TYPE_INT,
                __default: 3,
                __min: 1,
                __max: 20,
              },
              docker_reset_enabled: {
                __type: TYPE_BOOL,
                __default: true,
              },
              docker_reset_cooldown_seconds: {
                __type: TYPE_INT,
                __default: 3600,
                __min: 0,
                __max: 86400,
              },
              docker_reset_daily_cap: {
                __type: TYPE_INT,
                __default: 3,
                __min: 0,
                __max: 20,
              },
              docker_reset_lifetime_cap: {
                __type: TYPE_INT,
                __default: 20,
                __min: 0,
                __max: 1000,
              },
              full_restart_break_glass_enabled: {
                __type: TYPE_BOOL,
                __default: false,
              },
              full_restart_daily_cap: {
                __type: TYPE_INT,
                __default: 1,
                __min: 0,
                __max: 10,
              },
              full_restart_lifetime_cap: {
                __type: TYPE_INT,
                __default: 3,
                __min: 0,
                __max: 100,
              },
              full_restart_docker_daemon_wait_seconds: {
                __type: TYPE_INT,
                __default: 180,
                __min: 1,
                __max: 1800,
              },
              critical_service_patterns: {
                __type: TYPE_STRING,
                __default:
                  'litellm,litellm-db,agent-control,agent_control,lgtm-alloy,lgtm-prometheus,lgtm-loki,lgtm-tempo,lgtm-grafana,session-ledger-postgres-exporter',
              },
            },
          },
        },
      },
      governance: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          emergency_stop_path: {
            __type: TYPE_STRING,
            __default: '~/.agent-os/governance/emergency-stop',
          },
        },
      },
      apps: {
        __type: TYPE_DICT,
        __strict: false,
        __default: {},
        __keys: {},
        __extra_keys_schema: {
          __type: TYPE_DICT,
          __strict: true,
          __keys: {
            mode: {
              __type: TYPE_STRING,
              __default: 'agent-os',
              __enum: ENUM_APP_MODE,
            },
            subscribes: {
              __type: TYPE_LIST,
              __item: { __type: TYPE_STRING },
              __default: [],
            },
            contract_version: {
              __type: TYPE_STRING,
              __default: '1.0',
            },
          },
        },
      },
      // DRP-01N — retention policy block. Strict-shape parity matters here
      // because the adversarial watcher consumes this Node loader and must
      // tolerate the top-level Agent OS `retention:` surface. Policy names are
      // intentionally fixed to the Python reaper's current schema; adding a new
      // named policy requires a lockstep Node/Python schema rollout.
      retention: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          policies: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              standard_backup: {
                __type: TYPE_DICT,
                __strict: true,
                __keys: {
                  daily: { __type: TYPE_INT, __default: 7, __min: 0 },
                  weekly: { __type: TYPE_INT, __default: 4, __min: 0 },
                  monthly: { __type: TYPE_INT, __default: 3, __min: 0 },
                },
              },
            },
          },
          cadence: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              weekly_day_of_week: { __type: TYPE_INT, __default: 0, __min: 0, __max: 6 },
              monthly_day_of_month: { __type: TYPE_INT, __default: 1, __min: 1, __max: 31 },
            },
          },
          surfaces: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              postgres_backups: {
                __type: TYPE_DICT,
                __strict: true,
                __keys: {
                  policy: { __type: TYPE_STRING, __default: 'standard_backup' },
                },
              },
            },
          },
          ephemeral: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              worker_worktrees_keep_hours: { __type: TYPE_INT, __default: 168, __min: 0 },
              worker_worktrees_per_run_limit: { __type: TYPE_INT, __default: 200, __min: 1 },
              follow_up_workspaces_keep_hours: { __type: TYPE_INT, __default: 72, __min: 0 },
              acpx_sessions_keep_days: { __type: TYPE_INT, __default: 30, __min: 0 },
              acpx_sessions_gib_cap: { __type: TYPE_FLOAT, __default: 10.0, __min: 0 },
              acpx_sessions_min_idle_minutes: { __type: TYPE_INT, __default: 60, __min: 0 },
              openclaw_sessions_keep_days: { __type: TYPE_INT, __default: 30, __min: 0 },
              openclaw_sessions_min_idle_minutes: { __type: TYPE_INT, __default: 60, __min: 0 },
              claude_code_sessions_keep_days: { __type: TYPE_INT, __default: 90, __min: 0 },
              dispatch_audit_keep_days: { __type: TYPE_INT, __default: 365, __min: 0 },
            },
          },
          sentinel: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              disk_headroom: {
                __type: TYPE_DICT,
                __strict: true,
                __keys: {
                  threshold_pct: { __type: TYPE_INT, __default: 85, __min: 0, __max: 100 },
                  threshold_pct_critical: { __type: TYPE_INT, __default: 95, __min: 0, __max: 100 },
                  threshold_gib_free: { __type: TYPE_INT, __default: 10, __min: 0 },
                  threshold_gib_free_critical: { __type: TYPE_INT, __default: 2, __min: 0 },
                  page_dedupe_seconds: { __type: TYPE_INT, __default: 3600, __min: 0 },
                },
              },
            },
          },
        },
      },
      session_ledger: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          backend: {
            __type: TYPE_STRING,
            __default: null,
            __nullable: true,
            __enum: ENUM_SESSION_LEDGER_BACKEND,
          },
          dsn: {
            __type: TYPE_STRING,
            __default: null,
            __nullable: true,
          },
          database_name: {
            __type: TYPE_STRING,
            __default: 'agent_os_ledger',
            __pattern: PATTERN_SQL_IDENTIFIER,
            __pattern_description: PATTERN_SQL_IDENTIFIER_DESCRIPTION,
          },
          // CFG-04 dual-write nested block — mirrors agent_os_config
          // `_schema_v1()` (Python loader, line ~276). Added 2026-06-02
          // after operator's config.local.yaml set `session_ledger.dual_write.mode`
          // and the watcher crash-skipped every PR with `routeSubject returned
          // config-broken ... session_ledger.dual_write: unknown key (strict schema)
          // — skipping this PR for the tick`. Same multi-language CFG drift
          // class as the 2026-05-31 incident; keep this block in lockstep
          // with the Python schema.
          dual_write: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              mode: {
                __type: TYPE_STRING,
                __default: null,
                __nullable: true,
                __enum: ENUM_SESSION_LEDGER_DUAL_WRITE_MODE,
              },
              failure_threshold: { __type: TYPE_INT, __default: 5 },
              failure_cooldown_seconds: { __type: TYPE_FLOAT, __default: 300.0 },
              queue_max_batches: { __type: TYPE_INT, __default: 1000 },
              slow_write_ms: { __type: TYPE_INT, __default: 1000 },
            },
          },
          // Service / shadow-read / refresh / alert_bridge: same multi-loader
          // parity rationale. Mirrors the Python `_schema_v1()` `session_ledger.*`
          // sub-blocks. Defaults track Python; types must match.
          service: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              refresh_interval_seconds: { __type: TYPE_INT, __default: null, __nullable: true },
              stale_threshold_seconds: { __type: TYPE_INT, __default: null, __nullable: true },
              log_level: {
                __type: TYPE_STRING,
                __default: 'INFO',
                __enum: ENUM_SESSION_LEDGER_SERVICE_LOG_LEVEL,
              },
              log_max_bytes: { __type: TYPE_INT, __default: 10 * 1024 * 1024 },
              log_retention_days: { __type: TYPE_INT, __default: null, __nullable: true },
              doctor_launchctl_timeout_seconds: {
                __type: TYPE_FLOAT,
                __default: null,
                __nullable: true,
              },
            },
          },
          shadow_read: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              max_rows: { __type: TYPE_INT, __default: 1000 },
              failure_threshold: { __type: TYPE_INT, __default: 5 },
              failure_cooldown_seconds: { __type: TYPE_FLOAT, __default: 300.0 },
              slow_ms: { __type: TYPE_INT, __default: 1000 },
              log_backup_count: { __type: TYPE_INT, __default: 128 },
            },
          },
          refresh: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              per_source_timeout_seconds: {
                __type: TYPE_FLOAT,
                __default: null,
                __nullable: true,
              },
              source_batch_before_conn_reset: {
                __type: TYPE_INT,
                __default: null,
                __nullable: true,
              },
              stuck_refresh_timeout_seconds: {
                __type: TYPE_FLOAT,
                __default: null,
                __nullable: true,
              },
              analyze_refresh_interval: {
                __type: TYPE_INT,
                __default: null,
                __nullable: true,
              },
            },
          },
          alert_bridge: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              url: { __type: TYPE_STRING, __default: null, __nullable: true },
              allow_remote: { __type: TYPE_BOOL, __default: false },
            },
          },
        },
      },
      // Cross-cutting GitHub integration. Added 2026-05-31 to mirror the
      // Python schema (`platform/agent-os-config/src/agent_os_config/__init__.py`
      // `_schema_v1()`). PR #1136 added `github.org` to the Python side
      // for the WBH-03 de-hardcoding fix and to top-level `config.yaml`;
      // this Node loader has its OWN strict schema and crashed in a loop
      // on watcher startup with `expected: 'one of [...]', got: 'github'`
      // until this entry was added. Keep this section in sync with the
      // Python schema. Default: `laceyenterprises`.
      github: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          org: {
            __type: TYPE_STRING,
            __default: 'laceyenterprises',
          },
          // OSR-01 follow-on (agent-os PR #1216): the Python + YAML schemas
          // accept `github.workspace_email_domain` as a nullable string. The
          // Node loader must accept the same key or the watcher crash-loops
          // at startup with `unknown key (strict schema)` — 4th occurrence of
          // the CFG-01 multi-loader drift bug. Keep in lockstep with
          // `platform/agent-os-config/src/agent_os_config/__init__.py`
          // `workspace_email_domain` entry under `github`.
          workspace_email_domain: {
            __type: TYPE_STRING,
            __default: null,
            __nullable: true,
          },
        },
      },
      // OSR-05 — operator identity. Parse-only for this package, but strict
      // Node CFG consumers must accept the parent Agent OS top-level config.
      operator: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          email: {
            __type: TYPE_STRING,
            __default: 'virtualpaul@gmail.com',
          },
          full_name: {
            __type: TYPE_STRING,
            __default: 'Paul Lacey',
          },
        },
      },
      // OSR-06 — host + Tailscale per-device identity. Keep these keys in
      // lockstep with the Python loader so checked-in top-level config.yaml
      // remains readable by strict Node CFG consumers.
      host: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          name: {
            __type: TYPE_STRING,
            __default: null,
            __nullable: true,
          },
          tailscale_hostname: {
            __type: TYPE_STRING,
            __default: null,
            __nullable: true,
          },
        },
      },
      tailscale: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          workstation_ip: {
            __type: TYPE_STRING,
            __default: null,
            __nullable: true,
          },
          daily_driver_ip: {
            __type: TYPE_STRING,
            __default: null,
            __nullable: true,
          },
          ipad_ip: {
            __type: TYPE_STRING,
            __default: null,
            __nullable: true,
          },
          iphone_ip: {
            __type: TYPE_STRING,
            __default: null,
            __nullable: true,
          },
        },
      },
      // OSR-02 — launchd label prefix for fork-safe reverse-DNS labels.
      // Keep this in lockstep with the Python CFG schema; strict Node CFG
      // consumers parse top-level config.yaml during watcher startup.
      launchd: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          label_prefix: {
            __type: TYPE_STRING,
            __default: 'ai.laceyenterprises',
          },
        },
      },
      linear: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          team_name: {
            __type: TYPE_STRING,
            __default: 'Laceyenterprises',
          },
          issue_prefix: {
            __type: TYPE_STRING,
            __default: 'LAC',
            __pattern: PATTERN_LINEAR_ISSUE_PREFIX,
            __pattern_description: PATTERN_LINEAR_ISSUE_PREFIX_DESCRIPTION,
          },
        },
      },
      submodules: {
        __type: TYPE_DICT,
        __strict: false,
        __keys: {},
      },
      roles: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          reviewer: {
            __type: TYPE_STRING,
            __default: 'adversarial',
            __enum: ENUM_ROLES_REVIEWER,
            __normalize: { claude: 'claude-code' },
          },
          remediator: {
            __type: TYPE_STRING,
            __default: 'adversarial',
            __enum: ENUM_ROLES_REMEDIATOR,
          },
          merge_agent_worker_class: {
            __type: TYPE_STRING,
            __default: 'merge-agent',
            __enum: ENUM_ROLES_MERGE_AGENT_WORKER_CLASS,
          },
          build_pack_default_worker_class: {
            __type: TYPE_STRING,
            __default: 'codex',
            __enum: ENUM_ROLES_BUILD_PACK_DEFAULT_WORKER_CLASS,
          },
          hermes: {
            // Mirrors the Python `roles.hermes.provider` schema so the
            // shared host config remains loadable by both CFG loaders.
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              provider: {
                __type: TYPE_STRING,
                __default: 'nous-portal',
              },
            },
          },
          adversarial: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              orchestration_mode: {
                __type: TYPE_STRING,
                __default: 'native',
                __enum: ENUM_ROLES_ADVERSARIAL_ORCHESTRATION_MODE,
              },
              merge_authority: {
                __type: TYPE_DICT,
                __strict: true,
                __keys: {
                  enabled: { __type: TYPE_BOOL, __default: false },
                  worker_class: {
                    __type: TYPE_STRING,
                    __default: 'hammer',
                    __enum: ['codex', 'claude-code', 'hammer', 'gemini'],
                  },
                  merge_method: {
                    __type: TYPE_STRING,
                    __default: 'squash',
                    __enum: ['squash', 'merge'],
                  },
                  strict_non_blocking_remediation: {
                    __type: TYPE_BOOL,
                    __default: true,
                  },
                  auto_hammer_on_eligibility_miss: {
                    __type: TYPE_BOOL,
                    __default: false,
                  },
                  // Wall-clock cap (ms) the watcher gives `hq dispatch` to admit
                  // + provision a closer/hammer worker before SIGTERM. The old
                  // hardcoded 90s was below the merge-worker provision time
                  // (~57s baseline, slower under contention), so the watcher
                  // killed healthy dispatches -> dispatch-failed -> no close.
                  dispatch_timeout_ms: {
                    __type: TYPE_INT,
                    __default: 300000,
                  },
                  eligibility: {
                    __type: TYPE_DICT,
                    __strict: true,
                    __keys: {
                      risk_classes: {
                        __type: TYPE_LIST,
                        __item: {
                          __type: TYPE_STRING,
                          __enum: ENUM_ROLES_ADVERSARIAL_MERGE_AUTHORITY_RISK_CLASS,
                        },
                        __default: ['low'],
                      },
                      fast_merge_labels: {
                        __type: TYPE_LIST,
                        __item: { __type: TYPE_STRING },
                        __default: ['fast-merge:test-fixtures', 'fast-merge:docs'],
                      },
                      reviewer_family_policy: {
                        __type: TYPE_STRING,
                        __default: 'audit_existing_gate_contract',
                        __enum: ['audit_existing_gate_contract'],
                      },
                      ci_green_classifier: {
                        __type: TYPE_STRING,
                        __default: 'existingAdversarialMergeClassifier',
                        __enum: ['existingAdversarialMergeClassifier'],
                      },
                      // SPEC §4.2 #3 — by default `high`/`critical` risk PRs
                      // require the explicit two-key override (a non-author
                      // `adversarial-merge-requested` label AND an operator
                      // override on the current head) before AMA may close them;
                      // only `low`/`medium` close on plain risk_classes
                      // membership. Operators who want AMA to be the single
                      // authority for EVERY risk class set this false: then
                      // `high`/`critical` close on risk_classes membership alone,
                      // exactly like low/medium. `unknown`/unclassified risk is
                      // NEVER waived by this knob — it always requires two-key,
                      // because an unknown class means the risk could not be
                      // established (fail-closed). Default true preserves the
                      // current two-key behavior for every deployment that does
                      // not opt in.
                      high_risk_requires_two_key: {
                        __type: TYPE_BOOL,
                        __default: true,
                      },
                    },
                  },
                  branch_protection: {
                    __type: TYPE_DICT,
                    __strict: true,
                    __keys: {
                      required_gate_context_source: {
                        __type: TYPE_STRING,
                        __default: 'resolveGateStatusContext',
                        __enum: ['resolveGateStatusContext'],
                      },
                      // SPEC §4.2 #9 is satisfied by a required branch-protection
                      // status check. Some repos run on a GitHub plan that does
                      // not offer branch protection at all (the protection API
                      // 403s with "Upgrade to GitHub Pro"), so the gate context
                      // can never be present and AMA can never close. Operators
                      // on such repos set this false to drop ONLY the
                      // branch-protection requirement; every other §4.2 hard gate
                      // (settled-success verdict, head-match via
                      // --match-head-commit, mergeable, no blocking findings,
                      // risk-class, hard-stop labels, CI-green) still applies.
                      // Default true preserves the existing fail-closed contract
                      // everywhere it is not explicitly opted out.
                      required: {
                        __type: TYPE_BOOL,
                        __default: true,
                      },
                    },
                  },
                },
              },
            },
          },
          ...buildRoleFallbackSchemaKeys(),
          quota_probe: {
            // Intentionally remains under `roles` to mirror the Python
            // HRR-02b schema; relocating it must happen in both loaders
            // together so Node does not fork the contract.
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              // Out-of-range values hard-fail at load time. This mirrors
              // the Python loader's range-bound contract; there is no
              // silent clamp because operators need misconfigurations in
              // the startup banner, not hidden boundary rewrites.
              ok_tick_seconds: {
                __type: TYPE_INT,
                __default: 3600,
                __min: 300,
                __max: 21600,
              },
              exhausted_unknown_tick_seconds: {
                __type: TYPE_INT,
                __default: 3600,
                __min: 600,
                __max: 21600,
              },
            },
          },
        },
      },
      policy: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          dedup: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              uncommitted_line_threshold: {
                __type: TYPE_INT,
                __default: 30,
                __min: 10,
                __max: 1000,
              },
            },
          },
        },
      },
      // worker_pool.dag.autowalk.deep_reconcile — Python-owned (canonical schema
      // at platform/agent-os-config). PARTIAL mirror, same rationale as the
      // sentinel block below: this Node reader does not consume the value, but
      // it must not crash-loop if this checked-in key reaches the shared
      // canonical config.yaml (CFG-01 strict-schema parity). Only deep_reconcile
      // is mirrored; every other worker_pool.* key stays Python-owned and is
      // tolerated-dropped in operator-local config.local.yaml (nested-unknown
      // drop), so worker-pool tuning like dispatch.max_concurrent_in_flight /
      // memory.pressure.* still lives there untouched. Python stays canonical.
      worker_pool: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          dag: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              autowalk: {
                __type: TYPE_DICT,
                __strict: true,
                __keys: {
                  deep_reconcile: { __type: TYPE_BOOL, __default: false },
                },
              },
            },
          },
        },
      },
      // Sentinel detector knobs. The Python sibling at
      // `platform/agent-os-config/src/agent_os_config/__init__.py` is the
      // canonical schema and remains the owner of these `sentinel.*` keys —
      // `projects/sentinel-argus-knobs/SPEC.md` keeps them Python-owned and
      // Node-foreign-ignored (no cfg-parity gate). This Node mirror exists
      // only so the adversarial-watcher doesn't crash-loop the moment an
      // operator writes the checked-in top-level `sentinel:` keys into the
      // shared config.yaml (CFG-01 strict-schema parity rule). It mirrors the
      // checked-in top-level keys needed at adversarial-review startup, not
      // every future Sentinel knob; Python stays canonical for the rest.
      sentinel: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          spec_drift: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              cycle_interval_seconds: { __type: TYPE_INT, __default: 86400, __min: 1 },
            },
          },
          deploy_checkout: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              repo_path: { __type: TYPE_STRING, __default: '/Users/airlock/agent-os' },
              scan_interval_seconds: { __type: TYPE_INT, __default: 60, __min: 1 },
              page_dedupe_seconds: { __type: TYPE_INT, __default: 300, __min: 1 },
              worker_identity_emails: {
                __type: TYPE_LIST,
                __item: { __type: TYPE_STRING },
                __default: [
                  'claude-code@laceyenterprises.com',
                  'clio-agent@laceyenterprises.com',
                  'codex@laceyenterprises.com',
                  'merge-agent@laceyenterprises.com',
                ],
              },
            },
          },
          codex_compaction: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              rate_alarm_per_hour: { __type: TYPE_INT, __default: 3, __min: 1 },
              finding_dedupe_seconds: { __type: TYPE_INT, __default: 86400, __min: 1 },
            },
          },
          convergence_stall: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              observed_repos: {
                __type: TYPE_LIST,
                __item: { __type: TYPE_STRING },
                __default: ['laceyenterprises/agent-os', 'laceyenterprises/adversarial-review'],
              },
              commit_window_seconds: { __type: TYPE_INT, __default: 3600, __min: 1 },
              min_commits: { __type: TYPE_INT, __default: 3, __min: 1 },
              file_fetch_budget_per_cycle: { __type: TYPE_INT, __default: 20, __min: 1 },
              finding_dedupe_seconds: { __type: TYPE_INT, __default: 900, __min: 1 },
              repo_backoff_seconds: { __type: TYPE_INT, __default: 60, __min: 1 },
              observed_worker_classes: {
                __type: TYPE_LIST,
                __item: { __type: TYPE_STRING },
                __default: ['codex', 'claude-code', 'clio-agent'],
              },
            },
          },
          disk_headroom: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              top_consumer_roots: { __type: TYPE_STRING, __default: '/Users/airlock,/Users/placey' },
              top_consumer_limit: { __type: TYPE_INT, __default: 3, __min: 1 },
              df_timeout_seconds: { __type: TYPE_FLOAT, __default: 1.0, __min: 0 },
              du_timeout_seconds: { __type: TYPE_FLOAT, __default: 30.0, __min: 0 },
              sensor_failure_page_threshold: { __type: TYPE_INT, __default: 2, __min: 1 },
            },
          },
          detectors: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              litellm_routing_tier_outage: {
                __type: TYPE_DICT,
                __strict: true,
                __keys: {
                  enabled: { __type: TYPE_BOOL, __default: true },
                  log_path: { __type: TYPE_STRING, __default: null, __nullable: true },
                  window_seconds: { __type: TYPE_INT, __default: 300, __min: 1 },
                  event_count_threshold: { __type: TYPE_INT, __default: 3, __min: 1 },
                  severity: { __type: TYPE_STRING, __default: 'SEV-2', __enum: ['SEV-1', 'SEV-2', 'SEV-3'] },
                  comms_channels: {
                    __type: TYPE_LIST,
                    __item: { __type: TYPE_STRING, __enum: ['telegram', 'email'] },
                    __default: ['telegram', 'email'],
                  },
                },
              },
            },
          },
        },
      },
      feature_flags: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          live_steer_allow_unvetted: { __type: TYPE_BOOL, __default: false },
          claude_code_ambient_auth_fallback: { __type: TYPE_BOOL, __default: false },
          merge_agent_failure_recovery_disable: { __type: TYPE_BOOL, __default: false },
          merge_agent_final_pass_on_request_changes: { __type: TYPE_BOOL, __default: true },
          allow_missing_alert_to: { __type: TYPE_BOOL, __default: false },
          resume_context_envelope: { __type: TYPE_BOOL, __default: true },
        },
      },
      // Module-internal sections used by tools/adversarial-review. These are
      // module-scoped knobs (no top-level canonical equivalent); declared here
      // so `tools/adversarial-review/config.yaml` parses against the strict
      // schema. Only role keys are wired through resolvers in CFG-02; the
      // others are checked-in defaults waiting on per-knob refactors.
      // `merge_agent.worker_class` is NOT a separate slot: the adversarial
      // module file aliases it onto `roles.merge_agent_worker_class` per
      // SPEC §10.2, so the canonical body never carries the legacy path.
      remediation: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          max_concurrent_jobs: { __type: TYPE_INT, __default: 1 },
          // Upper bound the operator can dial `max_concurrent_jobs` up to
          // via env / config. Existing helper at follow-up-remediation.mjs
          // clamped to 8; promoting it lets operators on bigger hosts raise
          // the ceiling without code edits.
          max_concurrent_jobs_ceiling: { __type: TYPE_INT, __default: 8, __min: 1 },
          // Lifecycle reconciliation watchdog — a remediation reservation
          // older than this many ms is considered abandoned and reclaimed
          // for re-dispatch. Default 6h (21_600_000 ms).
          reconciliation_max_active_age_ms_before_abandon: {
            __type: TYPE_INT,
            __default: 21600000,
            __min: 60000,
          },
        },
      },
      merge_agent: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          final_pass_on_request_changes: { __type: TYPE_BOOL, __default: true },
        },
      },
      reviewer: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          timeout_ms: { __type: TYPE_INT, __default: 1200000 },
          // The reviewer is also killed if it makes no progress (no output
          // event) for this many ms. Distinct from the total wall-clock
          // timeout above — a 20-min reviewer that keeps producing output
          // every 5 min should not be killed by `no_progress_timeout_ms`,
          // but one that goes silent for 15 min should be. Default 15 min.
          no_progress_timeout_ms: {
            __type: TYPE_INT,
            __default: 900000,
            __min: 1000,
          },
          fallback_threshold: { __type: TYPE_INT, __default: 2 },
          // GMW-02 — gemini always-on third reviewer. `always-on` (operator
          // default) selects gemini as the reviewer for the cross-model-eligible
          // builder classes; `fallback` selects gemini only when the assigned
          // primary reviewer is quota-capped; `off` preserves pre-GMW routing.
          gemini: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              mode: {
                __type: TYPE_STRING,
                __default: 'always-on',
                __enum: ENUM_REVIEWER_GEMINI_MODE,
              },
            },
          },
        },
      },
      watcher: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          alert_to_op_ref: {
            __type: TYPE_STRING,
            __default: null,
            __nullable: true,
          },
          // Max ms the watcher will wait during drain before forcing exit.
          // Default 1h. Lower for tighter restart windows on operator-driven
          // restarts; raise for long-running PR backlogs.
          max_drain_wait_ms: {
            __type: TYPE_INT,
            __default: 3600000,
            __min: 1000,
          },
          // Pending-draft reviewer respawn-age gate. A pending draft review
          // older than this many seconds is eligible for respawn. Default 15
          // min. Floor enforced separately in the watcher code; this CFG
          // value is the default before per-process floors apply.
          pending_draft_review_respawn_age_seconds: {
            __type: TYPE_INT,
            __default: 900,
            __min: 60,
          },
          // Debounce window for the stuck-dispatch alert. Default 1h: a
          // stuck dispatch only fires the alert at most once per hour, even
          // if every poll still sees the same stuck state.
          stuck_dispatch_alert_debounce_ms: {
            __type: TYPE_INT,
            __default: 3600000,
            __min: 60000,
          },
          // First-pass reviewer pool concurrency cap. Maximum number of
          // concurrent first-pass review processes the watcher may have in
          // flight. Currently env-only via `ADVERSARIAL_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT`;
          // promoting it gives operators a CFG anchor so the value is visible
          // in `agent-os config doctor`. Null = use the watcher's internal
          // default (currently dynamic based on review surface).
          first_pass_reviewer_pool_max_concurrent_reviewers: {
            __type: TYPE_INT,
            __default: null,
            __nullable: true,
            __min: 1,
          },
        },
      },
      // Subprocess timeouts for the follow-up pipeline's calls into `hq`.
      // Promoted from hardcoded constants in follow-up-merge-agent.mjs so
      // operators can tune wall-clock budgets per-host.
      follow_up: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          hq_worker_tear_down_subprocess_timeout_ms: {
            __type: TYPE_INT,
            __default: 60000,
            __min: 1000,
          },
          hq_dispatch_subprocess_timeout_ms: {
            __type: TYPE_INT,
            __default: 90000,
            __min: 1000,
          },
        },
      },
      // Dispatch-time defaults consulted by hq when no `--worker-class` is
      // passed. The Python sibling at
      // `platform/agent-os-config/src/agent_os_config/__init__.py` is the
      // canonical schema; this Node mirror exists so the adversarial-watcher
      // doesn't crash-loop the moment an operator writes `dispatch:` into
      // the top-level config.yaml (CFG-01 strict-schema parity rule).
      //
      // The prior code default for `default_worker_class_for_task_kind` in
      // `modules/worker-pool/lib/python/cwp_dispatch/registry.py` was a hard
      // `claude-code` regardless of task_kind. Coding-family tasks now
      // default to `codex` (independent OpenAI budget); merge-family tasks
      // default to `merge-agent` for schema completeness — the actual merge
      // dispatch path hard-routes to merge-agent without consulting this
      // function.
      //
      // YAML keys use underscores (not hyphens) because the loader's alias
      // machinery expects dotted ASCII paths; the consumer-side resolver
      // translates hyphenated task_kind values (`merge-conflict-resolution`
      // etc.) to the underscore form at lookup time.
      dispatch: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          default_worker_class_by_task_kind: {
            __type: TYPE_DICT,
            __strict: true,
            __keys: {
              coding: {
                __type: TYPE_STRING,
                __default: 'codex',
                __enum: ENUM_DISPATCH_DEFAULT_WORKER_CLASS,
              },
              research: {
                __type: TYPE_STRING,
                __default: 'codex',
                __enum: ENUM_DISPATCH_DEFAULT_WORKER_CLASS,
              },
              drafting: {
                __type: TYPE_STRING,
                __default: 'codex',
                __enum: ENUM_DISPATCH_DEFAULT_WORKER_CLASS,
              },
              analysis: {
                __type: TYPE_STRING,
                __default: 'codex',
                __enum: ENUM_DISPATCH_DEFAULT_WORKER_CLASS,
              },
              other: {
                __type: TYPE_STRING,
                __default: 'codex',
                __enum: ENUM_DISPATCH_DEFAULT_WORKER_CLASS,
              },
              merge: {
                __type: TYPE_STRING,
                __default: 'merge-agent',
                __enum: ENUM_DISPATCH_DEFAULT_WORKER_CLASS,
              },
              merge_conflict_resolution: {
                __type: TYPE_STRING,
                __default: 'merge-agent',
                __enum: ENUM_DISPATCH_DEFAULT_WORKER_CLASS,
              },
              merge_comment_only_followups: {
                __type: TYPE_STRING,
                __default: 'merge-agent',
                __enum: ENUM_DISPATCH_DEFAULT_WORKER_CLASS,
              },
              merge_agent_failure_recovery: {
                __type: TYPE_STRING,
                __default: 'codex',
                __enum: ENUM_DISPATCH_DEFAULT_WORKER_CLASS,
              },
            },
          },
        },
      },
    },
  };
}

// -------- Env alias table --------------------------------------------------

function postgresRuntimeAlias(value) {
  return value.trim().toLowerCase() === 'on' ? 'postgres' : 'sqlite';
}

const identity = (v) => v;

export const ENV_ALIASES = {
  'update.channel': {
    canonical: 'AGENT_OS_UPDATE_CHANNEL',
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
  'remediation.reconciliation_max_active_age_ms_before_abandon': {
    canonical: 'AGENT_OS_REMEDIATION_RECONCILIATION_MAX_ACTIVE_AGE_MS_BEFORE_ABANDON',
    aliases: [['ADVERSARIAL_REMEDIATION_RECONCILIATION_MAX_ACTIVE_MS', identity]],
  },
  'reviewer.timeout_ms': {
    canonical: 'AGENT_OS_REVIEWER_TIMEOUT_MS',
    aliases: [['ADVERSARIAL_REVIEWER_TIMEOUT_MS', identity]],
  },
  'reviewer.no_progress_timeout_ms': {
    canonical: 'AGENT_OS_REVIEWER_NO_PROGRESS_TIMEOUT_MS',
    aliases: [['ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS', identity]],
  },
  'reviewer.gemini.mode': {
    canonical: 'AGENT_OS_REVIEWER_GEMINI_MODE',
    aliases: [['ADVERSARIAL_REVIEW_GEMINI_REVIEWER_MODE', identity]],
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
    aliases: [['ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR', identity]],
  },
  'roles.merge_agent_worker_class': {
    canonical: 'AGENT_OS_ROLES_MERGE_AGENT_WORKER_CLASS',
    aliases: [['ADVERSARIAL_REVIEW_MERGE_AGENT_WORKER_CLASS', identity]],
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
  'roles.adversarial.orchestration_mode': {
    canonical: 'AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE',
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
  'operator.email': {
    canonical: 'AGENT_OS_OPERATOR_EMAIL',
    aliases: [],
  },
  'operator.full_name': {
    canonical: 'AGENT_OS_OPERATOR_FULL_NAME',
    aliases: [],
  },
  'github.workspace_email_domain': {
    canonical: 'AGENT_OS_GITHUB_WORKSPACE_EMAIL_DOMAIN',
    aliases: [['AGENT_OS_GITHUB_ORG_EMAIL_DOMAIN', identity]],
  },
  'linear.team_name': {
    canonical: 'AGENT_OS_LINEAR_TEAM_NAME',
    aliases: [],
  },
  'linear.issue_prefix': {
    canonical: 'AGENT_OS_LINEAR_ISSUE_PREFIX',
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
  'tailscale.daily_driver_ip': {
    canonical: 'AGENT_OS_TAILSCALE_DAILY_DRIVER_IP',
    aliases: [],
  },
  'tailscale.ipad_ip': {
    canonical: 'AGENT_OS_TAILSCALE_IPAD_IP',
    aliases: [],
  },
  'tailscale.iphone_ip': {
    canonical: 'AGENT_OS_TAILSCALE_IPHONE_IP',
    aliases: [],
  },
  'launchd.label_prefix': {
    canonical: 'AGENT_OS_LAUNCHD_LABEL_PREFIX',
    aliases: [],
  },
  'openclaw.install_root': {
    // OSR-04b: ACPX discovery alias; see schema comment above.
    canonical: 'AGENT_OS_OPENCLAW_INSTALL_ROOT',
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
  'feature_flags.live_steer_allow_unvetted': {
    canonical: 'AGENT_OS_FEATURE_FLAGS_LIVE_STEER_ALLOW_UNVETTED',
    aliases: [['HQ_LIVE_STEER_ALLOW_UNVETTED', identity]],
  },
  'feature_flags.claude_code_ambient_auth_fallback': {
    canonical: 'AGENT_OS_FEATURE_FLAGS_CLAUDE_CODE_AMBIENT_AUTH_FALLBACK',
    aliases: [['CLAUDE_CODE_ALLOW_AMBIENT_AUTH_FALLBACK', identity]],
  },
  'feature_flags.merge_agent_failure_recovery_disable': {
    canonical: 'AGENT_OS_FEATURE_FLAGS_MERGE_AGENT_FAILURE_RECOVERY_DISABLE',
    aliases: [['MERGE_AGENT_FAILURE_RECOVERY_DISABLE', identity]],
  },
  'feature_flags.merge_agent_final_pass_on_request_changes': {
    canonical: 'AGENT_OS_FEATURE_FLAGS_MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES',
    aliases: [['MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES', identity]],
  },
  'feature_flags.allow_missing_alert_to': {
    canonical: 'AGENT_OS_FEATURE_FLAGS_ALLOW_MISSING_ALERT_TO',
    aliases: [['ADVERSARIAL_REVIEW_ALLOW_MISSING_ALERT_TO', identity]],
  },
  'feature_flags.resume_context_envelope': {
    canonical: 'AGENT_OS_FEATURE_FLAGS_RESUME_CONTEXT_ENVELOPE',
    aliases: [],
  },
};

// -------- YAML 1.2 strict-bool loader --------------------------------------

// js-yaml's DEFAULT_SCHEMA is already YAML 1.2 — `yes`/`no`/`on`/`off`
// parse as strings out of the box. We re-affirm here by NOT using
// JS_COMPAT_SCHEMA. The schema-validator catches them downstream.

function parseYaml(text, sourcePath) {
  try {
    return yaml.load(text, {
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
    const line = extractYamlErrorLine(err);
    const where = line !== null ? `${sourcePath}:${line}` : sourcePath;
    const reason = err && err.reason ? err.reason : (err && err.message) || String(err);
    throw new AgentOSConfigError(
      `malformed YAML in ${where}: ${reason}`,
      { source: where },
    );
  }
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

function checkLeaf(value, schema, keyPath, source) {
  const expected = schema.__type;
  if (value === null || value === undefined) {
    if (schema.__nullable) return null;
    // Explicit null/undefined (i.e. user wrote `key: ~` or `key:`) must
    // fail loud — it is NOT the same as "key omitted, use default".
    // Defaults are seeded from buildDefaultsDict and never flow through
    // checkLeaf; reaching here means the value was set in YAML/env/CLI.
    throw new AgentOSConfigError(
      `${keyPath}: expected ${expected}, got null`,
      { key: keyPath, expected, got: null, source },
    );
  }
  if (expected === TYPE_BOOL) {
    if (typeof value !== 'boolean') {
      const instr = typeof value === 'string'
        ? 'use `true` or `false` (YAML 1.2 booleans only)'
        : 'boolean required';
      const shown = typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
      throw new AgentOSConfigError(
        `${keyPath}: expected bool, got ${jsTypeName(value)} (${shown}); ${instr}`,
        { key: keyPath, expected: 'bool', got: value, source },
      );
    }
  } else if (expected === TYPE_INT) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      throw new AgentOSConfigError(
        `${keyPath}: expected int, got ${jsTypeName(value)} (${JSON.stringify(value)})`,
        { key: keyPath, expected: 'int', got: value, source },
      );
    }
  } else if (expected === TYPE_FLOAT) {
    // Non-finite floats (Infinity/-Infinity) fail loud for parity with the
    // int guard; env/CLI injection should not smuggle sentinel numbers in.
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new AgentOSConfigError(
        `${keyPath}: expected float, got ${jsTypeName(value)} (${JSON.stringify(value)})`,
        { key: keyPath, expected: 'float', got: value, source },
      );
    }
  } else if (expected === TYPE_STRING) {
    if (typeof value !== 'string') {
      throw new AgentOSConfigError(
        `${keyPath}: expected string, got ${jsTypeName(value)} (${JSON.stringify(value)})`,
        { key: keyPath, expected: 'string', got: value, source },
      );
    }
    if (schema.__pattern && !(new RegExp(schema.__pattern).test(value))) {
      const expectedPattern = schema.__pattern_description || schema.__pattern;
      throw new AgentOSConfigError(
        `${keyPath}: value ${JSON.stringify(value)} does not match ${expectedPattern}`,
        { key: keyPath, expected: expectedPattern, got: value, source },
      );
    }
  } else if (expected === TYPE_LIST) {
    if (!Array.isArray(value)) {
      throw new AgentOSConfigError(
        `${keyPath}: expected list, got ${jsTypeName(value)} (${JSON.stringify(value)})`,
        { key: keyPath, expected: 'list', got: value, source },
      );
    }
    const itemSchema = schema.__item || {};
    return value.map((item, index) => checkLeaf(item, itemSchema, `${keyPath}[${index}]`, source));
  }
  if (schema.__enum && !schema.__enum.includes(value)) {
    throw new AgentOSConfigError(
      `${keyPath}: value ${JSON.stringify(value)} not in allowlist ${fmtEnum(schema.__enum)}`,
      {
        key: keyPath,
        expected: `one of ${fmtEnum(schema.__enum)}`,
        allowed: schema.__enum,
        got: value,
        source,
      },
    );
  }
  if (typeof value === 'number') {
    if (schema.__min !== undefined && value < schema.__min) {
      throw new AgentOSConfigError(
        `${keyPath}: value ${value} below minimum ${schema.__min}`,
        {
          key: keyPath,
          expected: `>= ${schema.__min}`,
          got: value,
          source,
        },
      );
    }
    if (schema.__max !== undefined && value > schema.__max) {
      throw new AgentOSConfigError(
        `${keyPath}: value ${value} above maximum ${schema.__max}`,
        {
          key: keyPath,
          expected: `<= ${schema.__max}`,
          got: value,
          source,
        },
      );
    }
  }
  if (schema.__normalize && Object.prototype.hasOwnProperty.call(schema.__normalize, value)) {
    return schema.__normalize[value];
  }
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

function validateDictPresentKeysOnly(
  doc,
  schema,
  keyPath,
  source,
  lineMap,
  tolerateUnknown = false,
) {
  if (doc === null || doc === undefined) return {};
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new AgentOSConfigError(
      `${keyPath || '(root)'}: expected mapping, got ${jsTypeName(doc)}`,
      {
        key: keyPath || '(root)',
        expected: 'mapping',
        got: jsTypeName(doc),
        source,
      },
    );
  }
  const allowed = schema.__keys || {};
  const extraSchema = schema.__extra_keys_schema || null;
  const strict = schema.__strict !== false;

  if (strict) {
    for (const rawKey of Object.keys(doc)) {
      if (rawKey.startsWith('__')) continue;
      if (!(rawKey in allowed)) {
        const lineSrc = annotateLine(source, lineMap, rawKey);
        const near = nearestValidKey(rawKey, Object.keys(allowed));
        const full = keyPath ? `${keyPath}.${rawKey}` : rawKey;
        const hint = near ? ` did you mean ${keyPath ? keyPath + '.' : ''}${JSON.stringify(near)}?` : '';
        if (tolerateUnknown && keyPath) {
          // Operator-local override (config.local.yaml / module *.local.yaml):
          // a NESTED unknown key under a root this reader owns is dropped, not
          // raised. This is the Node mirror of agent-os#1743: the local
          // override is live-edited and read by multiple daemons (python/shell
          // CFG loader + this Node adversarial loader) that may each be at a
          // different deployed schema version during a rollout, so a premature
          // key must be a no-op here instead of a watcher crash-loop. Debug-only
          // (never stderr by default — see agent-os#1738 warning-leak lesson).
          configDebugLog(
            `dropping unknown key ${JSON.stringify(full)} from local override` +
              `${source ? ` (${source})` : ''} — not in this reader's schema`,
          );
          continue;
        }
        throw new AgentOSConfigError(
          `${full}: unknown key (strict schema)${hint}`,
          {
            key: full,
            expected: `one of ${JSON.stringify(Object.keys(allowed).sort())}`,
            got: rawKey,
            source: lineSrc,
          },
        );
      }
    }
  }

  const out = {};
  for (const [childKey, raw] of Object.entries(doc)) {
    if (childKey.startsWith('__')) continue;
    if (!(childKey in allowed)) {
      // Non-strict dicts are extension points. If they provide an
      // __extra_keys_schema, arbitrary child keys are validated against it
      // (keyed maps such as apps.<app-id>); otherwise pass subtrees through
      // verbatim (e.g. submodules).
      if (!strict && extraSchema) {
        const full = keyPath ? `${keyPath}.${childKey}` : childKey;
        const childSource = annotateLine(source, lineMap, childKey);
        if (extraSchema.__type === TYPE_DICT) {
          const validatedExtra = validateDictPresentKeysOnly(
            raw,
            extraSchema,
            full,
            childSource,
            null,
            tolerateUnknown,
          );
          // Keyed-map defaults are backfilled after all layers merge so default
          // provenance can distinguish file-declared entries from env-created
          // entries without treating app ids as dotted paths.
          out[childKey] = validatedExtra;
        } else {
          out[childKey] = checkLeaf(raw, extraSchema, full, childSource);
        }
      } else if (!strict) {
        out[childKey] = raw;
      }
      continue;
    }
    const childSchema = allowed[childKey];
    const full = keyPath ? `${keyPath}.${childKey}` : childKey;
    const childSource = annotateLine(source, lineMap, childKey);
    if (childSchema.__type === TYPE_DICT) {
      out[childKey] = validateDictPresentKeysOnly(
        raw,
        childSchema,
        full,
        childSource,
        null,
        tolerateUnknown,
      );
    } else {
      out[childKey] = checkLeaf(raw, childSchema, full, childSource);
    }
  }
  return out;
}

export function validateSchema(
  doc,
  {
    source = null,
    rawText = null,
    tolerateForeignTopLevelSections = false,
    tolerateNestedUnknownLocalKeys = false,
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
  const knownTop = schema.__keys || {};
  const filtered = filterForeignTopLevelSections(doc, knownTop, {
    source,
    tolerateForeignTopLevelSections,
  });
  return validateDictPresentKeysOnly(
    filtered,
    schema,
    '',
    source,
    lineMap,
    tolerateNestedUnknownLocalKeys,
  );
}

function filterForeignTopLevelSections(
  doc,
  knownTop,
  { source = null, tolerateForeignTopLevelSections = false } = {},
) {
  // Tolerant top-level is scoped to Layer-4 multi-reader local siblings.
  // The public validator and checked-in Layer-3 config.yaml remain strict so
  // this reader cannot silently diverge from sibling CFG loaders.
  const filtered = {};
  for (const topKey of Object.keys(doc || {})) {
    if (topKey === 'version' || topKey.startsWith('__') || topKey in knownTop) {
      filtered[topKey] = doc[topKey];
    } else if (
      tolerateForeignTopLevelSections &&
      isLocalYamlSource(source) &&
      FOREIGN_TOP_LEVEL_SECTIONS.has(topKey)
    ) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(
          `[adversarial-config] ignoring unknown top-level key ${JSON.stringify(topKey)}` +
            `${source ? ` from ${source}` : ''} — not in this reader's schema ` +
            `(owned by another config reader)`,
        );
      }
    } else {
      filtered[topKey] = doc[topKey];
    }
  }
  return filtered;
}

// -------- Module file validation -------------------------------------------

function flatten(doc, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith('__')) continue;
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (Object.keys(value).length > 0) {
        Object.assign(out, flatten(value, full));
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
    tolerateForeignTopLevelSections = false,
    tolerateNestedUnknownLocalKeys = false,
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
  const moduleTop = {};
  for (const [k, v] of Object.entries(schema.__keys)) {
    if (k !== 'version') moduleTop[k] = v;
  }
  const filteredDoc = filterForeignTopLevelSections(doc, moduleTop, {
    source,
    tolerateForeignTopLevelSections,
  });
  const aliasesRaw = filteredDoc.__aliases || {};
  if (typeof aliasesRaw !== 'object' || Array.isArray(aliasesRaw)) {
    throw new AgentOSConfigError(
      `${source}: __aliases must be a mapping`,
      { key: '__aliases', expected: 'mapping', got: jsTypeName(aliasesRaw), source },
    );
  }
  const aliases = {};
  const schemaForAliasCheck = schemaV1();
  for (const [moduleKey, canonicalKey] of Object.entries(aliasesRaw)) {
    if (typeof moduleKey !== 'string' || typeof canonicalKey !== 'string') {
      throw new AgentOSConfigError(
        `${source}: __aliases entries must map string→string (${JSON.stringify(moduleKey)}→${JSON.stringify(canonicalKey)})`,
        { source },
      );
    }
    if (!isValidSchemaPath(schemaForAliasCheck, canonicalKey)) {
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
  for (const [k, v] of Object.entries(filteredDoc)) {
    if (k !== '__aliases') body[k] = v;
  }

  const rawFlat = flatten(body);
  for (const [moduleKey, canonicalKey] of Object.entries(aliases)) {
    if (moduleKey in rawFlat && canonicalKey in rawFlat) {
      const mv = rawFlat[moduleKey];
      const cv = rawFlat[canonicalKey];
      if (!sameValue(mv, cv)) {
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
    const canonical = aliases[key] || key;
    canonicalFlat[canonical] = value;
  }

  const canonicalBody = {};
  for (const [dotted, value] of Object.entries(canonicalFlat)) {
    setLeaf(canonicalBody, dotted, value);
  }

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
    tolerateNestedUnknownLocalKeys,
  );
  return { validated, aliases };
}

function sameValue(a, b) {
  // Order-independent deep equality so dict-typed alias values don't trigger
  // spurious "same-file alias conflict" errors on key-order coincidence.
  return isDeepStrictEqual(a, b);
}

// -------- Defaults builder -------------------------------------------------

function buildDefaultsDict(schema) {
  const out = {};
  for (const [key, child] of Object.entries(schema.__keys || {})) {
    if (key === 'version') continue;
    if (child.__type === TYPE_DICT) {
      const nested = buildDefaultsDict(child);
      out[key] = nested;
    } else if (Object.prototype.hasOwnProperty.call(child, '__default')) {
      out[key] = child.__default;
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
    if (!Number.isInteger(n)) {
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
    return value.split(',').map((part) => part.trim()).filter(Boolean);
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

// -------- AgentOSConfig (public class) -------------------------------------

export class AgentOSConfig {
  constructor({ values, trace, sources, schema }) {
    this.values = values;
    this._trace = trace;
    this.sources = sources;
    this.schema = schema;
  }

  get(key, defaultValue = null) {
    const result = getLeaf(this.values, key);
    if (result === MISSING) return defaultValue;
    return result;
  }

  resolutionTrace(key) {
    const entries = this._trace[key] || [];
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
    return {
      enabled: this.get('roles.adversarial.merge_authority.enabled', false),
      workerClass: this.get(
        'roles.adversarial.merge_authority.worker_class',
        'hammer',
      ),
      mergeMethod: this.get(
        'roles.adversarial.merge_authority.merge_method',
        'squash',
      ),
      strictNonBlockingRemediation: this.get(
        'roles.adversarial.merge_authority.strict_non_blocking_remediation',
        true,
      ),
      autoHammerOnEligibilityMiss: this.get(
        'roles.adversarial.merge_authority.auto_hammer_on_eligibility_miss',
        false,
      ),
      dispatchTimeoutMs: this.get(
        'roles.adversarial.merge_authority.dispatch_timeout_ms',
        300000,
      ),
      eligibility: {
        riskClasses: [...this.get(
          'roles.adversarial.merge_authority.eligibility.risk_classes',
          ['low'],
        )],
        fastMergeLabels: [...this.get(
          'roles.adversarial.merge_authority.eligibility.fast_merge_labels',
          ['fast-merge:test-fixtures', 'fast-merge:docs'],
        )],
        reviewerFamilyPolicy: this.get(
          'roles.adversarial.merge_authority.eligibility.reviewer_family_policy',
          'audit_existing_gate_contract',
        ),
        ciGreenClassifier: this.get(
          'roles.adversarial.merge_authority.eligibility.ci_green_classifier',
          'existingAdversarialMergeClassifier',
        ),
        highRiskRequiresTwoKey: this.get(
          'roles.adversarial.merge_authority.eligibility.high_risk_requires_two_key',
          true,
        ),
      },
      branchProtection: {
        requiredGateContextSource: this.get(
          'roles.adversarial.merge_authority.branch_protection.required_gate_context_source',
          'resolveGateStatusContext',
        ),
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
}

// -------- Public loader API ------------------------------------------------

export function loadConfig({
  topPath = null,
  modulePaths = [],
  env = null,
  cliOverrides = null,
} = {}) {
  const envView = env || process.env;
  checkDeprecatedEnvVars(envView);
  const schema = schemaV1();

  const defaults = buildDefaultsDict(schema);
  const merged = {};
  const trace = {};
  for (const [dotted, value] of Object.entries(flatten(defaults))) {
    setLeaf(merged, dotted, value);
    (trace[dotted] = trace[dotted] || []).push({
      source: 'code-default',
      value,
      path: null,
    });
  }

  // --- Layer 2: module files ---
  const moduleAliases = {};
  for (const rawPath of modulePaths) {
    const { doc, rawText } = loadLayerFile(rawPath);
    if (doc === null || doc === undefined) continue;
    const { validated, aliases } = validateModuleDoc(doc, rawPath, rawText);
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
    for (const { dotted, path, value } of flattenSchemaLeaves(validated, schema)) {
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
    const validated = validateSchema(topDoc, { source: topPathResolved, rawText: topRaw });
    for (const { dotted, path, value } of flattenSchemaLeaves(validated, schema)) {
      if (dotted === 'version') continue;
      setLeafPath(merged, path, value);
      (trace[dotted] = trace[dotted] || []).push({
        source: 'top',
        value,
        path: topPathResolved,
      });
    }
  }

  // --- Layer 4: *.local.yaml siblings ---
  // localSibling returns null for non-yaml/yml top paths; we skip Layer 4
  // entirely for those rather than synthesize a `${name}.local` sibling.
  const localSources = [];
  const topLocal = localSibling(topPathResolved);
  if (topLocal && existsSync(topLocal)) localSources.push({ path: topLocal, kind: 'top' });
  for (const rawPath of modulePaths) {
    const moduleLocal = localSibling(rawPath);
    if (moduleLocal && existsSync(moduleLocal)) {
      localSources.push({ path: moduleLocal, kind: 'module' });
    }
  }
  for (const { path: local, kind } of localSources) {
    const { doc: localDoc, rawText: localRaw } = loadLayerFile(local);
    if (localDoc === null || localDoc === undefined || isEmptyDoc(localDoc)) continue;
    let validatedLocal;
    if (
      localDoc &&
      typeof localDoc === 'object' &&
      !Array.isArray(localDoc) &&
      'version' in localDoc
    ) {
      validatedLocal = validateSchema(localDoc, {
        source: local,
        rawText: localRaw,
        tolerateForeignTopLevelSections: true,
        tolerateNestedUnknownLocalKeys: true,
      });
    } else {
      const { validated, aliases } = validateModuleDoc(localDoc, local, localRaw, {
        tolerateForeignTopLevelSections: kind === 'top',
        tolerateNestedUnknownLocalKeys: true,
      });
      validatedLocal = validated;
      for (const [moduleKey, canonicalKey] of Object.entries(aliases)) {
        if (!(moduleKey in moduleAliases)) moduleAliases[moduleKey] = canonicalKey;
      }
    }
    for (const { dotted, path, value } of flattenSchemaLeaves(validatedLocal, schema)) {
      if (dotted === 'version') continue;
      setLeafPath(merged, path, value);
      (trace[dotted] = trace[dotted] || []).push({
        source: `local:${local}`,
        value,
        path: local,
      });
    }
  }

  // --- Layer 5: env vars ---
  const appIdsBeforeEnv = ownMapEntryIds(getLeaf(merged, 'apps'));
  const dynamicAppIds = dynamicAppEnvIds(envView);
  const envAliasEntries = [
    ...Object.entries(ENV_ALIASES),
    ...dynamicAppEnvAliases(envView),
  ];
  for (const [key, info] of envAliasEntries) {
    const leaf = schemaLeaf(schema, key);
    if (leaf === null) continue;
    const [winning, rawValue] = checkEnvOverlap(
      key,
      info.canonical,
      info.aliases,
      envView,
    );
    if (winning === null) continue;
    let value;
    if (typeof rawValue === 'string') {
      value = coerceEnvValue(key, rawValue, leaf, `env:${winning}`);
    } else {
      value = rawValue;
    }
    value = checkLeaf(value, leaf, key, `env:${winning}`);
    if (info.writePath) {
      setLeafPath(merged, info.writePath, value, { dottedKey: key });
    } else {
      setLeaf(merged, key, value);
    }
    (trace[key] = trace[key] || []).push({
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
      setLeaf(merged, key, checked);
      (trace[key] = trace[key] || []).push({
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

  const sources = {};
  for (const [key, entries] of Object.entries(trace)) {
    sources[key] = entries[entries.length - 1].source;
  }

  return new AgentOSConfig({ values: merged, trace, sources, schema });
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
// the call + each module's `*.local.yaml` sibling.
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
// watched files (2 + 2·N syscalls) even on cache hits — net win vs.
// a full YAML parse, but not free. Don't call in tight inner loops
// outside the documented per-tick / per-job hot paths.
const _CACHE_MAX_SLOTS = 16;
const _configCache = new Map();
const _configSignatures = new Map();

function _watchedPathsForCall({ topPath, modulePaths, env }) {
  const envView = env || process.env;
  const resolvedTop = topPath || envView.AGENT_OS_CONFIG_PATH || DEFAULT_TOP_LEVEL_PATH;
  const watched = [resolvedTop];
  const topLocal = localSibling(resolvedTop);
  if (topLocal) watched.push(topLocal);
  for (const modulePath of modulePaths || []) {
    watched.push(modulePath);
    const moduleLocal = localSibling(modulePath);
    if (moduleLocal) watched.push(moduleLocal);
  }
  return watched;
}

function _currentSignature({ topPath, modulePaths, env }) {
  const watched = _watchedPathsForCall({ topPath, modulePaths, env });
  const parts = [];
  for (const path of watched) {
    try {
      const st = statSync(path);
      parts.push(`${path}|${st.mtimeMs}|${st.ino}`);
    } catch {
      parts.push(`${path}|null|null`);
    }
  }
  return parts.join('::');
}

function _cacheKeyFor({ topPath, modulePaths, env }) {
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
  envAliases.sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    resolvedTopPath: resolvedTop,
    modulePaths: [...(modulePaths || [])],
    envAliases,
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

function _ensureFreshConfig({ topPath, modulePaths, env } = {}) {
  const cacheKey = _cacheKeyFor({ topPath, modulePaths, env });
  const sig = _currentSignature({ topPath, modulePaths, env });
  const cached = _configCache.get(cacheKey);
  if (cached === undefined || _configSignatures.get(cacheKey) !== sig) {
    const fresh = loadConfig({ topPath, modulePaths, env });
    _configCache.set(cacheKey, fresh);
    _configSignatures.set(cacheKey, sig);
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

export function getConfig(key, defaultValue = null) {
  return _ensureFreshConfig().get(key, defaultValue);
}

export function resolutionTrace(key) {
  return _ensureFreshConfig().resolutionTrace(key);
}

export function resetConfigCache() {
  _configCache.clear();
  _configSignatures.clear();
}
