// agent-os-config — Node loader for the cross-language config surface (CFG).
//
// Behavior contract: ../../../projects/cfg/LOADER-CONTRACT.md in the
// agent-os repo. This file is a byte-equivalent implementation of the Python
// loader in `modules/worker-pool/lib/python/agent_os_config/__init__.py`;
// the conformance test suite in `test/config-loader.test.mjs` exercises the
// same fixture cases as the Python `tests/test_loader.py`.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import yaml from 'js-yaml';

export const SCHEMA_VERSION = 1;
export const DEFAULT_TOP_LEVEL_PATH = '/Users/airlock/agent-os/config.yaml';

// -------- AgentOSConfigError ------------------------------------------------

export class AgentOSConfigError extends Error {
  constructor(message, { key, expected, got, source } = {}) {
    super(message);
    this.name = 'AgentOSConfigError';
    this.key = key ?? null;
    this.expected = expected ?? null;
    this.got = got ?? null;
    this.source = source ?? null;
  }
}

// -------- Schema declaration -----------------------------------------------

const ENUM_ROLES_REVIEWER = ['claude-code', 'codex', 'claude', 'adversarial'];
const ENUM_ROLES_REMEDIATOR = ['claude-code', 'codex', 'adversarial'];
const ENUM_ROLES_MERGE_AGENT_WORKER_CLASS = ['merge-agent', 'codex', 'claude-code'];
const ENUM_ROLES_BUILD_PACK_DEFAULT_WORKER_CLASS = ['codex', 'claude-code'];
const ENUM_SESSION_LEDGER_BACKEND = ['sqlite', 'postgres'];

const TYPE_STRING = 'string';
const TYPE_BOOL = 'bool';
const TYPE_INT = 'int';
const TYPE_FLOAT = 'float';
const TYPE_DICT = 'dict';

