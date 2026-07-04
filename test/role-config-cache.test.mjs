// CFG-09 cache + per-tick reset tests for `loadRoleConfig`.
//
// These tests exercise the documented cache-invalidation contract:
//
//   - The role-config cascade cache is keyed by (topPath, modulePaths,
//     declared env aliases) and watches file mtime/inode. Repeated calls
//     with the same call shape are cache hits; file edits and env-alias
//     changes invalidate the slot.
//   - Callers still reset at per-tick / per-job boundaries, but explicit
//     env overlays must not reuse values resolved under a different env.
//
// Sibling: `test/helpers/role-config-cache-reset.mjs` exports a
// `beforeEach`/`afterEach` helper for tests that want pristine cache
// state between cases.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __testYamlHooks } from '../src/config-loader.mjs';
import { loadRoleConfig, resetRoleConfigCache } from '../src/role-config.mjs';
import { routeSubject } from '../src/adapters/subject/github-pr/routing.mjs';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'cfg-09-cache-'));
}

function writeYaml(path, body) {
  writeFileSync(path, body, { encoding: 'utf8' });
}

function yamlLoadCountFor(spy, sourcePath) {
  return spy.mock.calls.filter((call) => call.arguments?.[1]?.filename === sourcePath).length;
}

// ── Per-tick reset: two ticks with different env both see fresh resolution ──

