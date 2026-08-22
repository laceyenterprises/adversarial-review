/**
 * Where Screen B's governance values come from (ARF-04).
 *
 * The pipeline resolves `roles.adversarial.merge_authority.*` through a layered
 * config stack (`src/config-loader.mjs`):
 *
 *   1. code defaults
 *   2. the module file        `config.yaml`
 *   3. the module local file  `config.local.yaml`
 *   5. environment variables  (`AGENT_OS_ROLES_ADVERSARIAL_...`)
 *   6. CLI flags
 *
 * ARF reproduces layers 1–4 by reading the files, and reports layer 5 only when
 * it is given a source it can actually read.
 *
 * ### Why the environment layer is reported as unobservable by default
 *
 * Layer 5 wins over every file, and the daemon's `process.env` is frozen at its
 * boot. ARF is a *different process*: reading its own `process.env` would
 * describe ARF's environment and label it the watcher's, which is worse than
 * saying nothing — a plist-pinned
 * `AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_AUTONOMOUS_MERGE_EXECUTION_ENABLED`
 * is exactly the override that silently wins, and the 2026-07-26 SEV is the
 * recorded case of an operator believing a file edit had taken effect when it
 * had not.
 *
 * So the env layer is read only from an explicitly configured snapshot
 * (`pipeline.envFile`, a JSON object of variable → value, which a supervisor or
 * an operator can produce from the running daemon). With no snapshot the result
 * carries `envLayer.observable: false`, every key that has an env override
 * carries an `env-layer-not-observable` caveat, and the panel says so out loud
 * rather than presenting a file value as the effective one.
 */

import { readFileSync, statSync } from 'node:fs';

import { GOVERNANCE_KEYS } from './keys.mjs';
import { readScalarYaml } from './scalar-yaml.mjs';

/** Caveat id for "a layer that outranks this value could not be read". */
export const ENV_LAYER_UNOBSERVABLE = 'env-layer-not-observable';

/** Coerce an env-var string the way a boolean/integer key would read it. */
function coerceEnv(entry, raw) {
  const token = String(raw).trim();
  if (entry.type === 'boolean') {
    const lower = token.toLowerCase();
    if (lower === 'true' || lower === '1') return { ok: true, value: true };
    if (lower === 'false' || lower === '0') return { ok: true, value: false };
    return { ok: false, reason: `env ${entry.env}=${JSON.stringify(token)} is not a boolean` };
  }
  if (entry.type === 'integer') {
    if (!/^-?\d+$/.test(token)) {
      return { ok: false, reason: `env ${entry.env}=${JSON.stringify(token)} is not an integer` };
    }
    return { ok: true, value: Number(token) };
  }
  return { ok: true, value: token };
}

/** Validate a value read out of YAML against the key's declared type. */
function checkType(entry, value) {
  if (entry.type === 'boolean') {
    return typeof value === 'boolean'
      ? { ok: true, value }
      : { ok: false, reason: `expected a boolean, found ${JSON.stringify(value)}` };
  }
  if (entry.type === 'integer') {
    return Number.isInteger(value)
      ? { ok: true, value }
      : { ok: false, reason: `expected an integer, found ${JSON.stringify(value)}` };
  }
  return { ok: true, value };
}

/** Read one config layer, degrading an unreadable file to a described absence. */
function readLayer(spec) {
  const descriptor = {
    path: spec.path,
    label: spec.label ?? spec.path,
    present: false,
    readable: false,
    modifiedAt: null,
    reason: null,
  };
  let stat;
  try {
    stat = statSync(spec.path);
  } catch (err) {
    descriptor.reason = err && err.code === 'ENOENT' ? null : `unreadable: ${err.message}`;
    return { descriptor, doc: null };
  }
  if (!stat.isFile()) {
    descriptor.reason = 'not a regular file';
    return { descriptor, doc: null };
  }
  descriptor.present = true;
  descriptor.modifiedAt = new Date(stat.mtimeMs).toISOString();
  let text;
  try {
    text = readFileSync(spec.path, 'utf8');
  } catch (err) {
    descriptor.reason = `unreadable: ${err.message}`;
    return { descriptor, doc: null };
  }
  const doc = readScalarYaml(text);
  descriptor.readable = true;
  if (doc.fatal) descriptor.reason = doc.fatal;
  return { descriptor, doc };
}

