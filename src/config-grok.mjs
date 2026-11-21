// GRK-09 — Grok harness knobs and default-off lane policy (Node CFG mirror).
//
// Mirrors the Python `grok` schema root and lane policy in Agent OS
// (`agent_os_config/schema_v1/misc.py` and `agent_os_config/grok_lanes.py`).
// The shared parity contract is `test/fixtures/grok-config-parity.v1.json`,
// an identical copy of the Agent OS fixture; values there are synthetic.
//
// Parse-only (CFGREADERSCOPE-01): the `grok` schema itself is generated from
// CFG (config-schema.mjs, ONS-07); this module refuses a role pin that names a
// disabled Grok lane. It does not
// select, dispatch or run any Grok lane; enabling a lane here makes nothing
// dispatchable on its own.
//
// `grok.enabled` is the harness master switch; each acting lane also needs its
// own flag. Account `allowed_models` and pool order stay in
// `oauth.token_accounts`; API-key op refs and custody roots stay in
// `oauth.broker_instances`. The `grok` root holds no credential, account or
// custody field.

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
  'reviewer.mode',
  ...GROK_LANE_FLAGS.map((lane) => `${lane}.enabled`),
]);

// Canonical env names only (no legacy aliases), matching the Python table.
export function grokEnvAliases() {
  return Object.fromEntries(GROK_ENV_KEYS.map((key) => [`grok.${key}`, {
    canonical: `AGENT_OS_GROK_${key.replace('.', '_').toUpperCase()}`,
    aliases: [],
  }]));
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
