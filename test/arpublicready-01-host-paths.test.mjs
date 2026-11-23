import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os, { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { resetConfigCache } from '../src/config-loader.mjs';
import { resolveDeployRoot } from '../src/deploy-root.mjs';
import { resolveAlertDefaults } from '../src/alert-delivery.mjs';
import { shouldUseDefaultTranscriptRoots } from '../src/reviewer-pass-tokens.mjs';
import { resolveCloserHqPath } from '../src/ama/dispatch-closer.mjs';
import { prepareCorporateCodexReviewerAuth } from '../src/codex-per-worker-auth.mjs';
import { __test__ as reviewerHarness } from '../src/reviewer-harness.mjs';

const { resolveCodexAuthPath } = reviewerHarness;

// Synthetic roots only: the module must derive every host location from the
// environment or configuration, never from a fixed account.
const DEPLOY = '/synthetic/deploy';
const configReturning = (value) => () => ({ get: (key) => (key === 'roots.deploy' ? value : undefined) });

test('deploy root prefers the environment override, then configuration', () => {
  const never = () => { throw new Error('config must not be read when the override is set'); };
  assert.equal(resolveDeployRoot({ AGENT_OS_DEPLOY_CHECKOUT: ` ${DEPLOY} ` }, { loadConfigImpl: never }), DEPLOY);
  assert.equal(resolveDeployRoot({}, { loadConfigImpl: configReturning('/synthetic/configured') }), '/synthetic/configured');
});

test('deploy root is null, not a host default, when nothing is configured or config fails', () => {
  assert.equal(resolveDeployRoot({}, { loadConfigImpl: configReturning('') }), null);
  assert.equal(resolveDeployRoot({}, { loadConfigImpl: configReturning(undefined) }), null);
  assert.equal(resolveDeployRoot({}, { loadConfigImpl: () => { throw new Error('unreadable'); } }), null);
});

test('deploy root reads roots.deploy through the production cached config loader', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deploy-root-config-')));
  t.after(() => {
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  });
  for (const name of ['first', 'second']) {
    const configPath = join(root, `${name}.yaml`);
    const deploy = join(root, name);
    writeFileSync(configPath, `version: 1\nroots:\n  deploy: ${JSON.stringify(deploy)}\n`);
    const env = { AGENT_OS_CONFIG_PATH: configPath };
    assert.equal(resolveDeployRoot(env), deploy);
    assert.equal(resolveDeployRoot(env), deploy, 'cached reads preserve the configured root');
  }
});

test('deploy roots normalize relative paths, aliases and missing tails', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deploy-root-canonical-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  const alias = join(root, 'alias');
  mkdirSync(checkout);
  symlinkSync(checkout, alias, 'dir');
  const given = `${relative(process.cwd(), alias)}/future/./`;
  const expected = join(checkout, 'future');
  assert.equal(resolveDeployRoot({ AGENT_OS_DEPLOY_CHECKOUT: given }), expected);
  assert.equal(resolveDeployRoot({}, { loadConfigImpl: configReturning(given) }), expected);
});

test('implicit HQ, per-worker auth and alert paths use the OS account home', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'implicit-home-paths-'));
  const originalCwd = process.cwd();
  t.after(() => {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });
  const accountHome = os.userInfo().homedir;
  assert.ok(isAbsolute(accountHome));
  mkdirSync(join(root, '.local', 'bin'), { recursive: true });
  writeFileSync(join(root, '.local', 'bin', 'hq'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  process.chdir(root);
  for (const env of [{}, { HOME: '' }, { HOME: '.' }, null, 42, 'invalid']) {
    assert.equal(resolveCloserHqPath({}, env), join(accountHome, '.local', 'bin', 'hq'));
  }
  for (const extra of [{}, { HOME: '' }, { HOME: '.' }]) {
    const env = { ...extra, CODEX_BROKER_PROVIDER: 'codex-corp' };
    prepareCorporateCodexReviewerAuth(env, 'fixture', {
      materializeImpl: ({ sharedAuthPath }) => {
        assert.equal(sharedAuthPath, join(accountHome, '.codex', 'auth.json'));
        return { authPath: 'fixture-auth', codexHome: 'fixture-home' };
      },
    });
    const reads = [];
    const alert = resolveAlertDefaults({ ...extra, ALERT_TO: 'fixture', AGENT_OS_DEPLOY_CHECKOUT: DEPLOY }, {
      fsImpl: { existsSync: () => false, readFileSync: p => { reads.push(p); return ''; } },
    });
    assert.deepEqual(reads, [join(accountHome, 'agent-os', 'config.yaml')]);
    assert.equal(alert.hooksTokenFile, join(accountHome, '.config', 'adversarial-review', 'secrets', 'litellm-alert-bridge.token'));
  }
});

