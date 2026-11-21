import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadConfigRuntime } from '../src/config-loader.mjs';

// ONS-07: credentials validate against the generated CFG schema, with the
// Python loader's verdicts (recorded from agent_os_config at one-schema@6ab5e7ac02db).
const credentialBlocks = [
  ['credentials:\n  enforcement: audit\n', /credentials\.enforcement: value "audit" not in allowlist \["observe", "enforce"\]/],
  ['credentials:\n  model_broker:\n    enforcement: future-mode\n', /credentials\.model_broker\.enforcement: value "future-mode" not in allowlist/],
  ['credentials:\n  cloud:\n    enabled: "true"\n', /credentials\.cloud\.enabled: expected bool, got string/],
];

for (const layer of ['config.yaml', 'config.local.yaml']) {
  test(`credential values in ${layer} are validated like the Python loader`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'credential-flags-'));
    try {
      const topPath = join(dir, 'config.yaml');
      writeFileSync(topPath, 'version: 1\n');
      for (const loader of [loadConfig, loadConfigRuntime]) {
        assert.deepEqual(loader({ topPath, modulePaths: [], env: {} }).get('credentials'),
          { enforcement: 'observe', model_broker: { enforcement: 'observe' }, cloud: { enabled: false } });
        for (const [block, error] of credentialBlocks) {
          writeFileSync(join(dir, layer), `version: 1\n${block}`);
          assert.throws(() => loader({ topPath, modulePaths: [], env: {} }), error);
        }
        writeFileSync(join(dir, layer), 'version: 1\ncredentials:\n  future:\n    token: synthetic-only\n');
        // `credentials` is an open section in CFG: undeclared children are dropped.
        assert.equal(loader({ topPath, modulePaths: [], env: {} }).get('credentials.future'), null);
        writeFileSync(join(dir, layer), 'version: 1\n');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
