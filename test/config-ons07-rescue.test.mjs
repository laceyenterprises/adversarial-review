import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  loadConfig, loadConfigRuntime, AgentOSConfigError,
  ENUM_ROLES_ADVERSARIAL_OPERATOR_LABEL_ACTOR_ENFORCEMENT,
  ENUM_ROLES_ADVERSARIAL_MERGE_CAPABILITY_ENFORCEMENT,
} from '../src/config-loader.mjs';
import { fromJsonSchema } from '../src/config-schema.mjs';

function fixture(body, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ons07-review-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, body);
    return fn(topPath, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('runtime tolerance reaches unknown keys inside list records; strict reads still refuse', () => {
  fixture('version: 1\nworker_pool:\n  secrets:\n    prewarm:\n      targets:\n        - worker_class: example\n          future_field: true\n', topPath => {
    const cfg = loadConfigRuntime({ topPath, env: {} });
    assert.deepEqual(cfg.get('worker_pool.secrets.prewarm.targets'), [{ worker_class: 'example' }]);
    assert.throws(() => loadConfig({ topPath, env: {} }), e => e instanceof AgentOSConfigError && e.key.endsWith('.future_field'));
  });
});

test('null vault opt-in produces a config diagnostic or empty policy, never a runtime TypeError', () => {
  fixture('version: 1\nworker_pool:\n  secrets:\n    worker_class_vaults:\n      example:\n        shared_vault_optin: null\n', topPath => {
    try { loadConfig({ topPath, env: {} }); }
    catch (e) { assert.ok(e instanceof AgentOSConfigError); assert.match(e.key, /shared_vault_optin/); }
  });
});

test('fallback vault errors name the actual default policy rather than a synthetic worker class', () => {
  fixture('version: 1\nworker_pool:\n  secrets:\n    default_vault_policy:\n      vault: ExampleVault\n', topPath => {
    assert.throws(() => loadConfig({ topPath, env: {} }), e => e instanceof AgentOSConfigError && e.key === 'worker_pool.secrets.default_vault_policy.service_account_token_ref');
  });
});

test('nullable schema branch ordering is immaterial and undeclared required fields fail explicitly', () => {
  assert.deepEqual(fromJsonSchema({ anyOf: [{ type: 'null' }, { type: 'string' }] }), fromJsonSchema({ anyOf: [{ type: 'string' }, { type: 'null' }] }));
  assert.throws(() => fromJsonSchema({ type: 'object', required: ['missing'] }), /required CFG property has no declared schema/);
});

test('allow-zero schema branch order does not change its contract', () => {
  const branches = [{ const: 0 }, { minimum: 3 }];
  assert.deepEqual(fromJsonSchema({ type: 'integer', anyOf: branches }),
    fromJsonSchema({ type: 'integer', anyOf: [...branches].reverse() }));
  assert.throws(() => fromJsonSchema({ type: 'integer', anyOf: [{ const: 0 }, {}] }), /unsupported anyOf/);
});

test('adversarial enforcement enum exports retain the schema contract', () => {
  for (const values of [ENUM_ROLES_ADVERSARIAL_OPERATOR_LABEL_ACTOR_ENFORCEMENT,
    ENUM_ROLES_ADVERSARIAL_MERGE_CAPABILITY_ENFORCEMENT]) {
    assert.ok(values.includes('enforce'));
    assert.ok(Object.isFrozen(values));
  }
});

for (const key of ['disabled_repositories', 'lane_routes']) {
  test(`null ${key} uses the standard config diagnostic`, () => {
    fixture(`version: 1\nroles:\n  adversarial:\n    merge_authority:\n      ${key}: null\n`, topPath => {
      assert.throws(() => loadConfig({ topPath, env: {} }), error => error instanceof AgentOSConfigError
        && error.key.endsWith(`.${key}`) && /expected .*got null/.test(error.message));
    });
  });
}

test('a missing vault leaf is attributed to the file declaring its policy', () => {
  fixture('version: 1\nworker_pool:\n  secrets:\n    default_vault_policy:\n      vault: ExampleVault\n', topPath => {
    assert.throws(() => loadConfig({ topPath, env: {} }), error => error instanceof AgentOSConfigError
      && error.key.endsWith('.service_account_token_ref') && error.source === topPath);
  });
});

for (const value of [0, -1]) test(`remediation rejects non-positive concurrency ${value}`, () => {
  fixture(`version: 1\nremediation:\n  max_concurrent_jobs: ${value}\n`, topPath => {
    assert.throws(() => loadConfig({ topPath, env: {} }), e => e instanceof AgentOSConfigError && e.key === 'remediation.max_concurrent_jobs');
  });
});

test('schema sync accepts --check before or after its root without mutating the vendor', () => {
  fixture('version: 1\n', (_topPath, dir) => {
    const names = ['config.schema.json', 'config.env.json'];
    const before = names.map(name => readFileSync(new URL(`../src/generated/${name}`, import.meta.url), 'utf8'));
    mkdirSync(join(dir, 'platform/contracts/generated'), { recursive: true });
    names.forEach((name, index) => writeFileSync(join(dir, 'platform/contracts/generated', name), before[index]));
    for (const args of [['--check', dir], [dir, '--check']]) {
      const r = spawnSync(process.execPath, ['scripts/sync-cfg-schema.mjs', ...args], { encoding: 'utf8', timeout: 5000 });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /config\.schema\.json: in sync[\s\S]*config\.env\.json: in sync/);
    }
    writeFileSync(join(dir, 'platform/contracts/generated/config.env.json'), '{"derived":[],"rows":{}}');
    const drifted = spawnSync(process.execPath, ['scripts/sync-cfg-schema.mjs', dir, '--check'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(drifted.status, 1);
    assert.match(drifted.stdout, /config\.env\.json: DRIFT/);
    names.forEach((name, index) => assert.equal(readFileSync(new URL(`../src/generated/${name}`, import.meta.url), 'utf8'), before[index]));
  });
});

test('nullable allow-zero projections retain the floor in every branch order', () => {
  const zero = { const: 0 }, floor = { minimum: 3 };
  const nullable = { type: 'null', title: 'Unset', description: 'Absence', $comment: 'metadata' };
  for (const branches of [[zero, floor, nullable], [nullable, floor, zero], [floor, nullable, zero]]) {
    const node = fromJsonSchema({ type: 'integer', anyOf: branches });
    assert.equal(node.__nullable, true);
    assert.equal(node.__allow_zero, true);
    assert.equal(node.__min, 3);
  }
  assert.throws(() => fromJsonSchema({ anyOf: [{ type: 'string' }, { type: 'null', not: {} }] }), /unsupported anyOf/);
});

test('recorder without a path reports usage before importing the Python loader', () => {
  const result = spawnSync('python3', ['scripts/record-cfg-parity-cases.py'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^usage: record-cfg-parity-cases/);
  assert.doesNotMatch(result.stderr, /Traceback/);
});
