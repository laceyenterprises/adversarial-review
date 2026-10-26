import { isDeepStrictEqual } from 'node:util';

// An explicit inventory prevents a newly mirrored Python annotation from
// silently acquiring different semantics in this reader. Description and
// enforce_min are informational: Python also enforces every declared minimum.
const ANNOTATIONS = new Set([
  '__type', '__keys', '__strict', '__default', '__nullable', '__enum',
  '__item', '__extra_keys_schema', '__pattern', '__pattern_description',
  '__min', '__max', '__enforceMax', '__enforce_min', '__allow_zero',
  '__alias_of', '__description',
]);
const TYPES = new Set(['dict', 'list', 'bool', 'int', 'float', 'string', 'any']);
const isPlainObject = (value) => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;

export function extendModuleSchema(target, additions, path = '<root>') {
  if (!isPlainObject(additions)) throw new Error(`${path}: mirror schema must be a plain object`);
  for (const key of Object.keys(additions)) {
    if (!ANNOTATIONS.has(key)) throw new Error(`${path}: unsupported mirror annotation ${key}`);
  }
  if (target === undefined) {
    if (!TYPES.has(additions.__type)) throw new Error(`${path}: missing mirror parent type`);
    target = {};
  } else if (!isPlainObject(target) || target.__type !== 'dict'
    || (additions.__type !== undefined && additions.__type !== 'dict')) {
    throw new Error(`${path}: mirror would overwrite an existing leaf`);
  }
  for (const [key, value] of Object.entries(additions)) {
    if (key === '__keys') {
      if (!isPlainObject(value)) throw new Error(`${path}: mirror keys must be a plain object`);
      target.__keys ??= {};
      for (const [child, schema] of Object.entries(value)) {
        target.__keys[child] = extendModuleSchema(target.__keys[child], schema, `${path}.${child}`);
      }
    } else if (key === '__item' || key === '__extra_keys_schema') {
      target[key] = extendModuleSchema(target[key], value, `${path}.${key}`);
    } else {
      // Attributes (including null defaults) are atomic, never merge targets.
      if (Object.hasOwn(target, key) && !isDeepStrictEqual(target[key], value)) {
        throw new Error(`${path}: mirror would overwrite ${key}`);
      }
      target[key] = structuredClone(value);
    }
  }
  // Python's __enforce_max is packaged as __enforceMax. A bare maximum is
  // advisory there; preserve existing Node-only schemas' hard maximum default.
  if (Object.hasOwn(additions, '__max') && !Object.hasOwn(additions, '__enforceMax')) {
    target.__enforceMax = false;
  }
  return target;
}

export function freezeSchema(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSchema(child);
    Object.freeze(value);
  }
  return value;
}
