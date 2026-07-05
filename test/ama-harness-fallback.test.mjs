import test from 'node:test';
import assert from 'node:assert/strict';

import {
  providerForCloserWorkerClass,
  resolveCloserDispatchHarness,
} from '../src/ama/harness-fallback.mjs';
import {
  isGroundedProviderState,
  providerAvailabilityFromFleetStatus,
} from '../src/fleet-quota-status.mjs';

// A `hq fleet quota status --json` payload with the given provider states. The
// shape mirrors cwp_dispatch/cli_fleet.py's `providerStatuses` output.
function fleetQuotaStdout(states = {}) {
  const providerStatuses = Object.entries(states).map(([provider, state]) => ({
    provider,
    authPath: 'oauth',
    state,
    lastProbeAt: '2026-07-05T00:00:00Z',
    lastGoodAt: '2026-07-04T00:00:00Z',
  }));
  return JSON.stringify({ providerStatuses, lastProbeAt: '2026-07-05T00:00:00Z' });
}

function buildFleetExec(stdout) {
  const calls = [];
  const impl = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout, stderr: '' };
  };
  return { impl, calls };
}

test('providerForCloserWorkerClass maps hammer/codex → openai and claude-code → anthropic', () => {
  assert.equal(providerForCloserWorkerClass('hammer'), 'openai');
  assert.equal(providerForCloserWorkerClass('codex'), 'openai');
  assert.equal(providerForCloserWorkerClass('claude-code'), 'anthropic');
  assert.equal(providerForCloserWorkerClass('gemini'), 'google');
  assert.equal(providerForCloserWorkerClass('nonsense'), null);
});

test('isGroundedProviderState treats exhausted/suspended as grounded, ok/degraded/unknown as not', () => {
  assert.equal(isGroundedProviderState('exhausted'), true);
  assert.equal(isGroundedProviderState('suspended'), true);
  assert.equal(isGroundedProviderState('ok'), false);
  assert.equal(isGroundedProviderState('degraded'), false);
  assert.equal(isGroundedProviderState('unknown'), false);
  assert.equal(isGroundedProviderState(''), false);
});

test('providerAvailabilityFromFleetStatus prefers the oauth auth-path status', () => {
  const stdout = JSON.stringify({
    providerStatuses: [
      { provider: 'openai', authPath: 'litellm-vk', state: 'ok' },
      { provider: 'openai', authPath: 'oauth', state: 'exhausted' },
    ],
  });
  const decision = providerAvailabilityFromFleetStatus(stdout, { provider: 'openai' });
  assert.equal(decision.state, 'exhausted');
  assert.equal(decision.available, false);
});

test('no fallback configured → keep primary, no fleet-quota read', async () => {
  const exec = buildFleetExec(fleetQuotaStdout({ openai: 'exhausted' }));
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: [],
    execFileImpl: exec.impl,
  });
  assert.equal(result.fellBack, false);
  assert.equal(result.workerClass, 'hammer');
  assert.equal(result.reason, 'no-fallback-configured');
  assert.equal(exec.calls.length, 0, 'must not query fleet quota when no fallback is configured');
});

test('codex grounded (exhausted) + hammer primary → falls back to claude-code', async () => {
  const exec = buildFleetExec(fleetQuotaStdout({ openai: 'exhausted', anthropic: 'ok' }));
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: exec.impl,
  });
  assert.equal(result.fellBack, true);
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.from, 'hammer');
  assert.equal(result.to, 'claude-code');
  assert.equal(result.provider, 'openai');
  assert.equal(result.primaryState, 'exhausted');
  assert.equal(result.fallbackProvider, 'anthropic');
  assert.equal(exec.calls.length, 1);
  assert.deepEqual(exec.calls[0].args, ['fleet', 'quota', 'status', '--json']);
});

test('codex healthy (ok) → keep primary hammer (auto-revert, no fallback)', async () => {
  const exec = buildFleetExec(fleetQuotaStdout({ openai: 'ok', anthropic: 'ok' }));
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: exec.impl,
  });
  assert.equal(result.fellBack, false);
  assert.equal(result.workerClass, 'hammer');
  assert.equal(result.reason, 'primary-available');
  assert.equal(result.primaryState, 'ok');
});

test('ambiguous codex state (degraded/unknown/missing) → keep primary (no guess)', async () => {
  for (const state of ['degraded', 'unknown']) {
    const exec = buildFleetExec(fleetQuotaStdout({ openai: state }));
    const result = await resolveCloserDispatchHarness({
      workerClass: 'hammer',
      fallbackWorkerClasses: ['claude-code'],
      execFileImpl: exec.impl,
    });
    assert.equal(result.fellBack, false, `state=${state} must not fall back`);
    assert.equal(result.reason, 'primary-not-grounded');
  }
  // Missing provider status entirely → also no guess.
  const execMissing = buildFleetExec(fleetQuotaStdout({ anthropic: 'ok' }));
  const missing = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: execMissing.impl,
  });
  assert.equal(missing.fellBack, false);
});

test('fleet quota status unavailable (exec throws) → fail-open to primary', async () => {
  const impl = async () => {
    throw new Error('hq: command not found');
  };
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: impl,
  });
  assert.equal(result.fellBack, false);
  assert.equal(result.workerClass, 'hammer');
  assert.equal(result.reason, 'fleet-quota-status-unavailable');
});

test('every fallback also grounded → keep primary (doomed but auto-reverting)', async () => {
  const exec = buildFleetExec(fleetQuotaStdout({ openai: 'exhausted', anthropic: 'exhausted' }));
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: exec.impl,
  });
  assert.equal(result.fellBack, false);
  assert.equal(result.workerClass, 'hammer');
  assert.equal(result.reason, 'all-fallbacks-grounded');
});

test('skips a grounded fallback and picks the first healthy one in order', async () => {
  // openai (hammer) exhausted, google (gemini) exhausted, anthropic (claude-code) ok.
  const exec = buildFleetExec(fleetQuotaStdout({ openai: 'exhausted', google: 'exhausted', anthropic: 'ok' }));
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['gemini', 'claude-code'],
    execFileImpl: exec.impl,
  });
  assert.equal(result.fellBack, true);
  assert.equal(result.to, 'claude-code');
});

test('primary provider untracked → never fall back (cannot prove a cap)', async () => {
  const exec = buildFleetExec(fleetQuotaStdout({ openai: 'exhausted' }));
  const result = await resolveCloserDispatchHarness({
    workerClass: 'some-bespoke-worker',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: exec.impl,
  });
  assert.equal(result.fellBack, false);
  assert.equal(result.reason, 'primary-provider-untracked');
  assert.equal(exec.calls.length, 0);
});