function schemaV1() {
  return {
    __type: TYPE_DICT,
    __strict: true,
    __keys: {
      version: { __type: TYPE_INT, __required: true, __enum: [1] },
      roots: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          hq: { __type: TYPE_STRING, __default: null, __nullable: true },
          deploy: { __type: TYPE_STRING, __default: null, __nullable: true },
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
        },
      },
      feature_flags: {
        __type: TYPE_DICT,
        __strict: true,
        __keys: {
          live_steer_allow_unvetted: { __type: TYPE_BOOL, __default: false },
          claude_code_ambient_auth_fallback: { __type: TYPE_BOOL, __default: false },
          merge_agent_failure_recovery_disable: { __type: TYPE_BOOL, __default: false },
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
  'roles.reviewer': {
    canonical: 'AGENT_OS_ROLES_REVIEWER',
    aliases: [['ADVERSARIAL_REVIEW_DEFAULT_REVIEWER', identity]],
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
  'session_ledger.backend': {
    canonical: 'AGENT_OS_SESSION_LEDGER_BACKEND',
    aliases: [['AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME', postgresRuntimeAlias]],
  },
  'session_ledger.dsn': {
    canonical: 'AGENT_OS_SESSION_LEDGER_DSN',
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
    if (Object.prototype.hasOwnProperty.call(schema, '__default')) return null;
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
    if (typeof value !== 'number' || !Number.isInteger(value) || Number.isNaN(value)) {
      throw new AgentOSConfigError(
        `${keyPath}: expected int, got ${jsTypeName(value)} (${JSON.stringify(value)})`,
        { key: keyPath, expected: 'int', got: value, source },
      );
    }
  } else if (expected === TYPE_FLOAT) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
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
  }
  if (schema.__enum && !schema.__enum.includes(value)) {
    throw new AgentOSConfigError(
      `${keyPath}: value ${JSON.stringify(value)} not in allowlist ${fmtEnum(schema.__enum)}`,
      {
        key: keyPath,
        expected: `one of ${fmtEnum(schema.__enum)}`,
        got: value,
        source,
      },
    );
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

function validateDictPresentKeysOnly(doc, schema, keyPath, source, lineMap) {
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
  const strict = schema.__strict !== false;

  if (strict) {
    for (const rawKey of Object.keys(doc)) {
      if (rawKey.startsWith('__')) continue;
      if (!(rawKey in allowed)) {
        const lineSrc = annotateLine(source, lineMap, rawKey);
        const near = nearestValidKey(rawKey, Object.keys(allowed));
        const full = keyPath ? `${keyPath}.${rawKey}` : rawKey;
        const hint = near ? ` did you mean ${keyPath ? keyPath + '.' : ''}${JSON.stringify(near)}?` : '';
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
    if (!(childKey in allowed)) continue;
    const childSchema = allowed[childKey];
    const full = keyPath ? `${keyPath}.${childKey}` : childKey;
    const childSource = annotateLine(source, lineMap, childKey);
    if (childSchema.__type === TYPE_DICT) {
      out[childKey] = validateDictPresentKeysOnly(raw, childSchema, full, childSource, null);
    } else {
      out[childKey] = checkLeaf(raw, childSchema, full, childSource);
    }
  }
  return out;
}

export function validateSchema(doc, { source = null, rawText = null } = {}) {
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
  return validateDictPresentKeysOnly(doc, schema, '', source, lineMap);
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

function setLeaf(target, dottedKey, value) {
  const parts = dottedKey.split('.');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const existing = cursor[part];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function getLeaf(source, dottedKey) {
  const parts = dottedKey.split('.');
  let cursor = source;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || !(part in cursor)) return MISSING;
    cursor = cursor[part];
  }
  return cursor;
}

const MISSING = Symbol('missing');

function validateModuleDoc(doc, source, rawText) {
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
  const aliasesRaw = doc.__aliases || {};
  if (typeof aliasesRaw !== 'object' || Array.isArray(aliasesRaw)) {
    throw new AgentOSConfigError(
      `${source}: __aliases must be a mapping`,
      { key: '__aliases', expected: 'mapping', got: jsTypeName(aliasesRaw), source },
    );
  }
  const aliases = {};
  for (const [moduleKey, canonicalKey] of Object.entries(aliasesRaw)) {
    if (typeof moduleKey !== 'string' || typeof canonicalKey !== 'string') {
      throw new AgentOSConfigError(
        `${source}: __aliases entries must map string→string (${JSON.stringify(moduleKey)}→${JSON.stringify(canonicalKey)})`,
        { source },
      );
    }
    aliases[moduleKey] = canonicalKey;
  }

  const body = {};
  for (const [k, v] of Object.entries(doc)) {
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

  const schema = schemaV1();
  const moduleSchema = {
    __type: TYPE_DICT,
    __strict: schema.__strict,
    __keys: {},
  };
  for (const [k, v] of Object.entries(schema.__keys)) {
    if (k !== 'version') moduleSchema.__keys[k] = v;
  }
  const lineMap = rawText ? buildLineMap(rawText, Object.keys(moduleSchema.__keys)) : null;
  const validated = validateDictPresentKeysOnly(canonicalBody, moduleSchema, '', source, lineMap);
  return { validated, aliases };
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
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

function flattenWithEmptyDicts(doc, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith('__')) continue;
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (Object.keys(value).length > 0) {
        Object.assign(out, flattenWithEmptyDicts(value, full));
      }
    } else {
      out[full] = value;
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
    },
  );
}

function coerceEnvValue(key, value, schemaLeaf) {
  const expected = schemaLeaf.__type;
  if (expected === TYPE_BOOL) {
    const lower = value.trim().toLowerCase();
    if (lower === 'true' || lower === '1') return true;
    if (lower === 'false' || lower === '0' || lower === '') return false;
    throw new AgentOSConfigError(
      `${key}: env value ${JSON.stringify(value)} is not a recognized boolean (use 'true'/'false' or '1'/'0')`,
      { key, expected: 'bool', got: value },
    );
  }
  if (expected === TYPE_INT) {
    const n = Number(value);
    if (!Number.isInteger(n)) {
      throw new AgentOSConfigError(
        `${key}: env value ${JSON.stringify(value)} is not an integer`,
        { key, expected: 'int', got: value },
      );
    }
    return n;
  }
  if (expected === TYPE_FLOAT) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new AgentOSConfigError(
        `${key}: env value ${JSON.stringify(value)} is not a float`,
        { key, expected: 'float', got: value },
      );
    }
    return n;
  }
  return value;
}

function schemaLeaf(schema, key) {
  const parts = key.split('.');
  let cursor = schema;
  for (const part of parts) {
    if (cursor.__type !== TYPE_DICT) return null;
    const keys = cursor.__keys || {};
    if (!(part in keys)) return null;
    cursor = keys[part];
  }
  return cursor;
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

function localSibling(path) {
  const dir = dirname(path);
  const name = basename(path);
  if (name.endsWith('.yaml')) {
    return join(dir, `${name.slice(0, -'.yaml'.length)}.local.yaml`);
  }
  if (name.endsWith('.yml')) {
    return join(dir, `${name.slice(0, -'.yml'.length)}.local.yml`);
  }
  return join(dir, `${name}.local`);
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
}

// -------- Public loader API ------------------------------------------------

export function loadConfig({
  topPath = null,
  modulePaths = [],
  env = null,
  cliOverrides = null,
} = {}) {
  const envView = env || process.env;
  const schema = schemaV1();

  const defaults = buildDefaultsDict(schema);
  const merged = {};
  const trace = {};
  for (const [dotted, value] of Object.entries(flattenWithEmptyDicts(defaults))) {
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
    for (const [dotted, value] of Object.entries(flatten(validated))) {
      setLeaf(merged, dotted, value);
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
    for (const [dotted, value] of Object.entries(flatten(validated))) {
      if (dotted === 'version') continue;
      setLeaf(merged, dotted, value);
      (trace[dotted] = trace[dotted] || []).push({
        source: 'top',
        value,
        path: topPathResolved,
      });
    }
  }

  // --- Layer 4: *.local.yaml siblings ---
  const localSources = [];
  const topLocal = localSibling(topPathResolved);
  if (existsSync(topLocal)) localSources.push(topLocal);
  for (const rawPath of modulePaths) {
    const moduleLocal = localSibling(rawPath);
    if (existsSync(moduleLocal)) localSources.push(moduleLocal);
  }
  for (const local of localSources) {
    const { doc: localDoc, rawText: localRaw } = loadLayerFile(local);
    if (localDoc === null || localDoc === undefined || isEmptyDoc(localDoc)) continue;
    let validatedLocal;
    if (
      localDoc &&
      typeof localDoc === 'object' &&
      !Array.isArray(localDoc) &&
      'version' in localDoc
    ) {
      validatedLocal = validateSchema(localDoc, { source: local, rawText: localRaw });
    } else {
      const { validated, aliases } = validateModuleDoc(localDoc, local, localRaw);
      validatedLocal = validated;
      for (const [moduleKey, canonicalKey] of Object.entries(aliases)) {
        if (!(moduleKey in moduleAliases)) moduleAliases[moduleKey] = canonicalKey;
      }
    }
    for (const [dotted, value] of Object.entries(flatten(validatedLocal))) {
      if (dotted === 'version') continue;
      setLeaf(merged, dotted, value);
      (trace[dotted] = trace[dotted] || []).push({
        source: `local:${local}`,
        value,
        path: local,
      });
    }
  }

  // --- Layer 5: env vars ---
  for (const [key, info] of Object.entries(ENV_ALIASES)) {
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
      value = coerceEnvValue(key, rawValue, leaf);
    } else {
      value = rawValue;
    }
    value = checkLeaf(value, leaf, key, `env:${winning}`);
    setLeaf(merged, key, value);
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

let _cachedConfig = null;

export function getConfig(key, defaultValue = null) {
  if (_cachedConfig === null) _cachedConfig = loadConfig();
  return _cachedConfig.get(key, defaultValue);
}

export function resolutionTrace(key) {
  if (_cachedConfig === null) _cachedConfig = loadConfig();
  return _cachedConfig.resolutionTrace(key);
}

export function resetConfigCache() {
  _cachedConfig = null;
}
