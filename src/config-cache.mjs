// ONS-07 — the cached loaders (`loadConfigCached`, `getConfig`, ...): a bounded
// LRU keyed by call shape and env, invalidated by file signatures.
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ENV_ALIASES, dynamicAppEnvAliases } from './config-env-aliases.mjs';
import { DEFAULT_TOP_LEVEL_PATH } from './config-base.mjs';
import { loadConfigImpl } from './config-cascade.mjs';
import { PROFILE_ENV, localSibling, nonBlankString, profileOverlaySibling } from './config-profile.mjs';

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
  // Snapshot names on each lookup so rotations and removals still invalidate
  // the slot. Avoid a native process.env lookup for every absent schema alias.
  // Windows's process environment can match names case-insensitively.
  const envNames = envView === process.env && process.platform !== 'win32'
    ? new Set(Object.getOwnPropertyNames(envView)) : null;
  const addAlias = name => {
    if (envNames ? envNames.has(name) : Object.hasOwn(envView, name)) {
      envAliases.push([name, envView[name]]);
    }
  };
  for (const { canonical, aliases } of Object.values(ENV_ALIASES)) {
    addAlias(canonical);
    for (const [name] of aliases || []) addAlias(name);
  }
  for (const [, { canonical }] of dynamicAppEnvAliases(envView)) addAlias(canonical);
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
