import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadConfig, loadConfigRuntime, AgentOSConfigError } from '../src/config-loader.mjs';
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

for (const value of [0, -1]) test(`remediation rejects non-positive concurrency ${value}`, () => {
  fixture(`version: 1\nremediation:\n  max_concurrent_jobs: ${value}\n`, topPath => {
    assert.throws(() => loadConfig({ topPath, env: {} }), e => e instanceof AgentOSConfigError && e.key === 'remediation.max_concurrent_jobs');
  });
});

test('schema sync accepts --check before or after its root without mutating the vendor', () => {
  fixture('version: 1\n', (_topPath, dir) => {
    const target = new URL('../src/generated/config.schema.json', import.meta.url);
    const before = readFileSync(target, 'utf8');
    mkdirSync(join(dir, 'platform/contracts/generated'), { recursive: true });
    writeFileSync(join(dir, 'platform/contracts/generated/config.schema.json'), before);
    for (const args of [['--check', dir], [dir, '--check']]) {
      const r = spawnSync(process.execPath, ['scripts/sync-cfg-schema.mjs', ...args], { encoding: 'utf8', timeout: 5000 });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /in sync/);
    }
    assert.equal(readFileSync(target, 'utf8'), before);
  });
});
