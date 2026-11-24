// ONS-07 — the cascade itself: code defaults -> module files -> top-level file
// -> profile overlay -> *.local.yaml -> env -> CLI, as in the Python loader.
import { existsSync } from 'node:fs';
import { contractSchemaPath, schemaForConfig } from './config-schema.mjs';
import { ENV_ALIASES, dynamicAppEnvAliases, dynamicAppEnvIds } from './config-env-aliases.mjs';
import { AgentOSConfigError, DEFAULT_TOP_LEVEL_PATH, checkDeprecatedEnvVars } from './config-base.mjs';
import { checkLeaf, isEmptyDoc, validateSchemaLayer } from './config-checks.mjs';
import { AgentOSConfig } from './config-class.mjs';
import { backfillExtraKeyEntryDefaults, checkEnvOverlap, coerceEnvValue, ownMapEntryIds } from './config-env-layer.mjs';
import { validateModuleDoc } from './config-module-doc.mjs';
import { buildDefaultsDict, canonicalSchemaLeaves, flatten, getLeaf, schemaAliasTarget, schemaLeaf, setLeaf, setLeafPath } from './config-paths.mjs';
import { enforceCiHostingSecurityInvariants, validateGoalLineageConfig, validateGrokRolePins, validateOAuthDeclarations, validateOsgShape, validatePublicHygiene, validateSearch, validateWorkerClassVaults } from './config-policies.mjs';
import { OVERLAY_PROFILE, loadLayerFile, localSibling, nonBlankString, profileOverlaySibling, resolveProfile } from './config-profile.mjs';

// Internal injection seam for env coercion tests; the public registry is frozen.
export const __testEnvAliasHooks = { entries: () => Object.entries(ENV_ALIASES) };

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
// HAMMERPOOLSTRICT-01: this is a runtime routing reader, so it shares the
// general runtime reader's checked-in-unknown tolerance. A key that belongs to
// a newer host config is warned about once and dropped; it must not hold every
// closer. Value validation, `__strict_always` policies and the identity pool,
// token account and broker declarations this reader projects stay strict.
export function loadConfigForIdentityTokenPool({ identity, ...options } = {}) {
  return loadConfigImpl({ ...options, tolerateCheckedInUnknown: true, tokenPoolIdentity: identity });
}

function buildCodeDefaults(schema) {
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
  return { merged, trace };
}

let codeDefaults;

// Internal test hook: the next load rebuilds values and provenance together.
export function _resetCodeDefaultsForTesting() {
  codeDefaults = undefined;
}

export function loadConfigImpl({
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
  const topPathResolved = topPath || envView.AGENT_OS_CONFIG_PATH || DEFAULT_TOP_LEVEL_PATH;
  const schema = schemaForConfig(contractSchemaPath(envView));

  // Rebuild when the selected schema changes. Clone values and provenance together.
  if (codeDefaults?.schema !== schema) codeDefaults = { schema, baseline: buildCodeDefaults(schema) };
  const { merged, trace } = structuredClone(codeDefaults.baseline);
  const runtimeDroppedUnknownKeys = [];

  // --- Layer 2: module files ---
  const moduleAliases = {};
  for (const rawPath of modulePaths) {
    const { doc, rawText } = loadLayerFile(rawPath);
    if (doc === null || doc === undefined) continue;
    const { validated, aliases } = validateModuleDoc(doc, rawPath, rawText, {
      schema,
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
  const { doc: topDoc, rawText: topRaw } = loadLayerFile(topPathResolved);
  if (topDoc !== null && topDoc !== undefined && !isEmptyDoc(topDoc)) {
    const validated = validateSchemaLayer(topDoc, {
      schema,
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
        schema,
        source: local,
        rawText: localRaw,
        tolerateUnknown: true,
      });
    } else {
      const { validated, aliases } = validateModuleDoc(localDoc, local, localRaw, {
        schema,
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
    ...__testEnvAliasHooks.entries(),
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
  validateOsgShape(merged.osg, null, schema);
  validateSearch(merged.services?.hcp?.search);
  validatePublicHygiene(merged.worker_pool?.public_hygiene);
  validateWorkerClassVaults(merged.worker_pool?.secrets, trace);

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