test('unresolvable OS identity refuses implicit paths and preserves explicit selections', (t) => {
  const lookup = t.mock.method(os, 'userInfo', () => { throw new Error('unknown uid'); });
  syncBuiltinESMExports();
  try {
    const unexpected = () => assert.fail('implicit path must never be probed');
    assert.equal(resolveCodexAuthPath({ HOME: '' }, { existsSyncImpl: unexpected }), null);
    assert.equal(resolveCodexAuthPath({ HOME: '.', CODEX_AUTH_PATH: 'explicit-auth' }), 'explicit-auth');
    assert.equal(resolveCodexAuthPath({ ADVERSARIAL_LEGACY_CODEX_AUTH_PATH: 'explicit-bridge' },
      { existsSyncImpl: p => p === 'explicit-bridge' }), 'explicit-bridge');
    assert.throws(() => resolveCloserHqPath({}, { HOME: '.' }), /absolute account home/);
    assert.equal(resolveCloserHqPath({}, { HQ_BIN: 'explicit-hq' }), 'explicit-hq');
    assert.equal(resolveCloserHqPath({ hqPath: 'context-hq' }, { HQ_BIN: 'explicit-hq' }), 'context-hq');
    assert.throws(() => prepareCorporateCodexReviewerAuth({ CODEX_BROKER_PROVIDER: 'codex-corp' }, 'fixture',
      { materializeImpl: unexpected }), /no absolute account home/);
    const alertEnv = { ALERT_TO: 'fixture', AGENT_OS_DEPLOY_CHECKOUT: DEPLOY };
    assert.throws(() => resolveAlertDefaults(alertEnv, { fsImpl: { existsSync: () => false } }), /absolute account home/);
    assert.equal(resolveAlertDefaults({
      ...alertEnv, OPENCLAW_HOOKS_TOKEN_FILE: 'explicit-token', ADVERSARIAL_ALERT_DELIVERY_ROOT: 'explicit-state',
    }).hooksTokenFile, 'explicit-token');
  } finally {
    lookup.mock.restore();
    syncBuiltinESMExports();
  }
});

test('alert token discovery probes the legacy secrets path under the configured deploy root only', () => {
  const legacyFile = join(DEPLOY, 'agents', 'clio', 'credentials', 'local', 'litellm-alert-bridge.token');
  const env = { ALERT_TO: '123456', AGENT_OS_DEPLOY_CHECKOUT: DEPLOY };
  const found = resolveAlertDefaults(env, { fsImpl: { existsSync: (p) => p === legacyFile } });
  assert.equal(found.hooksTokenFile, legacyFile);
  const absent = resolveAlertDefaults(env, { fsImpl: { existsSync: () => false } });
  assert.notEqual(absent.hooksTokenFile, legacyFile);
  assert.ok(absent.hooksTokenFile.endsWith(join('.config', 'adversarial-review', 'secrets', 'litellm-alert-bridge.token')));
});

test('transcript fallback defaults on only for the deployed module, with an explicit override either way', () => {
  const env = { AGENT_OS_DEPLOY_CHECKOUT: DEPLOY };
  const deployed = join(DEPLOY, 'tools', 'adversarial-review');
  assert.equal(shouldUseDefaultTranscriptRoots(deployed, env), true);
  assert.equal(shouldUseDefaultTranscriptRoots('/synthetic/worker-tree/tools/adversarial-review', env), false);
  assert.equal(shouldUseDefaultTranscriptRoots('', env), false);
  assert.equal(shouldUseDefaultTranscriptRoots('/synthetic/worker-tree', {
    ...env, ADV_REVIEW_TOKEN_TRANSCRIPT_FALLBACK: '1',
  }), true);
  assert.equal(shouldUseDefaultTranscriptRoots(deployed, {
    ...env, ADV_REVIEW_TOKEN_TRANSCRIPT_FALLBACK: '0',
  }), false);
});

test('transcript fallback uses the caller environment even when the process override disagrees', () => {
  const deployed = join(DEPLOY, 'tools', 'adversarial-review');
  const env = { AGENT_OS_DEPLOY_CHECKOUT: DEPLOY };
  const saved = process.env.ADV_REVIEW_TOKEN_TRANSCRIPT_FALLBACK;
  try {
    process.env.ADV_REVIEW_TOKEN_TRANSCRIPT_FALLBACK = '0';
    assert.equal(shouldUseDefaultTranscriptRoots(deployed, env), true);
    assert.equal(shouldUseDefaultTranscriptRoots('/synthetic/worker-tree', {
      ...env, ADV_REVIEW_TOKEN_TRANSCRIPT_FALLBACK: '1',
    }), true);
    process.env.ADV_REVIEW_TOKEN_TRANSCRIPT_FALLBACK = '1';
    assert.equal(shouldUseDefaultTranscriptRoots('/synthetic/worker-tree', env), false);
    assert.equal(shouldUseDefaultTranscriptRoots(deployed, {
      ...env, ADV_REVIEW_TOKEN_TRANSCRIPT_FALLBACK: '0',
    }), false);
  } finally {
    if (saved === undefined) delete process.env.ADV_REVIEW_TOKEN_TRANSCRIPT_FALLBACK;
    else process.env.ADV_REVIEW_TOKEN_TRANSCRIPT_FALLBACK = saved;
  }
});
