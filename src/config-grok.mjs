// GRK-09 — Grok harness knobs and default-off lane policy (Node CFG mirror).
//
// Mirrors the Python `grok` schema root and lane policy in Agent OS
// (`agent_os_config/schema_v1/misc.py` and `agent_os_config/grok_lanes.py`).
// The shared parity contract is `test/fixtures/grok-config-parity.v1.json`,
// an identical copy of the Agent OS fixture; values there are synthetic.
//
// Parse-only (CFGREADERSCOPE-01): this module declares types, bounds and
// defaults and refuses a role pin that names a disabled Grok lane. It does not
// select, dispatch or run any Grok lane; enabling a lane here makes nothing
// dispatchable on its own.
//
// `grok.enabled` is the harness master switch; each acting lane also needs its
// own flag. Account `allowed_models` and pool order stay in
// `oauth.token_accounts`; API-key op refs and custody roots stay in
// `oauth.broker_instances`. The `grok` root holds no credential, account or
// custody field.

export const GROK_DEFAULT_MODEL = 'grok-build';
export const GROK_FIRST_OUTPUT_TIMEOUT_DEFAULT = 60;
export const GROK_FIRST_OUTPUT_TIMEOUT_MIN = 10;
export const GROK_FIRST_OUTPUT_TIMEOUT_MAX = 900;
export const GROK_STALL_TIMEOUT_DEFAULT = 300;
export const GROK_STALL_TIMEOUT_MIN = 30;
export const GROK_STALL_TIMEOUT_MAX = 3300;
// Requested model IDs are opaque provider IDs; bound their shape only.
export const GROK_MODEL_RE = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$';
// A configured path must be absolute. The worker adapter still requires it to
// name the managed pinned executable; it is never a PATH override.
export const GROK_CLI_PATH_RE = '^/[^\\x00]*$';

// Lanes with their own flag, beside the master switch.
export const GROK_LANE_FLAGS = Object.freeze(['reviewer', 'remediator', 'hammer', 'native_resume']);

// Role pins (dotted key -> {Grok enum value: lane}). Mirrors
// GROK_ROLE_PIN_LANES in agent_os_config/grok_lanes.py.
export const GROK_ROLE_PIN_LANES = Object.freeze({
  'roles.reviewer': Object.freeze({ grok: 'reviewer' }),
  'roles.remediator': Object.freeze({ 'remediator-grok': 'remediator' }),
  'roles.merge_agent_worker_class': Object.freeze({ 'hammer-grok': 'hammer' }),
});

export const GROK_ENV_KEYS = Object.freeze([
  'enabled',
  'model',
  'cli_path',
  'first_output_timeout_seconds',
  'stall_timeout_seconds',
  ...GROK_LANE_FLAGS.map((lane) => `${lane}.enabled`),
]);

// Canonical env names only (no legacy aliases), matching the Python table.
export function grokEnvAliases() {
  return Object.fromEntries(GROK_ENV_KEYS.map((key) => [`grok.${key}`, {
    canonical: `AGENT_OS_GROK_${key.replace('.', '_').toUpperCase()}`,
    aliases: [],
  }]));
}

export function grokSchema() {
  const lane = () => ({
    __type: 'dict',
    __strict: true,
    __keys: { enabled: { __type: 'bool', __default: false } },
  });
  return {
    __type: 'dict',
    __strict: true,
    __keys: {
      enabled: { __type: 'bool', __default: false },
      model: {
        __type: 'string',
        __default: GROK_DEFAULT_MODEL,
        __pattern: GROK_MODEL_RE,
        __pattern_description: 'a provider model ID',
      },
      // null = the managed pinned executable resolved by the worker adapter.
      cli_path: {
        __type: 'string',
        __default: null,
        __nullable: true,
        __pattern: GROK_CLI_PATH_RE,
        __pattern_description: 'an absolute path',
      },
      first_output_timeout_seconds: {
        __type: 'int',
        __default: GROK_FIRST_OUTPUT_TIMEOUT_DEFAULT,
        __min: GROK_FIRST_OUTPUT_TIMEOUT_MIN,
        __max: GROK_FIRST_OUTPUT_TIMEOUT_MAX,
      },
      stall_timeout_seconds: {
        __type: 'int',
        __default: GROK_STALL_TIMEOUT_DEFAULT,
        __min: GROK_STALL_TIMEOUT_MIN,
        __max: GROK_STALL_TIMEOUT_MAX,
      },
      ...Object.fromEntries(GROK_LANE_FLAGS.map((name) => [name, lane()])),
    },
  };
}

function readDotted(doc, dotted) {
  let node = doc;
  for (const part of dotted.split('.')) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)
      || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

// True only when the master switch and the lane flag are literally true. A
// missing key is disabled, never enabled.
export function grokLaneEnabled(doc, lane) {
  if (lane !== 'builder' && !GROK_LANE_FLAGS.includes(lane)) {
    throw new Error(`unknown grok lane ${JSON.stringify(lane)}`);
  }
  if (readDotted(doc, 'grok.enabled') !== true) return false;
  if (lane === 'builder') return true;
  return readDotted(doc, `grok.${lane}.enabled`) === true;
}

// [{ key, value, required }] for each role pin that names a disabled lane.
export function grokRolePinViolations(doc) {
  const violations = [];
  for (const [key, lanes] of Object.entries(GROK_ROLE_PIN_LANES)) {
    const value = readDotted(doc, key);
    const lane = typeof value === 'string' && Object.hasOwn(lanes, value) ? lanes[value] : null;
    if (lane === null || grokLaneEnabled(doc, lane)) continue;
    const required = readDotted(doc, 'grok.enabled') !== true ? 'grok.enabled' : `grok.${lane}.enabled`;
    violations.push({ key, value, required });
  }
  return violations;
}
