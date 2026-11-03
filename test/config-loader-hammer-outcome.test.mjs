import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, AgentOSConfigError } from '../src/config-loader.mjs';

test('hammer burn thresholds share strict CFG defaults and validation', () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-cfg-'));
  const topPath = join(root, 'config.yaml');
  try {
    for (const value of ['{}', '{non_merge_alert_runs: 3, non_merge_alert_tokens: 900}']) {
      writeFileSync(topPath, `version: 1\nworker_pool:\n  hammer_limits: ${value}\n`);
      const config = loadConfig({ topPath, env: {} });
      assert.equal(config.get('worker_pool.hammer_limits.non_merge_alert_runs'), value === '{}' ? 6 : 3);
      assert.equal(config.get('worker_pool.hammer_limits.non_merge_alert_tokens'), value === '{}' ? 120000000 : 900);
    }
    for (const value of ['0', '-1', '"3"', 'null']) {
      writeFileSync(topPath, `version: 1\nworker_pool:\n  hammer_limits:\n    non_merge_alert_runs: ${value}\n`);
      assert.throws(() => loadConfig({ topPath, env: {} }), AgentOSConfigError);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