/** Read the env snapshot, if one is configured. */
function readEnvSnapshot(path) {
  if (!path) {
    return {
      observable: false,
      source: null,
      values: null,
      reason: 'no daemon environment snapshot configured; ARF cannot read another '
        + "process's environment, and config layer 5 (env) outranks every file",
    };
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return {
      observable: false,
      source: path,
      values: null,
      reason: `environment snapshot ${path} is unreadable: ${err.message}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      observable: false,
      source: path,
      values: null,
      reason: `environment snapshot ${path} is not valid JSON: ${err.message}`,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      observable: false,
      source: path,
      values: null,
      reason: `environment snapshot ${path} must contain a JSON object of variable → value`,
    };
  }
  return { observable: true, source: path, values: parsed, reason: null };
}

/**
 * Resolve every governance key across the configured layers.
 *
 * @param {object} options
 * @param {{path: string, label?: string}[]} options.files layers, LOWEST precedence first
 * @param {string|null} [options.envFile] JSON snapshot of the daemon's environment
 * @returns {{sources: object[], envLayer: object, keys: Record<string, object>, anySourceReadable: boolean}}
 */
export function readGovernanceConfig({ files = [], envFile = null } = {}) {
  const layers = files.map((spec) => readLayer(spec));
  const anySourceReadable = layers.some((layer) => layer.descriptor.readable);
  const envLayer = readEnvSnapshot(envFile);

  const keys = {};
  for (const entry of Object.values(GOVERNANCE_KEYS)) {
    keys[entry.id] = resolveKey(entry, { layers, envLayer, anySourceReadable });
  }

  return {
    sources: layers.map((layer) => layer.descriptor),
    envLayer: {
      observable: envLayer.observable,
      source: envLayer.source,
      reason: envLayer.reason,
    },
    keys,
    anySourceReadable,
  };
}

function resolveKey(entry, { layers, envLayer, anySourceReadable }) {
  const resolved = {
    id: entry.id,
    key: entry.key,
    label: entry.label,
    group: entry.group ?? 'merge-authority',
    type: entry.type,
    env: entry.env,
    killSwitch: entry.killSwitch,
    note: entry.note,
    schemaDefault: entry.default,
    value: null,
    /**
     * `known: false` means ARF could not establish this key's value. It is NOT
     * the same as `value: false`, and `merge-paths.mjs` must treat it as
     * neither armed nor disarmed — a governance panel that rounds "I could not
     * tell" toward either answer is the specific defect this ticket exists to
     * prevent.
     */
    known: false,
    source: null,
    sourcePath: null,
    setIn: [],
    caveats: [],
    reason: null,
  };

  // Layers, lowest precedence first: the last one that carries a usable value
  // wins, exactly as the pipeline's loader resolves them.
  for (const { descriptor, doc } of layers) {
    if (!doc || doc.fatal) continue;
    const raw = doc.get(entry.key);
    if (raw === undefined) {
      const refusal = doc.refusalFor(entry.key);
      if (refusal) {
        resolved.caveats.push(`${descriptor.path}: ${refusal}`);
        // A layer whose value ARF could not read may be setting this key to
        // anything, including the opposite of whatever a lower layer said.
        resolved.known = false;
        resolved.value = null;
        resolved.source = null;
        resolved.sourcePath = null;
        resolved.reason = `a config layer sets this key in a form ARF cannot read (${descriptor.path})`;
      }
      continue;
    }
    const checked = checkType(entry, raw);
    if (!checked.ok) {
      resolved.caveats.push(`${descriptor.path}: ${checked.reason}`);
      resolved.known = false;
      resolved.value = null;
      resolved.source = null;
      resolved.sourcePath = null;
      resolved.reason = `a config layer sets this key to a value of the wrong type (${descriptor.path})`;
      continue;
    }
    resolved.value = checked.value;
    resolved.known = true;
    resolved.source = 'file';
    resolved.sourcePath = descriptor.path;
    resolved.reason = null;
    resolved.setIn.push({ path: descriptor.path, value: checked.value });
  }

  if (!resolved.known && resolved.reason === null) {
    if (anySourceReadable) {
      // No layer sets it, and at least one layer was readable — so the pipeline
      // would use its own schema default. That default comes from
      // `config-loader.mjs`, not from ARF's taste.
      resolved.value = entry.default;
      resolved.known = true;
      resolved.source = 'default';
    } else {
      resolved.reason = 'no governance config source was readable';
    }
  }

  // Layer 5. An observable snapshot overrides every file value; an
  // unobservable one leaves a caveat on any key an env var could override.
  if (entry.env) {
    if (envLayer.observable) {
      const raw = envLayer.values[entry.env];
      if (raw !== undefined && String(raw).trim() !== '') {
        const coerced = coerceEnv(entry, raw);
        if (coerced.ok) {
          resolved.value = coerced.value;
          resolved.known = true;
          resolved.source = 'env';
          resolved.sourcePath = envLayer.source;
          resolved.reason = null;
          resolved.setIn.push({ path: `env:${entry.env}`, value: coerced.value });
        } else {
          resolved.known = false;
          resolved.value = null;
          resolved.source = null;
          resolved.reason = coerced.reason;
        }
      }
    } else {
      resolved.caveats.push(ENV_LAYER_UNOBSERVABLE);
    }
  }

  return resolved;
}
