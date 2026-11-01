import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadConfig, loadConfigRuntime, validateSchema } from '../src/config-loader.mjs';

// Names only, captured from a committed authoritative schema, including roots
// absent from its default config.yaml. No live config or sibling repo is read
// by this suite. It is a historical sample, not an allowlist to maintain when
// another reader adds a root.
const { roots } = JSON.parse(readFileSync(new URL('./fixtures/config-schema-roots.json', import.meta.url), 'utf8'));

function withConfig(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-foreign-'));
  try {
    const topPath = join(dir, 'config.yaml');
    const localPath = join(dir, 'config.local.yaml');
    writeFileSync(topPath, 'version: 1\n');
    fn({ topPath, localPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('CFGFOREIGN-01: every authoritative root is mirrored or accepted as foreign in local overrides', () => {
  withConfig(({ topPath, localPath }) => {
    const baseline = loadConfig({ topPath, env: {} });
    for (const root of roots) {
      if (Object.hasOwn(baseline.schema.__keys, root)) continue;
      for (const version of ['', 'version: 1\n']) {
        writeFileSync(localPath, `${version}${root}: {}\n`);
        for (const loader of [loadConfig, loadConfigRuntime]) {
          const cfg = loader({ topPath, env: {} });
          assert.deepEqual(cfg.values, baseline.values, `${root} must be ignored by ${loader.name}`);
          assert.equal(cfg.get(root), null, `${root} must not be adopted`);
        }
      }
    }
  });
});

test('CFGFOREIGN-01: comms ingress override is accepted and ignored', () => {
  withConfig(({ topPath, localPath }) => {
    for (const version of ['', 'version: 1\n']) {
      writeFileSync(localPath, `${version}comms:\n  ingressMode: tailscale-funnel\n`);
      for (const loader of [loadConfig, loadConfigRuntime]) {
        const cfg = loader({ topPath, env: {} });
        assert.equal(cfg.get('comms'), null);
        assert.equal(cfg.get('comms.ingressMode'), null);
        assert.deepEqual(cfg.resolutionTrace('comms.ingressMode'), []);
      }
    }
  });
});

test('CFGFOREIGN-01: shared timeouts override does not change this reader\'s load-aware policy', () => {
  withConfig(({ topPath, localPath }) => {
    writeFileSync(localPath, 'timeouts:\n  load_aware:\n    enabled: false\n    max_multiplier: 2\n');
    const cfg = loadConfig({ topPath, env: {} });
    assert.equal(cfg.get('timeouts'), null);
    assert.equal(cfg.get('adversarial.reviewer.load_aware.enabled'), true);
    assert.equal(cfg.get('adversarial.reviewer.load_aware.max_multiplier'), 6);
  });
});

test('CFGFOREIGN-01: unknown roots are ignored by startup and runtime local loads', () => {
  withConfig(({ topPath, localPath }) => {
    for (const version of ['', 'version: 1\n']) {
      writeFileSync(localPath, `${version}unknown_example_root:\n  enabled: true\n`);
      for (const loader of [loadConfig, loadConfigRuntime]) {
        assert.equal(loader({ topPath, env: {} }).get('unknown_example_root'), null);
      }
    }
  });
});

test('CFGFOREIGN-01: new foreign sections are ignored in checked-in config', () => {
  for (const root of ['comms', 'submodule_float', 'assessment_cadence', 'argus', 'searchlight', 'timeouts']) {
    assert.deepEqual(validateSchema({ version: 1, [root]: {} }, {
      source: '/tmp/config.yaml',
    }), { version: 1 });
  }
});
