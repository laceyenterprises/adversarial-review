import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveRemediationWorkerClassWithFallback,
  remediationWorkerClassFallback,
} from '../src/remediation-worker-class-fallback.mjs';

function fleetStatusStub(rows) {
  // Shape parsed by parseHqFleetQuotaStatus: { providerStatuses: [{provider, authPath, state}] }
  const stdout = JSON.stringify({ providerStatuses: rows });
  return async () => ({ stdout });
}

const CODEX_EXHAUSTED_CLAUDE_OK = [
  { provider: 'openai', authPath: 'oauth', state: 'exhausted' },
  { provider: 'anthropic', authPath: 'oauth', state: 'ok' },
];
const CODEX_OK = [
  { provider: 'openai', authPath: 'oauth', state: 'ok' },
  { provider: 'anthropic', authPath: 'oauth', state: 'ok' },
];

test('falls back codex -> claude-code when the routed codex harness provider is exhausted', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: fleetStatusStub(CODEX_EXHAUSTED_CLAUDE_OK),
  });
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.fellBack, true);
  assert.equal(result.reason, 'primary-grounded-fallback');
  assert.equal(result.primaryState, 'exhausted');
});

test('keeps the routed codex harness when codex has quota (auto-revert on recovery)', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: fleetStatusStub(CODEX_OK),
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
  assert.equal(result.reason, 'primary-available');
});

test('never grounds on a soft/unknown signal (does not fall back when codex is only degraded)', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: fleetStatusStub([
      { provider: 'openai', authPath: 'oauth', state: 'degraded' },
      { provider: 'anthropic', authPath: 'oauth', state: 'ok' },
    ]),
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
});

test('no fallback configured -> keeps the primary', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: [],
    execFileImpl: fleetStatusStub(CODEX_EXHAUSTED_CLAUDE_OK),
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
  assert.equal(result.reason, 'no-fallback-configured');
});

test('fail-open: an unreadable fleet-quota status keeps the primary (never guesses a cap)', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: async () => {
      throw new Error('hq unavailable');
    },
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
  assert.equal(result.reason, 'fleet-quota-status-unavailable');
});

test('falls back claude-code -> codex when Claude is grounded and Codex is available', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'claude-code',
    fallbackWorkerClasses: remediationWorkerClassFallback({}),
    execFileImpl: fleetStatusStub([
      { provider: 'openai', authPath: 'oauth', state: 'ok' },
      { provider: 'anthropic', authPath: 'oauth', state: 'exhausted' },
    ]),
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, true);
  assert.equal(result.primaryState, 'exhausted');
});

test('remediationWorkerClassFallback defaults to both harnesses and honors the env override', () => {
  assert.deepEqual(remediationWorkerClassFallback({}), ['claude-code', 'codex']);
  assert.deepEqual(
    remediationWorkerClassFallback({ ADVERSARIAL_REVIEW_REMEDIATOR_WORKER_CLASS_FALLBACK: 'claude-code, gemini' }),
    ['claude-code', 'gemini'],
  );
  assert.deepEqual(remediationWorkerClassFallback({ ADVERSARIAL_REVIEW_REMEDIATOR_WORKER_CLASS_FALLBACK: '' }), []);
});
