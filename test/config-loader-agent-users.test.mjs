import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig, loadConfigRuntime } from '../src/config-loader.mjs';

for (const load of [loadConfig, loadConfigRuntime]) {
  test(`${load.name}: host agent-account inventory`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-users-config-'));
    const topPath = join(dir, 'config.yaml');
    try {
      writeFileSync(topPath, 'version: 1\n');
      assert.deepEqual(load({ topPath, env: {} }).get('roots.agent_users'), []);
      writeFileSync(topPath, 'version: 1\nroots:\n  agent_users: [worker, reviewer, ci, corp-auth]\n');
      assert.deepEqual(load({ topPath, env: {} }).get('roots.agent_users'),
        ['worker', 'reviewer', 'ci', 'corp-auth']);
      for (const value of ['null', '"worker"', '[42]', '["../operator"]', '["-root"]', '[""]']) {
        writeFileSync(topPath, `version: 1\nroots:\n  agent_users: ${value}\n`);
        assert.throws(() => load({ topPath, env: {} }), /roots\.agent_users/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
