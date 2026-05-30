// role-config — file→env cascade for the operator-facing role knobs
// (`roles.reviewer`, `roles.remediator`, `roles.merge_agent_worker_class`).
//
// CFG-02 layers config.yaml UNDER env so operators can pin roles in a
// checked-in file and use env vars only as host-specific overrides. The
// resolution order is the contract from SPEC §3:
//
//   code default → module config.yaml → top-level config.yaml
//   → *.local.yaml → env vars → CLI flag
//
// All three role resolvers go through `loadRoleConfig` so the env-alias
// conflict detection (§10.1) and top-level-overrides-module alias
// resolution (§10.2) are applied uniformly. The loader does the schema
// enforcement; this helper re-shapes the error so legacy env-var callers
// continue to see the env var name in the message — operators who set
// `ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR=gemini` get told what they did
// wrong, not just told that "roles.remediator" is invalid.
//
// Tests can inject a custom `loaderImpl` (see test/role-config.test.mjs)
// or override `topPath` to make the cascade hermetic against the real
// `~/agent-os/config.yaml` on the host.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AgentOSConfigError,
  loadConfig,
} from './config-loader.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Canonical path of the adversarial-review module's checked-in config.yaml.
export const MODULE_CONFIG_PATH = join(ROOT, 'config.yaml');

// Env-var labels surfaced in re-shaped error messages. Keep these aligned
// with `ENV_ALIASES` in config-loader.mjs.
const CANONICAL_ENV_BY_KEY = Object.freeze({
  'roles.reviewer': 'AGENT_OS_ROLES_REVIEWER',
  'roles.remediator': 'AGENT_OS_ROLES_REMEDIATOR',
  'roles.merge_agent_worker_class': 'AGENT_OS_ROLES_MERGE_AGENT_WORKER_CLASS',
});

const LEGACY_ENV_BY_KEY = Object.freeze({
  'roles.reviewer': 'ADVERSARIAL_REVIEW_DEFAULT_REVIEWER',
  'roles.remediator': 'ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR',
  'roles.merge_agent_worker_class': 'ADVERSARIAL_REVIEW_MERGE_AGENT_WORKER_CLASS',
});

// When the loader rejects a value sourced from env, re-shape the error so
// the message text leads with the env var name the operator actually set.
// This preserves the existing operator-facing contract — "FATAL config:
// ADVERSARIAL_REVIEW_DEFAULT_REVIEWER must be one of: ..." — while still
// carrying the loader's canonical-key + allowlist information.
function reshapeLoaderError(err, contextKey) {
  if (!(err instanceof AgentOSConfigError)) return err;
  const source = typeof err.source === 'string' ? err.source : '';
  if (!source.startsWith('env:')) return err;
  const envName = source.slice('env:'.length);
  const canonicalKey = err.key || contextKey;
  const allowed = err.expected && /^one of /.test(err.expected)
    ? err.expected.slice('one of '.length)
    : err.expected;
  const got = err.got !== null && err.got !== undefined
    ? JSON.stringify(err.got)
    : '<unset>';
  const message = `${envName} must be one of: ${allowedForLegacyMessage(canonicalKey, allowed)}; got ${got} (canonical key: ${canonicalKey})`;
  const wrapped = new AgentOSConfigError(message, {
    key: canonicalKey,
    expected: err.expected,
    got: err.got,
    source: err.source,
  });
  wrapped.cause = err;
  wrapped.envName = envName;
  return wrapped;
}

// The loader's enum is JSON-formatted (e.g. `["claude-code", "codex", ...]`);
// flatten to the bare comma-separated form that existing error-message
// regexes expect (e.g. `merge-agent, codex, claude-code`).
function allowedForLegacyMessage(canonicalKey, allowedRaw) {
  if (!allowedRaw) return '<unknown>';
  if (typeof allowedRaw !== 'string') return String(allowedRaw);
  const stripped = allowedRaw.replace(/^\[/, '').replace(/\]$/, '');
  return stripped
    .split(',')
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .join(', ');
}

// The role-pin env vars (both canonical and legacy aliases) treat empty
// / whitespace-only values as "unset". This preserves the back-compat
// behavior of the pre-CFG-02 resolvers — operators have long relied on
// `ENV=` and `unset ENV` being equivalent for these knobs. Bool/int env
// keys still fail loud on empty-string per CFG-01's contract; this only
// affects the string-typed role pins.
const ROLE_ENV_NAMES_TO_BLANK_PRUNE = new Set([
  'AGENT_OS_ROLES_REVIEWER',
  'ADVERSARIAL_REVIEW_DEFAULT_REVIEWER',
  'AGENT_OS_ROLES_REMEDIATOR',
  'ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR',
  'AGENT_OS_ROLES_MERGE_AGENT_WORKER_CLASS',
  'ADVERSARIAL_REVIEW_MERGE_AGENT_WORKER_CLASS',
]);

