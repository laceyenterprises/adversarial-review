// ONS-07 — dotted-path helpers over the generated schema and merged documents:
// flatten, get/set a leaf, schema lookup, alias targets and defaults.
import { isDeepStrictEqual } from 'node:util';
import { ATOMIC_KEYED_MAP_PATHS, AgentOSConfigError, SEARCH_LIMIT_PATHS, TYPE_DICT } from './config-base.mjs';

export function flatten(doc, prefix = '', preserveEmptyMap = () => false, atomicPaths = new Set()) {
  const out = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith('__')) continue;
    const full = prefix ? `${prefix}.${key}` : key;
    if (atomicPaths.has(full) || SEARCH_LIMIT_PATHS.has(full) || ATOMIC_KEYED_MAP_PATHS.has(full)) {
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

export const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function assertSafePathSegment(segment, dottedKey) {
  if (UNSAFE_PATH_SEGMENTS.has(segment)) {
    throw new AgentOSConfigError(
      `config path ${JSON.stringify(dottedKey)} contains unsafe segment ${JSON.stringify(segment)}`,
      { key: dottedKey, expected: 'safe dotted path', got: segment },
    );
  }
}

export function setLeaf(target, dottedKey, value) {
  const parts = dottedKey.split('.');
  setLeafPath(target, parts, value, { dottedKey, rejectUnsafeSegments: true });
}

export function setLeafPath(
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

export function getLeaf(source, dottedKey) {
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

export const MISSING = Symbol('missing');

export function sameValue(a, b) {
  // Order-independent deep equality so dict-typed alias values don't trigger
  // spurious "same-file alias conflict" errors on key-order coincidence.
  return isDeepStrictEqual(a, b);
}

// -------- Defaults builder -------------------------------------------------

// Mirrors agent_os_config.validation._build_defaults_dict.
export function buildDefaultsDict(schema) {
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

export function schemaLeaf(schema, key) {
  const parts = key.split('.');
  let cursor = schema;
  for (const part of parts) {
    if (!cursor || cursor.__type !== TYPE_DICT) return null;
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
  if (SEARCH_LIMIT_PATHS.has(path.join('.')) || ATOMIC_KEYED_MAP_PATHS.has(path.join('.'))) {
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
  const keys = schema.__keys || {};
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith('__')) continue;
    const child = Object.hasOwn(keys, key)
      ? keys[key]
      : schema.__strict === false ? schema.__extra_keys_schema : undefined;
    yield* flattenSchemaLeaves(value, child, [...path, key]);
  }
}

export function schemaAliasTarget(schema, key) {
  return schemaLeaf(schema, key)?.__alias_of || key;
}

export function* canonicalSchemaLeaves(doc, schema, source) {
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

// Yields [parentPath, extraSchema] for every non-strict dict that declares an
// `__extra_keys_schema` (the keyed-map extension points, e.g. `apps.<id>`).
// Mirrors the Python `_iter_extra_key_dict_schemas`.
export function* iterExtraKeyDictSchemas(schema, prefix = '') {
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

// True iff `key` is a path the schema accepts. Walks like schemaLeaf, but
// also accepts paths that descend into a non-strict dict (extension point,
// e.g. `submodules.X.Y`) where no further leaf is declared. Used by
// __aliases validation so canonical-key typos fail loud while legitimate
// pass-through targets are allowed.
export function isValidSchemaPath(schema, key) {
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
