// ONS-07 — the generated Node config validator agrees with the Python loader.
//
// fixtures/cfg-parity-cases.*.json hold YAML inputs and the verdict the
// Python CFG loader returned for each (recorded offline with
// scripts/record-cfg-parity-cases.py). Both readers must accept the same
// documents with the same resolved values, and refuse the same documents at
// the same key: cascade order (code, module, top, local, env), unknown keys,
// leaf annotations, env coercion and merged-config semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { _resetCodeDefaultsForTesting } from '../src/config-cascade.mjs';
import { AgentOSConfigError, ENV_ALIASES, loadConfig, loadConfigRuntime } from '../src/config-loader.mjs';
import { CFG_JSON_SCHEMA, schemaV1 } from '../src/config-schema.mjs';

// Keep independently recorded revisions separate so each source remains accurate.
const cases = ['cfg-parity-cases.v1.json', 'cfg-parity-cases.cfgnodeschema-01.json']
  .flatMap(file => JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')).cases);

for (const { name, files, modules = [], env = {}, get = [], python } of cases) {
  test(`CFG parity: ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-parity-'));
    try {
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), text);
      }
      const load = () => loadConfig({
        topPath: join(dir, 'config.yaml'), modulePaths: modules.map(file => join(dir, file)), env,
      });
      if (!python.ok) {
        assert.throws(load, error => error instanceof AgentOSConfigError && error.key === python.key,
          `Python refused at ${python.key}`);
        return;
      }
      const cfg = load();
      for (const key of get) assert.deepEqual(cfg.get(key), python.values[key], key);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('the Node schema is exactly CFG: no Node-only key or enum member remains', () => {
  const nodePaths = new Set();
  (function walk(node, path) {
    nodePaths.add(path);
    for (const [key, child] of Object.entries(node.__keys ?? {})) walk(child, path ? `${path}.${key}` : key);
    if (node.__item) walk(node.__item, `${path}[]`);
    if (node.__extra_keys_schema) walk(node.__extra_keys_schema, `${path}.*`);
  })(schemaV1(), '');
  const cfgPaths = new Set();
  (function walk(js, path) {
    // Visit every non-null alternative: branch order and multiple alternatives
    // must never hide child keys from parity coverage.
    for (const branch of js.anyOf ?? []) if (branch.type !== 'null') walk(branch, path);
    cfgPaths.add(path);
    for (const [key, child] of Object.entries(js.properties ?? {})) walk(child, path ? `${path}.${key}` : key);
    if (js.items) walk(js.items, `${path}[]`);
    if (typeof js.additionalProperties === 'object') walk(js.additionalProperties, `${path}.*`);
  })(CFG_JSON_SCHEMA, '');
  assert.deepEqual([...cfgPaths].filter(path => !nodePaths.has(path)), []);
  assert.deepEqual([...nodePaths].filter(path => !cfgPaths.has(path)), []);
  const enumOf = dotted => dotted.split('.').reduce((node, key) => node.__keys[key], schemaV1()).__enum;
  assert.ok(enumOf('roles.remediator').includes('gemini'));
  assert.ok(enumOf('roles.merge_agent_worker_class').includes('hammer-claude'));
});

test('the env alias table is the generated CFG table and names real schema keys', () => {
  const cfgEnv = JSON.parse(readFileSync(new URL('../src/generated/config.env.json', import.meta.url), 'utf8'));
  const paths = [...cfgEnv.derived, ...Object.keys(cfgEnv.rows)];
  const positional = Object.entries(cfgEnv.rows).filter(([, row]) => row.some(item => item?.positional_aliases)).map(([path]) => path);
  assert.deepEqual(positional, ['worker_pool.oauth_broker.endpoints']);
  assert.deepEqual(Object.keys(ENV_ALIASES).sort(), paths.filter(path => path !== 'profile' && !positional.includes(path)).sort());
  const resolves = (node, dotted) => dotted.split('.').reduce((cur, key) => cur?.__keys?.[key]
    ?? cur?.__extra_keys_schema, node);
  for (const path of Object.keys(ENV_ALIASES)) assert.ok(resolves(schemaV1(), path), `${path} is not a CFG key`);
  assert.deepEqual(ENV_ALIASES['reviewer.timeout_ms'].aliases.map(([name]) => name), ['ADVERSARIAL_REVIEWER_TIMEOUT_MS']);
  assert.equal(ENV_ALIASES['reviewer.timeout_ms'].canonical, 'AGENT_OS_REVIEWER_TIMEOUT_MS');
  assert.equal(ENV_ALIASES['session_ledger.backend'].aliases[0][1]('ON'), 'postgres');
  assert.equal(ENV_ALIASES['worker_pool.dispatch.idle_backoff.enabled'].aliases[0][1](' 0 '), 'false');
});

test('refreshed defaults and disk reclaim aliases resolve on independent loads', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-defaults-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const topPath = join(dir, 'config.yaml');
  writeFileSync(topPath, 'version: 1\n');

  const first = loadConfig({ topPath, env: {} });
  assert.equal(first.get('worker_pool.work_items.shadow_gate_days'), 7);
  assert.equal(first.get('worker_pool.admission.low_priority_max_wait_seconds'), 3600);
  assert.equal(first.get('worker_pool.admission.low_priority_reserved_slots'), 1);
  const listKey = 'roles.adversarial.merge_authority.no_ci_repositories';
  first.get(listKey).push('example/fixture');

  const second = loadConfig({ topPath, env: {
    AGENT_OS_DISK_RECLAIM_ARCHIVE_REF_RETENTION_DAYS: '14',
    AGENT_OS_DISK_RECLAIM_DEHYDRATE_UNRECLAIMABLE_RECHECK_HOURS: '3',
  } });
  assert.deepEqual(second.get(listKey), []);
  assert.deepEqual(second.resolutionTrace(listKey), [
    { source: 'code-default', value: [], path: null },
  ]);
  for (const [key, defaultValue, override] of [
    ['disk_reclaim.archive_ref_retention_days', 30, 14],
    ['disk_reclaim.dehydrate.unreclaimable_recheck_hours', 6, 3],
  ]) {
    assert.equal(first.get(key), defaultValue);
    assert.equal(second.get(key), override);
    assert.equal(second.resolutionTrace(key)[0].value, defaultValue);
  }

  _resetCodeDefaultsForTesting();
  const afterReset = loadConfig({ topPath, env: {} });
  const retentionKey = 'disk_reclaim.archive_ref_retention_days';
  assert.equal(afterReset.get(retentionKey), 30);
  assert.deepEqual(afterReset.resolutionTrace(retentionKey), [
    { source: 'code-default', value: 30, path: null },
  ]);
});

// Intended difference: Python's strict input validation rejects an ordinary
// unread sibling in a checked-in file; Node's runtime reader drops it so a key
// from a newer schema cannot crash a lagging daemon. Keys Node consumes, and
// strict-always declarations, validate identically in both.
test('an ordinary unread sibling is rejected by Python strict input and dropped by the Node runtime reader', () => {
  for (const name of ['unknown nested key in checked-in top', 'unknown root in checked-in top']) {
    const { files, python } = cases.find(candidate => candidate.name === name);
    assert.equal(python.ok, false, `${name}: Python refuses`);
    const dir = mkdtempSync(join(tmpdir(), 'cfg-parity-'));
    try {
      for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
      const topPath = join(dir, 'config.yaml');
      assert.throws(() => loadConfig({ topPath, env: {} }), error => error.key === python.key);
      const cfg = loadConfigRuntime({ topPath, env: {} });
      assert.ok(cfg.runtimeDroppedUnknownKeys.some(entry => entry.key === python.key), `${name}: dropped and reported`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const { files, python } = cases.find(candidate => candidate.name === 'unknown key in strict-always policy fails even in local');
  const dir = mkdtempSync(join(tmpdir(), 'cfg-parity-'));
  try {
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    assert.throws(() => loadConfigRuntime({ topPath: join(dir, 'config.yaml'), env: {} }), error => error.key === python.key);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
