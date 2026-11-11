import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadConfigRuntime } from '../src/config-loader.mjs';

test('DEPLOYBATCH-01: strict and runtime readers mirror deploy cadence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-cadence-'));
  const topPath = join(dir, 'config.yaml');
  const key = 'main_catchup.deploy_batch_window_seconds';
  try {
    for (const loader of [loadConfig, loadConfigRuntime]) {
      writeFileSync(topPath, 'version: 1\n');
      assert.equal(loader({ topPath, env: {} }).get(key), 1200);
      for (const value of [0, 600, 1200]) {
        writeFileSync(topPath, JSON.stringify({
          version: 1, main_catchup: { deploy_batch_window_seconds: value },
        }));
        assert.equal(loader({ topPath, env: {} }).get(key), value);
      }
      for (const value of [-1, 1.5, true, 'later', null]) {
        writeFileSync(topPath, JSON.stringify({
          version: 1, main_catchup: { deploy_batch_window_seconds: value },
        }));
        assert.throws(() => loader({ topPath, env: {} }), {
          name: 'AgentOSConfigError',
          key,
          expected: value === -1 ? '>= 0' : 'int',
          got: value,
        });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
