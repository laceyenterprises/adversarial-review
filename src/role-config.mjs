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
  loadConfigCached,
  resetConfigCache,
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
  // CFG-02 round-1 review B4 fix: prefer structured `err.allowed`
  // (an array; future loader shape) over parsing `err.expected`
  // (a human-display string). When neither shape works, the
  // allowedForLegacyMessage helper falls through to a marker token
  // so operators see the format mismatch instead of garbage.
  const allowed = Array.isArray(err.allowed)
    ? err.allowed
    : (err.expected && /^one of /.test(err.expected)
      ? err.expected.slice('one of '.length)
      : err.expected);
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

// CFG-02 round-1 review B4 fix (2026-05-30): make
// allowedForLegacyMessage resilient to (a) the loader passing a
// structured array via `err.allowed` (preferred future shape) and
// (b) the legacy string form changing format. Previously this
// function silently produced garbage (e.g. `'"claude-code'` or
// `claude-code,codex`) when the loader's `fmtEnum` output drifted
// from the exact `["a", "b"]` shape it assumed.
//
// Resolution order:
// 1. If allowedRaw is an array → join directly.
// 2. If allowedRaw is a string matching the canonical
//    `["a", "b", "c"]` shape → parse via JSON, fall through on
//    parse failure.
// 3. Defensive bracket/quote strip → comma split (legacy form).
// 4. Last resort: render `<format-unrecognized>` so operators
//    immediately see something is wrong, instead of a half-mangled
//    string that looks correct.
function allowedForLegacyMessage(canonicalKey, allowedRaw) {
  if (!allowedRaw) return '<unknown>';
  if (Array.isArray(allowedRaw)) {
    return allowedRaw.map((entry) => String(entry)).join(', ');
  }
  if (typeof allowedRaw !== 'string') return String(allowedRaw);
  // Try canonical JSON form first.
  const trimmed = allowedRaw.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry)).join(', ');
      }
    } catch {
      // Fall through to legacy parser.
    }
  }
  // Legacy form: strip outer brackets + per-token quotes.
  const stripped = trimmed.replace(/^\[/, '').replace(/\]$/, '');
  const tokens = stripped
    .split(',')
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  if (tokens.length === 0) return '<format-unrecognized>';
  return tokens.join(', ');
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
//
// Caching (CFG-09): when no `loaderImpl` is injected, the call routes
// through `loadConfigCached` in `config-loader.mjs`. That keeps cache
// slots per (topPath, modulePaths, declared env aliases) shape and
// invalidates when any watched file (top + top.local + each module +
// each module.local) changes mtime/inode. Callers still reset at their
// per-tick / per-job boundary, but explicit env overlays now get their
// own cache slots so aliases and conflict checks remain env-scoped.
// This is the documented contract from CFG-09 (`LOADER-CONTRACT.md`
// §Cache invalidation), not a regression of the failed naive cache
// attempted in the CFG-02 round-1 remediation.
//
// Tests that need hermetic env-mutation behavior either (a) pass an
// explicit `loaderImpl` (the cache is fully bypassed), (b) use a fresh
// tmp `modulePaths` per case (different cache slot per test), or
// (c) call `resetRoleConfigCache()` from a per-test hook (see
// `test/helpers/role-config-cache-reset.mjs`).

export function loadRoleConfig({
  env = process.env,
  topPath,
  modulePaths,
  loaderImpl,
  contextKey = null,
} = {}) {
  const modulePathsResolved = modulePaths || [MODULE_CONFIG_PATH];
  const envPruned = pruneBlankRoleEnvVars(env);
  // Only an `undefined` loaderImpl opts into the default cached loader;
  // an explicit `null` / `false` / `0` opts OUT of caching (passes
  // through, which throws because it isn't callable — surfacing the
  // intent at the call site instead of silently falling back to the
  // cache). `loaderImpl || loadConfigCached` would silently use the
  // cache on a falsy explicit value, which is a documented footgun.
  const loader = loaderImpl !== undefined ? loaderImpl : loadConfigCached;
  try {
    return loader({
      topPath,
      modulePaths: modulePathsResolved,
      env: envPruned,
    });
  } catch (err) {
    throw reshapeLoaderError(err, contextKey);
  }
}

// resetRoleConfigCache — drops the cached role-config slot so the next
// `loadRoleConfig` call re-reads files and re-applies env. Wired into
// the watcher's `pollOnce` tick boundary and the follow-up consumer's
// `consumeNextFollowUpJob` job boundary so an operator's in-process env
// rotation (or a stale per-test cache entry) cannot bleed across ticks
// or jobs. Tests that mutate `process.env` between cases should call
// this from an `afterEach`-style hook; see
// `test/helpers/role-config-cache-reset.mjs`.
//
// IMPORTANT — process-wide scope. This is a thin re-export of
// `resetConfigCache()` from `config-loader.mjs`; it drops EVERY slot
// in the shared cache, including the `getConfig` /
// `resolutionTrace` slot keyed by the empty call shape. The name
// reads like "role-config-only" because role-config is the principal
// caller, but the underlying cache is shared across `loadConfigCached`,
// `getConfig`, and `resolutionTrace`. If a future caller adds a
// "drop only my slot" sibling, rename this to `resetCascadeCache` to
// keep the boundary honest.
export function resetRoleConfigCache() {
  resetConfigCache();
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
  modulePaths,
  loaderImpl,
  reviewerRouteByModel,
} = {}) {
  const cfg = loadRoleConfig({
    env,
    topPath,
    modulePaths,
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
