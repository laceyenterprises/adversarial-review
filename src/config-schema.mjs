// ONS-07 — the Node config reader's schema, generated from CFG.
//
// Source of truth: the CFG JSON Schema that agent-os generates from the Python
// `schema_v1` (`platform/contracts/generated/config.schema.json`, ONS-02),
// vendored as `./generated/config.schema.json` by
// `scripts/sync-cfg-schema.mjs`. This module turns that JSON Schema back into
// the loader's node form (`__type`, `__keys`, ...) so both readers accept and
// reject the same documents. Never hand-edit a CFG key here; regenerate.
//
// Explicit, inventoried exceptions remain (`./config-node-keys.mjs`):
// Node-only keys and enum members this service reads that CFG does not
// declare yet, and repairs for CFG annotations the ONS-02 projection drops.
// All may only ADD to the generated tree; redefining CFG throws at import.
import { readFileSync } from 'node:fs';
import { NODE_ONLY_ENUM_MEMBERS, NODE_ONLY_KEYS, PROJECTION_REPAIRS, STRICT_ALWAYS_PATHS } from './config-node-keys.mjs';

export const CFG_JSON_SCHEMA = JSON.parse(
  readFileSync(new URL('./generated/config.schema.json', import.meta.url), 'utf8'),
);

const TYPES = { object: 'dict', array: 'list', string: 'string', boolean: 'bool', integer: 'int', number: 'float' };
// cfg_schema.project() wraps CFG's fullmatch patterns for JSON Schema search
// semantics; the wrapped form is a valid JS fullmatch, the inner one is what
// operators wrote and what Python prints in errors.
const FULLMATCH = /^\^\(\?:([\s\S]*)\)\(\?!\[\\s\\S\]\)$/;
const X_CFG = {
  'x-cfg-alias-of': '__alias_of',
  'x-cfg-coerce-number-to-string': '__coerce_number_to_string',
  'x-cfg-lane-routes': '__lane_routes',
  'x-cfg-lowercase': '__lowercase',
  'x-cfg-normalize': '__normalize',
  'x-cfg-read-only': '__read_only',
  'x-cfg-repository-list': '__repository_list',
  'x-cfg-scalar-default-key': '__scalar_default_key',
};
const KNOWN = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'default', 'description',
  'enum', 'pattern', 'minimum', 'maximum', 'anyOf', 'not', 'minItems', 'maxItems', 'uniqueItems',
  '$schema', ...Object.keys(X_CFG),
]);

function isNullableWrapper(js) {
  return Array.isArray(js.anyOf) && js.anyOf.length === 2
    && js.anyOf.some(branch => branch?.type === 'null' && Object.keys(branch).length === 1);
}

export function fromJsonSchema(js, path = '<root>') {
  const unknown = Object.keys(js).filter(key => !KNOWN.has(key));
  // Fail at import, not at a daemon's first read: a new projection keyword
  // needs a deliberate Node meaning.
  if (unknown.length) throw new Error(`${path}: unsupported CFG JSON Schema keyword(s) ${unknown.join(', ')}`);
  if (isNullableWrapper(js)) {
    const { anyOf, ...annotations } = js;
    return { ...fromJsonSchema({ ...anyOf.find(branch => !(branch?.type === 'null' && Object.keys(branch).length === 1)), ...annotations }, path), __nullable: true };
  }
  if (js.type === undefined) {
    if (js.anyOf) throw new Error(`${path}: unsupported anyOf`);
    return { __type: 'any' };
  }
  const node = { __type: TYPES[js.type] };
  if (!node.__type) throw new Error(`${path}: unsupported type ${JSON.stringify(js.type)}`);
  if (node.__type === 'dict') {
    node.__keys = {};
    for (const [key, child] of Object.entries(js.properties ?? {})) {
      node.__keys[key] = fromJsonSchema(child, `${path}.${key}`);
    }
    for (const key of Array.isArray(js.required) ? js.required : []) {
      if (!Object.hasOwn(node.__keys, key)) throw new Error(`${path}.${key}: required CFG property has no declared schema`);
      node.__keys[key].__required = true;
    }
    node.__strict = js.additionalProperties === false;
    if (js.additionalProperties && typeof js.additionalProperties === 'object') {
      node.__extra_keys_schema = fromJsonSchema(js.additionalProperties, `${path}.*`);
    }
  }
  if (js.items) node.__item = fromJsonSchema(js.items, `${path}[]`);
  if (Object.hasOwn(js, 'default')) node.__default = js.default;
  if (js.enum) node.__enum = js.enum;
  if (js.not) node.__disallow = js.not.enum;
  if (js.pattern !== undefined) {
    node.__pattern = js.pattern;
    node.__pattern_description = FULLMATCH.exec(js.pattern)?.[1] ?? js.pattern;
  }
  if (js.minimum !== undefined) node.__min = js.minimum;
  if (js.anyOf) {
    const zero = js.anyOf.find(branch => branch?.const === 0);
    const floor = js.anyOf.find(branch => branch?.minimum !== undefined);
    if (js.anyOf.length !== 2 || !zero || !floor) {
      throw new Error(`${path}: unsupported anyOf`);
    }
    Object.assign(node, { __min: floor.minimum, __allow_zero: true });
  }
  // CFG projects only enforced maxima; an advisory Python __max is absent.
  if (js.maximum !== undefined) node.__max = js.maximum;
  if (js.minItems !== undefined) node.__min_items = js.minItems;
  if (js.maxItems !== undefined) node.__max_items = js.maxItems;
  if (js.uniqueItems) node.__unique = true;
  for (const [keyword, annotation] of Object.entries(X_CFG)) {
    if (Object.hasOwn(js, keyword)) node[annotation] = js[keyword];
  }
  return node;
}

