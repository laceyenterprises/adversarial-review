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

// ONS-07: the generated validator declares every CFG root, so a "foreign"
// section is an ordinary key validated exactly as the Python loader does.
test('CFGFOREIGN-01: every authoritative root is declared by the generated schema', () => {
  withConfig(({ topPath }) => {
    const { schema } = loadConfig({ topPath, env: {} });
    for (const root of roots) assert.ok(Object.hasOwn(schema.__keys, root), root);
  });
});

test('CFGFOREIGN-01: comms and timeouts overrides are read like any CFG key', () => {
  withConfig(({ topPath, localPath }) => {
    for (const version of ['', 'version: 1\n']) {
      writeFileSync(localPath, `${version}comms:\n  ingressMode: tailscale-funnel\n`);
      for (const loader of [loadConfig, loadConfigRuntime]) {
        const cfg = loader({ topPath, env: {} });
        assert.equal(cfg.get('comms.ingressMode'), 'tailscale-funnel');
        assert.equal(cfg.resolutionTrace('comms.ingressMode').at(-1).source, `local:${localPath}`);
      }
    }
    writeFileSync(localPath, 'timeouts:\n  load_aware:\n    enabled: false\n    max_multiplier: 2\n');
    const cfg = loadConfig({ topPath, env: {} });
    assert.equal(cfg.get('timeouts.load_aware.enabled'), false);
    // The reviewer's own load-aware policy is a separate (Node-only) key.
    assert.equal(cfg.get('adversarial.reviewer.load_aware.enabled'), true);
  });
});

test('CFGFOREIGN-01: unknown roots are dropped from local overlays and refused in checked-in config', () => {
  withConfig(({ topPath, localPath }) => {
    for (const version of ['', 'version: 1\n']) {
      writeFileSync(localPath, `${version}unknown_example_root:\n  enabled: true\n`);
      for (const loader of [loadConfig, loadConfigRuntime]) {
        assert.equal(loader({ topPath, env: {} }).get('unknown_example_root'), null);
      }
    }
  });
  assert.throws(() => validateSchema({ version: 1, unknown_example_root: {} }),
    /unknown_example_root: unknown key \(strict schema\)/);
});

test('OVERLOADDEFER-01c: overload threshold mirrors Python and shell CFG', () => {
  withConfig(({ topPath }) => {
    assert.equal(loadConfig({ topPath, env: {} }).get('worker_pool.overload_deferral.minimum_multiplier'), 2);
    writeFileSync(topPath, 'version: 1\nworker_pool:\n  overload_deferral:\n    minimum_multiplier: 3\n');
    for (const loader of [loadConfig, loadConfigRuntime]) {
      assert.equal(loader({ topPath, env: {} }).get('worker_pool.overload_deferral.minimum_multiplier'), 3);
    }
    for (const value of [1.9, 20.1, true, 'two', null]) {
      writeFileSync(topPath, JSON.stringify({ version: 1, worker_pool: { overload_deferral: { minimum_multiplier: value } } }));
      assert.throws(() => loadConfig({ topPath, env: {} }));
    }
  });
});

test('LXS-02: app_relay configuration validates against the generated schema in every layer', () => {
  const relay = { apps: [{ app_id: 'example', base_url: 'https://example.invalid',
    credential_ref: 'op://vault/relay/token', app_contract_credential_ref: 'op://vault/app/bootstrap',
    max_running: 2, poll_seconds: 5, progress_seconds: 5, heartbeat_seconds: 30 }] };
  assert.deepEqual(validateSchema({ version: 1, app_relay: relay }).app_relay, relay);
  const { app_id: _omitted, ...missingId } = relay.apps[0];
  assert.throws(() => validateSchema({ version: 1, app_relay: { apps: [missingId] } }),
    /app_relay\.apps\[0\]\.app_id: required key is missing/);
  withConfig(({ topPath, localPath }) => {
    writeFileSync(topPath, 'version: 1\n');
    for (const version of ['', 'version: 1\n']) {
      writeFileSync(localPath, `${version}app_relay: ${JSON.stringify(relay)}\n`);
      for (const loader of [loadConfig, loadConfigRuntime]) {
        assert.deepEqual(loader({ topPath, env: {} }).get('app_relay.apps'), relay.apps);
      }
    }
  });
});
