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

test('runtime load tolerates an unknown checked-in top-level key and startup load also tolerates it', () => {
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

      assert.doesNotThrow(() => loadConfig({ topPath, modulePaths: [], env: {} }));
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

      assert.doesNotThrow(() => loadConfig({ topPath, modulePaths: [modulePath], env: {} }));
    },
  );
});

test('startup load ignores a foreign nested key under a shared root', () => {
  withTempTopConfig(
    'version: 1\nmain_catchup:\n  some_future_sibling_module_key: true\n',
    (topPath) => {
      const cfg = loadConfig({ topPath, env: {} });
      assert.equal(cfg.get('main_catchup.some_future_sibling_module_key'), null);
    },
  );
});

test('runtime metadata-key tolerance remains reachable and debug notes are emitted once', () => {
  withTempTopConfig(
    'version: 1\nroots:\n  hq: /from-top\n  __future_runtime_home: /newer-than-loader\n',
    (topPath) => {
      assert.throws(() => loadConfig({ topPath, env: {} }), /roots\.__future_runtime_home: unknown key/);
      const priorDebug = process.env.ADVERSARIAL_CONFIG_DEBUG;
      const priorWrite = process.stderr.write;
      const notes = [];
      resetRuntimeUnknownWarningCacheForTests();
      process.env.ADVERSARIAL_CONFIG_DEBUG = '1';
      process.stderr.write = (chunk) => {
        notes.push(String(chunk));
        return true;
      };
      try {
        for (let i = 0; i < 2; i++) {
          const cfg = loadConfigRuntime({ topPath, env: {} });
          assert.equal(cfg.get('roots.hq'), '/from-top');
          assert.equal(cfg.get('roots.__future_runtime_home'), null);
          assert.deepEqual(cfg.runtimeDroppedUnknownKeys, [
            { key: 'roots.__future_runtime_home', source: topPath, hint: '' },
          ]);
        }
        assert.equal(notes.filter(note => note.includes('roots.__future_runtime_home')).length, 1);
      } finally {
        process.stderr.write = priorWrite;
        if (priorDebug === undefined) delete process.env.ADVERSARIAL_CONFIG_DEBUG;
        else process.env.ADVERSARIAL_CONFIG_DEBUG = priorDebug;
        resetRuntimeUnknownWarningCacheForTests();
      }
    },
  );
});
