import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig, loadConfigRuntime } from '../src/config-loader.mjs';

test('DPR-04 memory-gateway install root survives strict and runtime config loads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adversarial-memory-gateway-cfg-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, 'version: 1\nservices:\n  memory_gateway:\n    install_root: /opt/agent-os/memory-gateway\n');
    for (const load of [loadConfig, loadConfigRuntime]) {
      assert.equal(load({ topPath, env: {} }).get('services.memory_gateway.install_root'), '/opt/agent-os/memory-gateway');
    }
    writeFileSync(topPath, 'version: 1\nservices:\n  memory_gateway:\n    install_root: 7\n');
    assert.throws(() => loadConfig({ topPath, env: {} }), /services\.memory_gateway\.install_root/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
