// ONS-07 — the Node config reader's schema, generated from CFG.
//
// Source of truth: the CFG JSON Schema that agent-os generates from the Python
// `schema_v1` (`platform/contracts/generated/config.schema.json`, ONS-02),
// read from the deploy checkout or, for fallback, vendored by
// `scripts/sync-cfg-schema.mjs`. This module turns that JSON Schema back into
// the loader's node form (`__type`, `__keys`, ...) so both readers accept and
// reject the same documents. Never hand-edit a CFG key here; regenerate.
//
// Nothing here is hand-written: every key, enum member and annotation Node
// reads is CFG's (the Node-only inventory is empty), and the env alias table
// comes from the sibling `config.env.json` (see ./config-env-aliases.mjs).
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION } from './config-base.mjs';
import { deployCheckoutFromReviewModule } from './deploy-checkout-path.mjs';

const bundledBytes = readFileSync(new URL('./generated/config.schema.json', import.meta.url));
export const CFG_JSON_SCHEMA = JSON.parse(bundledBytes);
const bundledDigest = createHash('sha256').update(bundledBytes).digest('hex');
const moduleCheckout = deployCheckoutFromReviewModule(fileURLToPath(new URL('../', import.meta.url)));
const loggedSources = new Set();

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
  'x-cfg-strict-always': '__strict_always',
};
const KNOWN = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'default', 'description',
  'enum', 'pattern', 'minimum', 'maximum', 'anyOf', 'not', 'minItems', 'maxItems', 'uniqueItems',
  '$schema', ...Object.keys(X_CFG),
]);

// Ignore only informational null-branch metadata, never assertion keywords.
function isNullBranch(branch) {
  return branch?.type === 'null'
    && Object.keys(branch).every(key => ['type', 'description', 'title', '$comment'].includes(key));
}

function isNullableWrapper(js) {
  return Array.isArray(js.anyOf) && js.anyOf.length >= 2
    && js.anyOf.filter(isNullBranch).length === 1;
}

export function fromJsonSchema(js, path = '<root>') {
  const unknown = Object.keys(js).filter(key => !KNOWN.has(key));
  // An unsupported projection keyword needs a deliberate Node meaning.
  if (unknown.length) throw new Error(`${path}: unsupported CFG JSON Schema keyword(s) ${unknown.join(', ')}`);
  if (isNullableWrapper(js)) {
    const { anyOf, ...annotations } = js;
    const branches = anyOf.filter(branch => !isNullBranch(branch));
    const nonNull = branches.length === 1 ? branches[0] : { anyOf: branches };
    return { ...fromJsonSchema({ ...nonNull, ...annotations }, path), __nullable: true };
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

export function freezeSchema(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSchema(child);
    Object.freeze(value);
  }
  return value;
}

export function buildSchema(js = CFG_JSON_SCHEMA) {
  return freezeSchema(fromJsonSchema(js));
}

let cached;
export function schemaV1() {
  cached ??= buildSchema();
  return cached;
}

export function contractSchemaPath(env) {
  const envView = env ?? process.env;
  // Config-derived roots are unavailable until after schema validation.
  const checkout = String(envView.AGENT_OS_ROOT ?? '').trim()
    || String(envView.AGENT_OS_DEPLOY_CHECKOUT ?? '').trim()
    || moduleCheckout;
  return checkout ? resolve(checkout, 'platform', 'contracts', 'generated', 'config.schema.json') : null;
}

function logSchemaOnce(message) {
  if (loggedSources.has(message)) return;
  loggedSources.clear();
  loggedSources.add(message);
  console.error(`[adversarial-config] ${message}`);
}

let compiledContract;
export function schemaForConfig(path) {
  let fallbackReason = 'no checkout';
  if (path) {
    let failure = 'unreadable file';
    try {
      const stat = statSync(path);
      if (!stat.isFile()) throw new Error('not a regular file');
      const bytes = readFileSync(path);
      failure = 'invalid schema';
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (compiledContract?.digest !== digest) {
        const schema = buildSchema(JSON.parse(bytes));
        if (!schema.__strict || !schema.__keys?.version?.__enum?.includes(SCHEMA_VERSION)
          || !osgArmFields(schema)) {
          throw new Error('invalid config contract shape');
        }
        compiledContract = { schema, digest };
      }
      logSchemaOnce(`schema source=contract sha256=${digest} path=${JSON.stringify(path)}`);
      return compiledContract.schema;
    } catch (error) {
      fallbackReason = `contract unavailable (${error.code ?? failure}) at ${JSON.stringify(path)}`;
    }
  }
  logSchemaOnce(`schema source=bundled sha256=${bundledDigest} fallback=${fallbackReason}`);
  return schemaV1();
}

// OSG-18 arm records: field name -> CFG leaf; every field is mandatory.
export function osgArmFields(schema = schemaV1()) {
  return schema.__keys?.osg?.__keys?.arms?.__item?.__keys;
}
