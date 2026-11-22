// ONS-07 — the env layer of the cascade: alias overlap checks, value coercion
// and the defaults of apps that only env registers.
import { AgentOSConfigError, TYPE_BOOL, TYPE_FLOAT, TYPE_INT, TYPE_LIST } from './config-base.mjs';
import { MISSING, UNSAFE_PATH_SEGMENTS, buildDefaultsDict, flatten, getLeaf, iterExtraKeyDictSchemas, setLeafPath } from './config-paths.mjs';

export function checkEnvOverlap(key, canonicalEnv, aliases, env) {
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

export function coerceEnvValue(key, value, schemaLeaf, source = null) {
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

export function ownMapEntryIds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Set();
  return new Set(Object.keys(value));
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
export function backfillExtraKeyEntryDefaults(merged, schema, dynamicAppIds, trace) {
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
