import test from 'node:test';
import assert from 'node:assert/strict';

import { warnIfAntigravityReviewerAuthUnavailable } from '../src/watcher.mjs';

test('watcher startup warns without failing when antigravity agy auth is unavailable', async () => {
  const warnings = [];
  let probeEnv = null;

  const result = await warnIfAntigravityReviewerAuthUnavailable({
    env: {
      HOME: '/Users/airlock',
      PATH: '/opt/bin',
      GEMINI_API_KEY: 'api-key',
      GOOGLE_API_KEY: 'google-key',
    },
    log: { warn: (message) => warnings.push(String(message)) },
    resolveGeminiRuntimeImpl: () => 'antigravity',
    checkAgyReviewerAuthImpl: async ({ env }) => {
      probeEnv = env;
      return {
        ok: false,
        reason: 'agy-probe-timeout',
        detail: '`agy models` timed out',
        remediation: 'retry after the local agy/network path is healthy',
      };
    },
  });

  assert.deepEqual(result, { checked: true, ok: false, reason: 'agy-probe-timeout' });
  assert.equal(probeEnv.GEMINI_API_KEY, undefined);
  assert.equal(probeEnv.GOOGLE_API_KEY, undefined);
  assert.equal(probeEnv.HOME, '/Users/airlock');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /WARN config key=reviewer\.gemini\.runtime/);
  assert.match(warnings[0], /agy-probe-timeout/);
  assert.match(warnings[0], /retry after the local agy\/network path is healthy/);
});

test('watcher startup skips agy auth preflight for non-antigravity runtime', async () => {
  const result = await warnIfAntigravityReviewerAuthUnavailable({
    env: { HOME: '/Users/airlock' },
    resolveGeminiRuntimeImpl: () => 'cli',
    checkAgyReviewerAuthImpl: async () => {
      throw new Error('agy auth must not run for cli runtime');
    },
  });

  assert.deepEqual(result, { checked: false, runtime: 'cli' });
});

test('watcher startup treats thrown agy auth preflight as warning-only', async () => {
  const warnings = [];

  const result = await warnIfAntigravityReviewerAuthUnavailable({
    env: { HOME: '/Users/airlock' },
    log: { warn: (message) => warnings.push(String(message)) },
    resolveGeminiRuntimeImpl: () => 'antigravity',
    checkAgyReviewerAuthImpl: async () => {
      throw new Error('launchd keychain prompt unavailable');
    },
  });

  assert.deepEqual(result, { checked: true, ok: false, reason: 'agy-probe-threw' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /agy-probe-threw/);
  assert.match(warnings[0], /launchd keychain prompt unavailable/);
  assert.match(warnings[0], /per-review AGY auth probe remains fail-closed/);
});
