import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  loadConfig,
  loadConfigRuntime,
  resetConfigCache,
  resetRuntimeUnknownWarningCacheForTests,
} from '../src/config-loader.mjs';

// CFGREADERSCOPE-01: startup and runtime loads share a reader-scoped contract.
// Unknown sibling-reader keys are dropped silently by default in every layer.

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

function withTempConfigPair({ topContents = 'version: 1\n', moduleContents = null }, fn) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'cfg-runtime-tolerance-'));
  const topPath = path.join(rootDir, 'config.yaml');
  const modulePath = path.join(rootDir, 'module.yaml');
  writeFileSync(topPath, topContents, 'utf8');
  if (moduleContents !== null) {
    writeFileSync(modulePath, moduleContents, 'utf8');
  }
  try {
    return fn({ topPath, modulePath });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    resetConfigCache();
    resetRuntimeUnknownWarningCacheForTests();
  }
}

function captureWarns(fn) {
  const prior = console.warn;
  const warnings = [];
  console.warn = (...args) => {
    warnings.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    fn();
  } finally {
    console.warn = prior;
  }
  return warnings;
}

test('runtime load tolerates an unknown checked-in top-level key; startup load refuses it like Python', () => {
  withTempTopConfig(
    `version: 1
roots:
  hq: /from-top
  future_runtime_home: /newer-than-loader
`,
    (topPath) => {
      resetRuntimeUnknownWarningCacheForTests();
      const warnings = captureWarns(() => {
        const first = loadConfigRuntime({ topPath, modulePaths: [], env: {} });
        const second = loadConfigRuntime({ topPath, modulePaths: [], env: {} });
        assert.equal(first.get('roots.hq'), '/from-top');
        assert.equal(second.get('roots.hq'), '/from-top');
        assert.equal(first.get('roots.future_runtime_home', null), null);
        assert.deepEqual(first.runtimeDroppedUnknownKeys, [
          {
            key: 'roots.future_runtime_home',
            source: topPath,
            hint: 'did you mean roots."runtime_home"?',
          },
        ]);
      });
      assert.equal(warnings.filter((line) => line.includes('roots.future_runtime_home')).length, 0);

      assert.throws(() => loadConfig({ topPath, modulePaths: [], env: {} }), /roots\.future_runtime_home: unknown key/);
    },
  );
});

test('runtime load tolerates an unknown checked-in module key without warnings', () => {
  withTempConfigPair(
    {
      topContents: 'version: 1\n',
      moduleContents: `roles:
  reviewer: codex
  future_worker_role: fast-lane
`,
    },
    ({ topPath, modulePath }) => {
      resetRuntimeUnknownWarningCacheForTests();
      const warnings = captureWarns(() => {
        const first = loadConfigRuntime({ topPath, modulePaths: [modulePath], env: {} });
        const second = loadConfigRuntime({ topPath, modulePaths: [modulePath], env: {} });
        assert.equal(first.get('roles.reviewer'), 'codex');
        assert.equal(second.get('roles.reviewer'), 'codex');
        assert.equal(first.get('roles.future_worker_role', null), null);
        assert.deepEqual(first.runtimeDroppedUnknownKeys, [
          {
            key: 'roles.future_worker_role',
            source: modulePath,
            hint: '',
          },
        ]);
      });
      assert.equal(warnings.filter((line) => line.includes('roles.future_worker_role')).length, 0);

      assert.throws(() => loadConfig({ topPath, modulePaths: [modulePath], env: {} }), /roles\.future_worker_role: unknown key/);
    },
  );
});

test('startup load refuses an unknown nested key under a shared root', () => {
  withTempTopConfig(
    'version: 1\nmain_catchup:\n  some_future_sibling_module_key: true\n',
    (topPath) => {
      assert.throws(() => loadConfig({ topPath, env: {} }), /main_catchup\.some_future_sibling_module_key: unknown key/);
      assert.equal(loadConfigRuntime({ topPath, env: {} }).get('main_catchup.some_future_sibling_module_key'), null);
    },
  );
});

test('metadata keys are skipped by startup and runtime loads, as in Python', () => {
  withTempTopConfig(
    'version: 1\nroots:\n  hq: /from-top\n  __future_runtime_home: /newer-than-loader\n',
    (topPath) => {
      for (const load of [loadConfig, loadConfigRuntime]) {
        const cfg = load({ topPath, env: {} });
        assert.equal(cfg.get('roots.hq'), '/from-top');
        assert.equal(cfg.get('roots.__future_runtime_home'), null);
        assert.deepEqual(cfg.runtimeDroppedUnknownKeys, []);
      }
    },
  );
});
