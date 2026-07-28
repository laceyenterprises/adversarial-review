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

// Regression coverage for CFT-02: runtime callers must tolerate checked-in
// config.yaml keys that are newer than this loader, warn once per config
// file/key, and drop the unknown key. The strict public loadConfig() entrypoint
// must keep failing loud so CI and authoring paths still catch schema drift.

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

test('runtime load tolerates an unknown checked-in top-level key and strict load still rejects it', () => {
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
      assert.equal(warnings.filter((line) => line.includes('roots.future_runtime_home')).length, 1);

      assert.throws(
        () => loadConfig({ topPath, modulePaths: [], env: {} }),
        (err) => {
          assert.match(String(err.message), /unknown key \(strict schema\)/);
          assert.match(String(err.message), /roots\.future_runtime_home/);
          return true;
        },
      );
    },
  );
});

test('runtime load tolerates an unknown checked-in module key and warns once per file/key', () => {
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
      assert.equal(warnings.filter((line) => line.includes('roles.future_worker_role')).length, 1);

      assert.throws(
        () => loadConfig({ topPath, modulePaths: [modulePath], env: {} }),
        (err) => {
          assert.match(String(err.message), /unknown key \(strict schema\)/);
          assert.match(String(err.message), /roles\.future_worker_role/);
          return true;
        },
      );
    },
  );
});

test('strict loadConfig still fails loud on a foreign nested key under a shared root', () => {
  withTempTopConfig(
    `version: 1
main_catchup:
  poll_interval_seconds: 300
  some_future_sibling_module_key: true
`,
    (topPath) => {
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
    },
  );
});
