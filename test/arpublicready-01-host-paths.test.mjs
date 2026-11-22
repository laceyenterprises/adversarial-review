import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveDeployRoot } from '../src/deploy-root.mjs';
import { resolveAlertDefaults } from '../src/alert-delivery.mjs';
import { shouldUseDefaultTranscriptRoots } from '../src/reviewer-pass-tokens.mjs';

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
  const saved = process.env.ADV_REVIEW_TOKEN_TRANSCRIPT_FALLBACK;
  try {
    delete process.env.ADV_REVIEW_TOKEN_TRANSCRIPT_FALLBACK;
    assert.equal(shouldUseDefaultTranscriptRoots(deployed, env), true);
    assert.equal(shouldUseDefaultTranscriptRoots('/synthetic/worker-tree/tools/adversarial-review', env), false);
    assert.equal(shouldUseDefaultTranscriptRoots('', env), false);
    process.env.ADV_REVIEW_TOKEN_TRANSCRIPT_FALLBACK = '1';
    assert.equal(shouldUseDefaultTranscriptRoots('/synthetic/worker-tree', env), true);
    process.env.ADV_REVIEW_TOKEN_TRANSCRIPT_FALLBACK = '0';
    assert.equal(shouldUseDefaultTranscriptRoots(deployed, env), false);
  } finally {
    if (saved === undefined) delete process.env.ADV_REVIEW_TOKEN_TRANSCRIPT_FALLBACK;
    else process.env.ADV_REVIEW_TOKEN_TRANSCRIPT_FALLBACK = saved;
  }
});
