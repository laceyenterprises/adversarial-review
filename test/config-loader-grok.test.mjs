// GRK-09 — Grok knobs and default-off lane flags: Node mirror parity.
//
// `fixtures/grok-config-parity.v1.json` is an identical copy of the Agent OS
// parity contract that the Python and shell readers check. Every value in it is
// synthetic. No live config, sibling repository or credential is read here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentOSConfigError,
  ENV_ALIASES,
  loadConfig,
  loadConfigRuntime,
} from '../src/config-loader.mjs';
import {
  GROK_LANE_FLAGS,
  GROK_ROLE_PIN_LANES,
  grokLaneEnabled,
  grokRolePinViolations,
  grokSchema,
} from '../src/config-grok.mjs';

const CONTRACT = JSON.parse(
  readFileSync(new URL('./fixtures/grok-config-parity.v1.json', import.meta.url), 'utf8'),
);

function withCase({ top, local }, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-grok-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, top);
    if (local !== undefined) writeFileSync(join(dir, 'config.local.yaml'), local);
    return fn(topPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function schemaLeaf(schema, dotted) {
  let node = schema;
  for (const part of dotted.slice('grok.'.length).split('.')) node = node.__keys[part];
  return node;
}

test('GRK-09: Node grok schema matches the parity snapshot', () => {
  const schema = grokSchema();
  assert.equal(schema.__strict, true);
  const leaves = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.__keys)) {
      if (child.__type === 'dict') walk(child, `${prefix}.${name}`);
      else leaves.push(`${prefix}.${name}`);
    }
  };
  walk(schema, 'grok');
  assert.deepEqual(leaves.sort(), Object.keys(CONTRACT.schema).sort());
  for (const [dotted, spec] of Object.entries(CONTRACT.schema)) {
    const leaf = schemaLeaf(schema, dotted);
    assert.equal(leaf.__type, spec.type, dotted);
    assert.equal(leaf.__default ?? null, spec.default, dotted);
    assert.equal(Boolean(leaf.__nullable), Boolean(spec.nullable), dotted);
    assert.equal(leaf.__pattern, spec.pattern, dotted);
    assert.equal(leaf.__min, spec.min, dotted);
    assert.equal(leaf.__max, spec.max, dotted);
    // Node enforces a declared __max unless __enforceMax is false.
    assert.notEqual(leaf.__enforceMax, false, dotted);
  }
});

test('GRK-09: every enable flag defaults false', () => {
  const flags = Object.keys(CONTRACT.schema).filter((key) => key.endsWith('.enabled'));
  assert.deepEqual(flags.sort(), ['grok.enabled', ...GROK_LANE_FLAGS.map((lane) => `grok.${lane}.enabled`)].sort());
  const cfg = withCase({ top: 'version: 1\n' }, (topPath) => loadConfig({ topPath, env: {} }));
  for (const flag of flags) assert.equal(cfg.get(flag), false, flag);
});

test('GRK-09: env aliases and role-pin lanes match the snapshot', () => {
  for (const [dotted, canonical] of Object.entries(CONTRACT.envAliases)) {
    assert.deepEqual(ENV_ALIASES[dotted], { canonical, aliases: [] }, dotted);
  }
  const grokAliasKeys = Object.keys(ENV_ALIASES).filter((key) => key.startsWith('grok.'));
  assert.deepEqual(grokAliasKeys.sort(), Object.keys(CONTRACT.envAliases).sort());
  assert.deepEqual(JSON.parse(JSON.stringify(GROK_ROLE_PIN_LANES)), CONTRACT.rolePinLanes);
});

test('GRK-09: the grok root holds no credential, account or custody field', () => {
  const forbidden = /op_ref|token|secret|account|custody|api_key|allowed_models|pool/;
  for (const dotted of Object.keys(CONTRACT.schema)) assert.doesNotMatch(dotted, forbidden, dotted);
});

for (const contractCase of CONTRACT.cases) {
  for (const loader of [loadConfig, loadConfigRuntime]) {
    test(`GRK-09 parity case ${contractCase.name} (${loader.name})`, () => {
      withCase(contractCase, (topPath) => {
        const load = () => loader({ topPath, env: contractCase.env ?? {} });
        if (contractCase.errorKey) {
          assert.throws(load, (error) => {
            assert.ok(error instanceof AgentOSConfigError, String(error));
            assert.equal(error.key, contractCase.errorKey);
            return true;
          });
          return;
        }
        const cfg = load();
        for (const [dotted, expected] of Object.entries(contractCase.expect)) {
          assert.deepEqual(cfg.get(dotted), expected, dotted);
        }
      });
    });
  }
}

test('GRK-09: effective trace names the winning layer for an override', () => {
  withCase({ top: 'version: 1\ngrok:\n  stall_timeout_seconds: 600\n' }, (topPath) => {
    const cfg = loadConfig({ topPath, env: { AGENT_OS_GROK_STALL_TIMEOUT_SECONDS: '900' } });
    assert.equal(cfg.get('grok.stall_timeout_seconds'), 900);
    const trace = cfg.resolutionTrace('grok.stall_timeout_seconds');
    assert.equal(trace.at(-1).source, 'env:AGENT_OS_GROK_STALL_TIMEOUT_SECONDS');
    assert.equal(trace.at(-1).value, 900);
  });
});

test('GRK-09: a role-pin refusal names the pin and flag, not other config values', () => {
  const top = 'version: 1\ngrok:\n  model: grok-synthetic-secretish\n  cli_path: /synthetic/private/grok\nroles:\n  remediator: remediator-grok\n';
  withCase({ top }, (topPath) => {
    assert.throws(() => loadConfig({ topPath, env: {} }), (error) => {
      assert.ok(error instanceof AgentOSConfigError);
      assert.equal(error.key, 'roles.remediator');
      assert.equal(error.expected, 'grok.enabled: true');
      assert.match(error.message, /remediator-grok.*disabled Grok lane.*grok\.enabled: true/);
      assert.doesNotMatch(error.message, /secretish|synthetic\/private/);
      return true;
    });
  });
});

test('GRK-09: a lane needs both the master switch and its own flag', () => {
  const doc = (enabled, lane) => ({ grok: { enabled, reviewer: { enabled: lane } } });
  assert.equal(grokLaneEnabled(doc(false, true), 'reviewer'), false);
  assert.equal(grokLaneEnabled(doc(true, false), 'reviewer'), false);
  assert.equal(grokLaneEnabled(doc(true, true), 'reviewer'), true);
  assert.equal(grokLaneEnabled(doc(true, false), 'builder'), true);
  assert.equal(grokLaneEnabled({}, 'hammer'), false);
  assert.throws(() => grokLaneEnabled({}, 'closer'), /unknown grok lane/);
  assert.deepEqual(grokRolePinViolations({ roles: { reviewer: 'grok' }, grok: { enabled: true } }), [
    { key: 'roles.reviewer', value: 'grok', required: 'grok.reviewer.enabled' },
  ]);
  assert.deepEqual(grokRolePinViolations({ roles: { reviewer: 'codex' }, grok: {} }), []);
});
