import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  loadConfig,
  loadConfigCached,
  resetConfigCache,
} from '../src/config-loader.mjs';

// Regression for the 2026-07-17 watcher outage: a sibling module (main-catchup)
// added `main_catchup.pg_schema_gate_allow_destructive_revisions` to the shared
// top-level agent-os config.yaml. This module's strict validator whitelists the
// main_catchup keys it consumes, so every daemon-path load (all of which flow
// through loadConfigCached/_ensureFreshConfig) fail-louded at startup and the
// watcher crash-looped for ~1h. The daemon path must tolerate foreign NESTED
// keys under shared roots (warn-once + drop); the strict public loadConfig()
// keeps failing loud so CI still catches genuine schema drift.

function withTempTopConfig(contents, fn) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'cfg-runtime-tolerance-'));
  const topPath = path.join(rootDir, 'config.yaml');
  writeFileSync(topPath, contents, 'utf8');
  try {
    return fn(topPath);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    resetConfigCache();
  }
}

const FOREIGN_NESTED_KEY_DOC = `version: 1
main_catchup:
  poll_interval_seconds: 300
  some_future_sibling_module_key: true
`;

test('loadConfigCached tolerates foreign nested keys under shared roots in the top-level file', () => {
  withTempTopConfig(FOREIGN_NESTED_KEY_DOC, (topPath) => {
    resetConfigCache();
    const cfg = loadConfigCached({ topPath, modulePaths: [], env: {} });
    // The key this module consumes still resolves from the same section.
    assert.equal(cfg.get('main_catchup.poll_interval_seconds'), 300);
    // The foreign key is dropped, not resolved and not fatal.
    assert.equal(
      cfg.get('main_catchup.some_future_sibling_module_key', null),
      null,
    );
  });
});

test('strict loadConfig still fails loud on the same foreign nested key', () => {
  withTempTopConfig(FOREIGN_NESTED_KEY_DOC, (topPath) => {
    assert.throws(
      () => loadConfig({ topPath, modulePaths: [], env: {} }),
      (err) => {
        assert.match(String(err.message), /unknown key \(strict schema\)/);
        assert.match(
          String(err.message),
          /some_future_sibling_module_key/,
        );
        return true;
      },
    );
  });
});