function locate(root, dotted) {
  let parent = null;
  let node = root;
  let key = null;
  const parts = typeof dotted === 'string' ? dotted.match(/[^.[\]]+|\[\]/g) : null;
  if (!parts?.length) throw new Error(`${String(dotted)}: invalid CFG overlay path`);
  for (const part of parts) {
    parent = node;
    key = part;
    if (part === '[]') node = node?.__item;
    else if (part === '*') node = node?.__extra_keys_schema;
    else node = node?.__keys?.[part];
  }
  return { parent, key, node };
}

function attach(root, dotted, addition, { repair }) {
  const { parent, key, node } = locate(root, dotted);
  if (!parent || parent.__type !== 'dict') throw new Error(`${dotted}: overlay parent is not a CFG mapping`);
  if (key === '*') {
    if (node || (!repair && parent.__strict)) throw new Error(`${dotted}: overlay would redefine CFG extra keys`);
    parent.__strict = false;
    parent.__extra_keys_schema = addition;
    return;
  }
  if (node) throw new Error(`${dotted}: Node-only key is now declared by CFG; delete it from config-node-keys.mjs`);
  parent.__keys[key] = addition;
}

export function freezeSchema(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSchema(child);
    Object.freeze(value);
  }
  return value;
}

export function buildSchema(js = CFG_JSON_SCHEMA) {
  const root = fromJsonSchema(js);
  for (const [dotted, addition] of Object.entries(PROJECTION_REPAIRS)) {
    attach(root, dotted, structuredClone(addition), { repair: true });
  }
  for (const [dotted, addition] of Object.entries(NODE_ONLY_KEYS)) {
    attach(root, dotted, structuredClone(addition), { repair: false });
  }
  for (const [dotted, { members, normalize = {} }] of Object.entries(NODE_ONLY_ENUM_MEMBERS)) {
    const { node } = locate(root, dotted);
    if (!Array.isArray(node?.__enum)) throw new Error(`${dotted}: Node-only enum members need a CFG enum`);
    const declared = members.filter(member => node.__enum.includes(member));
    if (declared.length) throw new Error(`${dotted}: ${declared.join(', ')} now declared by CFG; delete from config-node-keys.mjs`);
    node.__enum = [...node.__enum, ...members];
    if (Object.keys(normalize).some(key => Object.hasOwn(node.__normalize ?? {}, key))) {
      throw new Error(`${dotted}: Node-only normalization would redefine CFG`);
    }
    if (Object.keys(normalize).length) node.__normalize = { ...node.__normalize, ...normalize };
  }
  for (const dotted of STRICT_ALWAYS_PATHS) {
    const { node } = locate(root, dotted);
    if (node?.__type !== 'dict') throw new Error(`${dotted}: strict-always path is not a CFG mapping`);
    node.__strict_always = true;
  }
  return freezeSchema(root);
}

let cached;
export function schemaV1() {
  cached ??= buildSchema();
  return cached;
}

// OSG-18 arm records: field name -> CFG leaf; every field is mandatory.
export function osgArmFields() {
  return schemaV1().__keys.osg.__keys.arms.__item.__keys;
}
