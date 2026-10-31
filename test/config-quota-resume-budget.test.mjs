import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, AgentOSConfigError } from '../src/config-loader.mjs';

const defaults = {
  budget_seconds: 15, max_attempts: 3, backoff_seconds: 60, max_backoff_seconds: 3600,
};
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'quota-resume-budget-'));
  const topPath = join(dir, 'config.yaml');
  try { fn(topPath, dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const prefix = 'worker_pool.quota.resume';
test('quota recovery defaults match Python; tracked and local overrides parse', () => fixture((topPath, dir) => {
  writeFileSync(topPath, 'version: 1\n');
  assert.deepEqual(loadConfig({ topPath, env: {} }).get(prefix), defaults);
  writeFileSync(topPath, 'version: 1\nworker_pool:\n  quota:\n    resume:\n      budget_seconds: 2.5\n      max_attempts: 5\n');
  writeFileSync(join(dir, 'config.local.yaml'), 'worker_pool:\n  quota:\n    resume:\n      backoff_seconds: 10\n      max_backoff_seconds: 90\n      unrelated_local_overlay: true\n');
  assert.deepEqual(loadConfig({ topPath, env: {} }).get(prefix), {
    budget_seconds: 2.5, max_attempts: 5, backoff_seconds: 10, max_backoff_seconds: 90,
  });
}));
for (const key of Object.keys(defaults)) {
  test(`quota recovery rejects zero ${key}`, () => fixture((topPath) => {
    writeFileSync(topPath, `version: 1\nworker_pool:\n  quota:\n    resume:\n      ${key}: 0\n`);
    assert.throws(() => loadConfig({ topPath, env: {} }), AgentOSConfigError);
  }));
}
