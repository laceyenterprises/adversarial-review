import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ENV_ALIASES, loadConfig, loadConfigRuntime } from '../src/config-loader.mjs';

function fixture(body, check) {
  const dir = mkdtempSync(join(tmpdir(), 'containment-config-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, `version: 1\n${body}`);
    check(topPath, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const load of [loadConfig, loadConfigRuntime]) {
  for (const [body, expected] of [
    ['', 'legacy'],
    ['worker_pool: {}\n', 'legacy'],
    ['worker_pool:\n  containment_mode: legacy\n', 'legacy'],
    ['worker_pool:\n  containment_mode: boundary-default\n', 'boundary-default'],
  ]) {
    test(`${load.name}: containment selection ${JSON.stringify(body)}`, () => {
      fixture(body, topPath => {
        assert.equal(load({ topPath, env: {} }).get('worker_pool.containment_mode'), expected);
      });
    });
  }

  for (const value of ['unknown', 'null', 'true', '7', '[]', '{}', '""']) {
    test(`${load.name}: refuses invalid containment value ${value}`, () => {
      fixture(`worker_pool:\n  containment_mode: ${value}\n`, topPath => {
        assert.throws(() => load({ topPath, env: {} }), /worker_pool\.containment_mode/);
      });
    });
  }

  test(`${load.name}: local selection survives payload environment downgrade`, () => {
    fixture('', (topPath, dir) => {
      writeFileSync(join(dir, 'config.local.yaml'), 'worker_pool:\n  containment_mode: boundary-default\n');
      const env = {
        AGENT_OS_WORKER_POOL_CONTAINMENT_MODE: 'legacy',
        AGENT_OS_CONTAINMENT_MODE: 'legacy',
        AGENT_OS_WORKER_RUN_AS_USER: '',
      };
      assert.equal(load({ topPath, env }).get('worker_pool.containment_mode'), 'boundary-default');
    });
  });
}

test('containment selector has no payload environment alias', () => {
  assert.equal(Object.hasOwn(ENV_ALIASES, 'worker_pool.containment_mode'), false);
});
