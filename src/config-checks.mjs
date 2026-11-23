// ONS-07 — leaf and mapping validation against the generated schema, YAML
// parsing and the line map used in error messages. Mirrors
// agent_os_config.validation.
import * as yaml from 'js-yaml';
import { normalizeDisabledRepositories } from './merge-disabled-repositories.mjs';
import { normalizeLaneRoutes } from './config-lane-routes.mjs';
import { schemaV1 } from './config-schema.mjs';
import { AgentOSConfigError, SCHEMA_VERSION, TYPE_BOOL, TYPE_DICT, TYPE_FLOAT, TYPE_INT, TYPE_LIST, TYPE_STRING, configDebugLog, runtimeWarningSource, warnRuntimeUnknownKeyOnce } from './config-base.mjs';
import { validateOAuthDeclarations, validateOsgShape, validatePublicHygiene, validateSearch } from './config-policies.mjs';

export const __testYamlHooks = {
  load: (...args) => yaml.load(...args),
};

export function parseYaml(text, sourcePath) {
  if (String(text ?? '').trim() === '') return null;
  try {
    return __testYamlHooks.load(text, {
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
    if (isEmptyYamlDocumentError(err)) return null;
    const line = extractYamlErrorLine(err);
    const where = line !== null ? `${sourcePath}:${line}` : sourcePath;
    const reason = err && err.reason ? err.reason : (err && err.message) || String(err);
    throw new AgentOSConfigError(
      `malformed YAML in ${where}: ${reason}`,
      { source: where },
    );
  }
}

function isEmptyYamlDocumentError(err) {
  const reason = err && err.reason ? err.reason : '';
  const message = err && err.message ? err.message : '';
  return reason === 'expected a document, but the input is empty' || message.includes('expected a document, but the input is empty');
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

export function jsTypeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

const compiledLeafPatterns = new WeakMap();

// Mirrors agent_os_config.validation._check_leaf; keep both in step.
export function checkLeaf(value, schema, keyPath, source, tolerateUnknown = false, nested = {}) {
  const fail = (message, expected, got = value) => {
    throw new AgentOSConfigError(`${keyPath}: ${message}`, { key: keyPath, expected, got, source });
  };
  const normalizeWith = (normalize) => {
    try { return normalize(value); } catch (error) { throw new AgentOSConfigError(`${keyPath}: ${error.message}`, { key: keyPath, source }); }
  };
  const expected = schema.__type;
  if (expected === 'any') return value; // validated atomically after the cascade
  if (value === null || value === undefined) {
    if (schema.__nullable) return null;
    // Explicit null (`key: ~`) is not "omitted"; defaults never reach here.
    fail(`expected ${expected}, got null${Object.hasOwn(schema, '__default') ? ' (omit the key to keep the default)' : ''}`, expected, null);
  }
  if (schema.__repository_list) return normalizeWith(normalizeDisabledRepositories);
  if (schema.__lane_routes) return normalizeWith(normalizeLaneRoutes);
  const shown = JSON.stringify(value);
  if (expected === TYPE_BOOL) {
    if (typeof value !== 'boolean') {
      const instr = typeof value === 'string' ? 'use `true` or `false` (YAML 1.2 booleans only)' : 'boolean required';
      fail(`expected bool, got ${jsTypeName(value)} (${shown}); ${instr}`, 'bool');
    }
  } else if (expected === TYPE_INT) {
    if (!Number.isInteger(value)) fail(`expected int, got ${jsTypeName(value)} (${shown})`, 'int');
  } else if (expected === TYPE_FLOAT) {
    if (typeof value !== 'number') fail(`expected float, got ${jsTypeName(value)} (${shown})`, 'float');
    if (!Number.isFinite(value)) fail(`expected finite float, got ${value}`, 'finite float');
  } else if (expected === TYPE_STRING) {
    if (schema.__coerce_number_to_string && typeof value === 'number' && Number.isFinite(value)) value = String(value);
    if (typeof value !== 'string') fail(`expected string, got ${jsTypeName(value)} (${shown})`, 'string');
    if (schema.__lowercase) value = value.toLowerCase();
    if (schema.__pattern !== undefined) {
      let compiled = compiledLeafPatterns.get(schema);
      if (!compiled || compiled.pattern !== schema.__pattern) {
        compiled = { pattern: schema.__pattern, regex: new RegExp(schema.__pattern) };
        compiledLeafPatterns.set(schema, compiled);
      }
      if (!compiled.regex.test(value)) {
        const description = schema.__pattern_description || schema.__pattern;
        fail(`value ${JSON.stringify(value)} does not match ${description}`, description);
      }
    }
  } else if (expected === TYPE_DICT) {
    return validateDictPresentKeysOnly(value, schema, keyPath, source, null, tolerateUnknown, nested);
  } else if (expected === TYPE_LIST) {
    if (!Array.isArray(value)) fail(`expected list, got ${jsTypeName(value)} (${shown})`, 'list');
    if (schema.__item) value = value.map((item, index) => checkLeaf(item, schema.__item, `${keyPath}[${index}]`, source, tolerateUnknown, nested));
    if (schema.__unique) value = [...new Map(value.map(item => [JSON.stringify(item), item])).values()];
    if (schema.__min_items !== undefined && value.length < schema.__min_items) {
      fail(`expected at least ${schema.__min_items} item(s), got ${value.length}`, `>= ${schema.__min_items} item(s)`);
    }
    if (schema.__max_items !== undefined && value.length > schema.__max_items) {
      fail(`expected at most ${schema.__max_items} item(s), got ${value.length}`, `<= ${schema.__max_items} item(s)`);
    }
  }
  if (typeof value === 'number') {
    if (schema.__min !== undefined && value < schema.__min && !(schema.__allow_zero && value === 0)) {
      fail(`expected >= ${schema.__min}, got ${value}`, `>= ${schema.__min}`);
    }
    // Only enforced maxima exist: CFG projects no advisory __max.
    if (schema.__max !== undefined && value > schema.__max) fail(`expected <= ${schema.__max}, got ${value}`, `<= ${schema.__max}`);
  }
  if (schema.__enum && !schema.__enum.includes(value)) {
    throw new AgentOSConfigError(`${keyPath}: value ${JSON.stringify(value)} not in allowlist ${fmtEnum(schema.__enum)}`, {
      key: keyPath, expected: `one of ${fmtEnum(schema.__enum)}`, allowed: schema.__enum, got: value, source,
    });
  }
  if (schema.__disallow?.includes(value)) fail(`value ${JSON.stringify(value)} is not allowed`, `not one of ${fmtEnum(schema.__disallow)}`);
  if (schema.__normalize && Object.hasOwn(schema.__normalize, value)) return schema.__normalize[value];
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

export function buildLineMap(text, allowedTopKeys) {
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

// Mirrors agent_os_config.validation._validate_dict_present_keys_only:
// returns only present keys (no default fill). `tolerateUnknown` (operator
// overlays and runtime loads) drops unknown keys at any depth instead of
// raising, so a key from a newer schema cannot crash a lagging daemon;
// consumed atomic policies (`__strict_always`) never tolerate.
export function validateDictPresentKeysOnly(
  doc,
  schema,
  keyPath,
  source,
  lineMap,
  tolerateUnknown = false,
  { warnUnknownOnce = false, warningSource = null, droppedUnknownKeys = null } = {},
) {
  const strictAlways = Boolean(schema.__strict_always);
  if ((doc === null || doc === undefined) && strictAlways) {
    throw new AgentOSConfigError(`${keyPath}: expected mapping`, { key: keyPath, source });
  }
  if (doc === null || doc === undefined) return {};
  const allowed = schema.__keys || {};
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    const scalarKey = schema.__scalar_default_key;
    if (typeof scalarKey === 'string' && Object.hasOwn(allowed, scalarKey)) {
      return { [scalarKey]: checkLeaf(doc, allowed[scalarKey], keyPath ? `${keyPath}.${scalarKey}` : scalarKey, source, tolerateUnknown, { warnUnknownOnce, warningSource, droppedUnknownKeys }) };
    }
    const anchor = keyPath || '(root)';
    throw new AgentOSConfigError(`${anchor}: expected mapping, got ${jsTypeName(doc)}`, {
      key: anchor, expected: 'mapping', got: jsTypeName(doc), source,
    });
  }
  if (strictAlways) {
    tolerateUnknown = false;
    if (Object.keys(doc).some(key => key.startsWith('__'))) {
      throw new AgentOSConfigError(`${keyPath}: unknown policy key`, { key: keyPath, source });
    }
  }
  // CFG requires complete atomic declarations (array items, keyed policies,
  // and version); keep Python parity rather than deferring security completeness.
  for (const [key, child] of Object.entries(allowed)) {
    if (child.__required && !Object.hasOwn(doc, key)) {
      const full = keyPath ? `${keyPath}.${key}` : key;
      throw new AgentOSConfigError(`${full}: required key is missing`, { key: full, expected: 'required key', got: null, source });
    }
  }
  const strict = schema.__strict !== false;
  const extraSchema = schema.__extra_keys_schema || null;
  const nested = { warnUnknownOnce, warningSource: warningSource || source, droppedUnknownKeys };
  const out = {};
  for (const [key, raw] of Object.entries(doc)) {
    // Metadata keys (`__aliases`, ...) are skipped, as in Python.
    if (key.startsWith('__') && !strictAlways) continue;
    const full = keyPath ? `${keyPath}.${key}` : key;
    const childSource = annotateLine(source, lineMap, key);
    if (!Object.hasOwn(allowed, key)) {
      if (!strict && extraSchema) {
        out[key] = extraSchema.__type === TYPE_DICT
          ? validateDictPresentKeysOnly(raw, extraSchema, full, childSource, null, tolerateUnknown, nested)
          : checkLeaf(raw, extraSchema, full, childSource, tolerateUnknown, nested);
      } else if (strict) {
        const near = nearestValidKey(key, Object.keys(allowed));
        const hint = near ? ` did you mean ${keyPath ? `${keyPath}.` : ''}${JSON.stringify(near)}?` : '';
        if (!tolerateUnknown) {
          throw new AgentOSConfigError(`${full}: unknown key (strict schema)${hint}`, {
            key: full, expected: `one of ${JSON.stringify(Object.keys(allowed).sort())}`, got: key, source: childSource,
          });
        }
        if (warnUnknownOnce) {
          warnRuntimeUnknownKeyOnce(full, nested.warningSource, hint);
          droppedUnknownKeys?.push({ key: full, source: runtimeWarningSource(nested.warningSource), hint: hint.trim() });
        } else {
          configDebugLog(`dropping unknown key ${JSON.stringify(full)}${source ? ` (${source})` : ''} — not in this reader's schema`);
        }
      } // An open section without a typed extra schema drops the child, as in Python.
      continue;
    }
    const child = allowed[key];
    if (child.__type === TYPE_DICT) {
      out[key] = validateDictPresentKeysOnly(raw, child, full, childSource, null, tolerateUnknown, nested);
      continue;
    }
    if (child.__read_only) {
      throw new AgentOSConfigError(`${full}: read-only diagnostic value (${child.__read_only})`, {
        key: full, expected: 'not configured in YAML', got: raw, source: childSource,
      });
    }
    out[key] = checkLeaf(raw, child, full, childSource, tolerateUnknown, nested);
  }
  return out;
}

export function validateSchema(doc, options = {}) {
  const validated = validateSchemaLayer(doc, options);
  validateOAuthDeclarations(validated.oauth ?? {}, null, options.source);
  validateSearch(validated.services?.hcp?.search);
  validatePublicHygiene(validated.worker_pool?.public_hygiene);
  return validated;
}

// Cascade layers may reference accounts from another layer or be superseded.
// Only the public single-document validator and final merged config validate
// declaration semantics; this private layer validator preserves atomic maps.
export function validateSchemaLayer(
  doc,
  {
    schema = schemaV1(),
    source = null,
    rawText = null,
    tolerateUnknown = false,
    warnUnknownOnce = false,
    droppedUnknownKeys = null,
  } = {},
) {
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
  if (Object.hasOwn(doc, 'osg')) validateOsgShape(doc.osg, source, schema);

  return validateDictPresentKeysOnly(
    doc,
    schema,
    '',
    source,
    lineMap,
    tolerateUnknown,
    {
      warnUnknownOnce,
      warningSource: source,
      droppedUnknownKeys,
    },
  );
}

// -------- Module file validation -------------------------------------------

export function isEmptyDoc(doc) {
  if (doc === null || doc === undefined) return true;
  if (typeof doc !== 'object') return false;
  if (Array.isArray(doc)) return false;
  return Object.keys(doc).length === 0;
}

// -------- Convenience wrapper ----------------------------------------------