function pruneBlankRoleEnvVars(env) {
  let pruned = null;
  for (const name of ROLE_ENV_NAMES_TO_BLANK_PRUNE) {
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      const raw = env[name];
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        if (pruned === null) pruned = { ...env };
        delete pruned[name];
      }
    }
  }
  return pruned !== null ? pruned : env;
}

// loadRoleConfig — single entry point for role resolvers. Returns the
// fully-merged AgentOSConfig (file + env layered) with the adversarial-
// review module config.yaml plugged into the modulePaths slot.
//
// Tests inject `loaderImpl` to stub `loadConfig`, OR pass an explicit
// `topPath: '/dev/null'` to bypass `~/agent-os/config.yaml` on the host.
// `contextKey` is the canonical key the caller cares about — used only
// for error-shaping when the loader rejects an env-sourced value.
export function loadRoleConfig({
  env = process.env,
  topPath,
  modulePaths,
  loaderImpl = loadConfig,
  contextKey = null,
} = {}) {
  const modulePathsResolved = modulePaths || [MODULE_CONFIG_PATH];
  const envPruned = pruneBlankRoleEnvVars(env);
  try {
    return loaderImpl({
      topPath,
      modulePaths: modulePathsResolved,
      env: envPruned,
    });
  } catch (err) {
    throw reshapeLoaderError(err, contextKey);
  }
}

// resolveDefaultRemediator — returns the operator-pinned remediation
// worker class, or null when no pin is in effect (the per-builder-tag
// adversarial routing in pickRemediationWorkerClass then applies). The
// loader normalizes legacy aliases and enforces the §10.3 allowlist
// before this function sees the value.
export function resolveDefaultRemediator({
  env = process.env,
  topPath,
  loaderImpl,
} = {}) {
  const cfg = loadRoleConfig({
    env,
    topPath,
    loaderImpl,
    contextKey: 'roles.remediator',
  });
  const value = cfg.get('roles.remediator');
  if (!value || value === 'adversarial') return null;
  return value;
}

// resolveDefaultReviewer — returns the operator-pinned reviewer route
// (object with reviewerModel + botTokenEnv), or null when no pin is in
// effect (the per-tag cross-model routing in ROUTE_BY_BUILDER_CLASS then
// applies). The loader normalizes `claude` → `claude-code` before this
// function sees the value; we then map back to the legacy `claude` family
// for the route table.
export function resolveDefaultReviewer({
  env = process.env,
  topPath,
  loaderImpl,
  reviewerRouteByModel,
} = {}) {
  const cfg = loadRoleConfig({
    env,
    topPath,
    loaderImpl,
    contextKey: 'roles.reviewer',
  });
  const value = cfg.get('roles.reviewer');
  if (!value || value === 'adversarial') return null;
  const modelKey = value === 'claude-code' ? 'claude' : value;
  const route = reviewerRouteByModel?.[modelKey];
  if (!route) {
    throw new AgentOSConfigError(
      `roles.reviewer: resolved value ${JSON.stringify(value)} has no route entry`,
      { key: 'roles.reviewer', expected: 'known reviewer model', got: value },
    );
  }
  return route;
}

// resolveDefaultMergeAgentWorkerClass — returns the merge-agent worker
// class (always a real value — default `merge-agent`). The loader enforces
// the §10.3 allowlist and applies the §10.2 module-to-top alias.
export function resolveDefaultMergeAgentWorkerClass({
  env = process.env,
  topPath,
  loaderImpl,
} = {}) {
  const cfg = loadRoleConfig({
    env,
    topPath,
    loaderImpl,
    contextKey: 'roles.merge_agent_worker_class',
  });
  return cfg.get('roles.merge_agent_worker_class');
}

// validateStartupRoleConfig — boot-time validator. Daemons (watcher,
// follow-up-remediation, follow-up-merge-agent) call this on startup so a
// schema error in config.yaml OR a bad env value fails loud at boot with
// a `FATAL config:` banner, not silently hours later at first dispatch.
export function validateStartupRoleConfig({
  env = process.env,
  topPath,
  loaderImpl,
} = {}) {
  loadRoleConfig({
    env,
    topPath,
    loaderImpl,
    contextKey: null,
  });
}

export {
  CANONICAL_ENV_BY_KEY,
  LEGACY_ENV_BY_KEY,
};