test('CFG-09 per-tick reset: two ticks with different env both resolve env value', () => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    writeYaml(modulePath, 'roles:\n  remediator: codex\n');

    // Tick 1: env pins to codex (matches file; trace still shows env).
    resetRoleConfigCache();
    const cfg1 = loadRoleConfig({
      env: {
        AGENT_OS_ROLES_REMEDIATOR: 'codex',
        AGENT_OS_CONFIG_PATH: '/dev/null',
      },
      topPath: '/dev/null',
      modulePaths: [modulePath],
    });
    assert.equal(cfg1.get('roles.remediator'), 'codex');

    // Tick 2: env rotates; the explicit reset is the contract.
    resetRoleConfigCache();
    const cfg2 = loadRoleConfig({
      env: {
        AGENT_OS_ROLES_REMEDIATOR: 'claude-code',
        AGENT_OS_CONFIG_PATH: '/dev/null',
      },
      topPath: '/dev/null',
      modulePaths: [modulePath],
    });
    assert.equal(cfg2.get('roles.remediator'), 'claude-code');
    const trace2 = cfg2.resolutionTrace('roles.remediator');
    assert.equal(trace2[trace2.length - 1].source, 'env:AGENT_OS_ROLES_REMEDIATOR');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Cache hit within a tick: repeated calls do not re-parse YAML ──

test('CFG-09 cache hit: repeated loadRoleConfig within a tick does not re-parse', (t) => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    writeYaml(modulePath, 'roles:\n  remediator: codex\n');

    resetRoleConfigCache();
    const callArgs = {
      env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
      topPath: '/dev/null',
      modulePaths: [modulePath],
    };
    // Prime the cache.
    loadRoleConfig(callArgs);

    // Now spy on the loader hook around yaml.load, so this intercepts
    // config-loader.mjs parses. In the full
    // suite the process-wide LRU cache can have been reset/evicted by
    // previous config-heavy tests; allow the first measured call to
    // refresh the slot, then prove the repeated hot path stays cached.
    const yamlLoadSpy = t.mock.method(__testYamlHooks, 'load');
    try {
      loadRoleConfig(callArgs);
      const parseCountAfterFirstMeasuredCall = yamlLoadCountFor(yamlLoadSpy, modulePath);
      assert.ok(
        parseCountAfterFirstMeasuredCall <= 1,
        `at most one refresh is allowed before the repeated hot path; saw ${parseCountAfterFirstMeasuredCall} parses`,
      );

      for (let i = 0; i < 10; i++) {
        loadRoleConfig(callArgs);
      }
      assert.equal(
        yamlLoadCountFor(yamlLoadSpy, modulePath),
        parseCountAfterFirstMeasuredCall,
        'repeated loadRoleConfig calls within a tick must hit cache (no additional YAML parses)',
      );
    } finally {
      yamlLoadSpy.mock.restore();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Env mutation without reset gets a distinct env-aware cache slot ──

test('CFG-09 env mutation without reset resolves from the changed env alias slot', () => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    writeYaml(modulePath, 'roles:\n  remediator: codex\n');

    resetRoleConfigCache();
    const cfg1 = loadRoleConfig({
      env: {
        AGENT_OS_ROLES_REMEDIATOR: 'codex',
        AGENT_OS_CONFIG_PATH: '/dev/null',
      },
      topPath: '/dev/null',
      modulePaths: [modulePath],
    });
    assert.equal(cfg1.get('roles.remediator'), 'codex');

    // Same path shape, but env mutates. The declared alias values are
    // now part of the cache key, so this must not reuse the prior slot.
    const cfg2 = loadRoleConfig({
      env: {
        AGENT_OS_ROLES_REMEDIATOR: 'claude-code',
        AGENT_OS_CONFIG_PATH: '/dev/null',
      },
      topPath: '/dev/null',
      modulePaths: [modulePath],
    });
    assert.equal(
      cfg2.get('roles.remediator'),
      'claude-code',
      'env mutation without resetRoleConfigCache must use a distinct alias-aware cache slot',
    );

    // After reset, the new env wins.
    resetRoleConfigCache();
    const cfg3 = loadRoleConfig({
      env: {
        AGENT_OS_ROLES_REMEDIATOR: 'claude-code',
        AGENT_OS_CONFIG_PATH: '/dev/null',
      },
      topPath: '/dev/null',
      modulePaths: [modulePath],
    });
    assert.equal(cfg3.get('roles.remediator'), 'claude-code');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── N2 hot path regression: routeSubject × ~10 PRs × repeated ticks ──

test('CFG-09 N2 hot path: routeSubject parses once per tick across 10 PRs', (t) => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    writeYaml(modulePath, 'roles:\n  reviewer: claude\n');
    // Pin `topPath` to `/dev/null` and `modulePaths` to this test's
    // private module config so full-suite YAML parsing in other files
    // cannot leak into the spy count.
    const env = { AGENT_OS_CONFIG_PATH: '/dev/null' };
    const callOpts = { env, topPath: '/dev/null', modulePaths: [modulePath] };
    const subjects = [];
    for (let i = 0; i < 10; i++) {
      subjects.push({ builderClass: i % 2 === 0 ? 'codex' : 'claude-code' });
    }

    for (let tick = 0; tick < 3; tick++) {
      resetRoleConfigCache();
      // Prime the tick.
      const firstRoute = routeSubject(subjects[0], callOpts);
      assert.ok(firstRoute, `tick ${tick}: first routeSubject must succeed`);
      assert.equal(firstRoute.configBroken ?? false, false);
      assert.equal(firstRoute.reviewerModel, 'claude');

      // Now count parses for the remaining 9 PRs. In the full suite,
      // concurrent config-heavy tests may evict the process-wide LRU
      // between the prime call and this spy. Allow one refresh, then
      // prove the remaining hot path stays cached.
      const yamlLoadSpy = t.mock.method(__testYamlHooks, 'load');
      try {
        routeSubject(subjects[1], callOpts);
        const parseCountAfterFirstMeasuredCall = yamlLoadCountFor(yamlLoadSpy, modulePath);
        assert.ok(
          parseCountAfterFirstMeasuredCall <= 1,
          `tick ${tick}: at most one measured refresh is allowed; saw ${parseCountAfterFirstMeasuredCall} parses`,
        );
        for (let i = 2; i < subjects.length; i++) {
          routeSubject(subjects[i], callOpts);
        }
        const parseCount = yamlLoadCountFor(yamlLoadSpy, modulePath);
        assert.ok(
          parseCount <= 1,
          `tick ${tick}: repeated PR routing must not reparse per PR; saw ${parseCount} parses`,
        );
      } finally {
        yamlLoadSpy.mock.restore();
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Cache invalidates on module-file mtime change ──

test('CFG-09 module-file edit invalidates cache without explicit reset', () => {
  const tmp = makeTmp();
  try {
    const modulePath = join(tmp, 'config.yaml');
    writeYaml(modulePath, 'roles:\n  remediator: codex\n');

    resetRoleConfigCache();
    const callArgs = {
      env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
      topPath: '/dev/null',
      modulePaths: [modulePath],
    };
    const cfg1 = loadRoleConfig(callArgs);
    assert.equal(cfg1.get('roles.remediator'), 'codex');

    // Rewrite the module file with a different remediator and force a
    // noticeable mtime delta. writeFileSync updates mtime to now, but
    // sub-millisecond test ticks can leave _cachedSignature unchanged;
    // utimesSync to a future time guarantees a signature change.
    const future = new Date(Date.now() + 1000);
    writeYaml(modulePath, 'roles:\n  remediator: claude-code\n');
    utimesSync(modulePath, future, future);

    const cfg2 = loadRoleConfig(callArgs);
    assert.equal(
      cfg2.get('roles.remediator'),
      'claude-code',
      'module-file mtime change should auto-invalidate cache',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
