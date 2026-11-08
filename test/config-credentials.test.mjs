import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadConfigRuntime } from '../src/config-loader.mjs';

// CFGREADERSCOPE-01: credentials belong to another reader. These fixtures
// deliberately include values outside the removed Node enum/type constraints.
const credentialBlocks = [
  'credentials:\n  enforcement: audit\n  future:\n    token: synthetic-only\n',
  'credentials:\n  model_broker:\n    enforcement: future-mode\n    future:\n      token: synthetic-only\n',
  'credentials:\n  cloud:\n    enabled: "true"\n    future:\n      token: synthetic-only\n',
];

for (const layer of ['config.yaml', 'config.local.yaml']) {
  test(`foreign credential values are ignored in ${layer} by startup and runtime loaders`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'credential-flags-'));
    try {
      const topPath = join(dir, 'config.yaml');
      writeFileSync(topPath, 'version: 1\n');
      for (const loader of [loadConfig, loadConfigRuntime]) {
        const baseline = loader({ topPath, modulePaths: [], env: {} });
        assert.equal(baseline.get('credentials.enforcement', 'caller-default'), 'caller-default');
        for (const block of credentialBlocks) {
          writeFileSync(join(dir, layer), `version: 1\n${block}`);
          const cfg = loader({ topPath, modulePaths: [], env: {} });
          assert.deepEqual(cfg.values, baseline.values);
          assert.equal(Object.hasOwn(cfg.values, 'credentials'), false);
          for (const key of ['credentials.enforcement', 'credentials.model_broker.enforcement', 'credentials.cloud.enabled']) {
            assert.equal(cfg.get(key, 'caller-default'), 'caller-default');
          }
        }
        // Restore an empty overlay before taking the next loader's baseline.
        writeFileSync(join(dir, layer), 'version: 1\n');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
