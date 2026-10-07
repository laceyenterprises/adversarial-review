// QUOTAPAUSE-01: the dispatch daemon mirrors a per-credential quota pause onto
// that credential's operator suspension, the same status file `hq fleet quota
// suspend` writes. These tests feed the exact row the daemon writes and prove the
// watcher's reviewer spawn guard, reviewer fallback, follow-up remediation and
// AMA closer/hammer all hold on it, and that a lifted pause dispatches again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { resolveCloserDispatchHarness } from '../src/ama/harness-fallback.mjs';
import { harnessCapFromFleetStatus, providerAvailabilityFromFleetStatus } from '../src/fleet-quota-status.mjs';
import { resolveRemediationWorkerClassWithFallback } from '../src/remediation-worker-class-fallback.mjs';
import { resolveReviewerWorkerClassWithFallback } from '../src/review-worker-class-fallback.mjs';
import { spawnReviewer } from '../src/reviewer-spawn-settle.mjs';

// cwp_quota_probe.status_store.operator_suspend_payload, as written by
// cwp_dispatch.quota_pause.reconcile_suspension.
function pauseSuspension(provider) {
  const credential = `${provider}-oauth`;
  return {
    provider,
    authPath: 'oauth',
    state: 'exhausted',
    schemaVersion: 1,
    lastErrorAt: '2026-10-07T02:00:00Z',
    lastErrorSignature: 'operator_suspend',
    resetAtUtc: null,
    source: 'operator',
    operatorReason: `quota-pause: ${credential} at 4.0% remaining <= pause 5.0%; release 2026-10-09T22:00:00Z`,
    operatorSuspendUntil: '2026-10-09T22:00:00Z',
    operatorSuspendIndefinite: false,
  };
}

const OK = (provider) => ({ provider, authPath: 'oauth', state: 'ok', source: 'probe' });

function fleetStatusStub(rows) {
  const stdout = JSON.stringify({ providerStatuses: rows });
  return async () => ({ stdout, stderr: '' });
}

test('a pause suspension row grounds its provider for every fleet-quota reader', () => {
  const stdout = JSON.stringify({ providerStatuses: [pauseSuspension('anthropic'), OK('openai')] });
  const anthropic = providerAvailabilityFromFleetStatus(stdout, { provider: 'anthropic' });
  assert.equal(anthropic.available, false);
  assert.equal(anthropic.state, 'exhausted');
  const cap = harnessCapFromFleetStatus(stdout, { harness: 'claude-code' });
  assert.equal(cap.capped, true);
  assert.equal(cap.capSource, 'provider-grounded');
  // Per-key independence: the other credential still dispatches.
  assert.equal(providerAvailabilityFromFleetStatus(stdout, { provider: 'openai' }).available, true);
});

test('reviewer fallback moves off a paused primary and holds when every fallback is paused', async () => {
  const moved = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'gemini',
    primary: 'claude-code',
    fallbackWorkerClasses: ['codex'],
    execFileImpl: fleetStatusStub([pauseSuspension('anthropic'), OK('openai')]),
  });
  assert.equal(moved.workerClass, 'codex');
  assert.equal(moved.reason, 'primary-grounded-fallback');

  const held = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'gemini',
    primary: 'claude-code',
    fallbackWorkerClasses: ['codex'],
    execFileImpl: fleetStatusStub([pauseSuspension('anthropic'), pauseSuspension('openai')]),
  });
  assert.equal(held.workerClass, 'claude-code');
  assert.equal(held.fellBack, false);
  assert.equal(held.reason, 'no-available-fallback');
  assert.equal(held.primaryState, 'exhausted');
});

test('follow-up remediation holds while its remediator credential is paused', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'claude-code',
    fallbackWorkerClasses: ['codex'],
    execFileImpl: fleetStatusStub([pauseSuspension('anthropic'), pauseSuspension('openai')]),
  });
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.fellBack, false);
  assert.equal(result.hold, true);
  assert.equal(result.reason, 'no-available-fallback');
});

test('AMA closer/hammer holds with all-fallbacks-grounded while both credentials are paused', async () => {
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['hammer-claude'],
    execFileImpl: fleetStatusStub([pauseSuspension('openai'), pauseSuspension('anthropic')]),
  });
  assert.equal(result.workerClass, 'hammer');
  assert.equal(result.fellBack, false);
  assert.equal(result.hold, true);
  assert.equal(result.reason, 'all-fallbacks-grounded');
});

test('AMA closer dispatches again once the pause lifts', async () => {
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['hammer-claude'],
    execFileImpl: fleetStatusStub([OK('openai'), OK('anthropic')]),
  });
  assert.equal(result.workerClass, 'hammer');
  assert.notEqual(result.hold, true);
});

async function withStatusFile(payload, fn) {
  const statusDir = await mkdtemp(join(tmpdir(), 'quota-pause-'));
  try {
    await writeFile(join(statusDir, 'anthropic-oauth.status.json'), `${JSON.stringify(payload)}\n`, 'utf8');
    return await fn(statusDir);
  } finally {
    await rm(statusDir, { recursive: true, force: true });
  }
}

function spawnArgs(statusDir, capture) {
  return {
    repo: 'example/demo',
    prNumber: 99,
    reviewerModel: 'claude-code',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    reviewerHeadSha: 'deadbeef',
    reviewerSessionUuid: randomUUID(),
    reviewAttemptNumber: 1,
    reviewDbAttemptNumber: 1,
    maxRemediationRounds: 2,
    quotaCheckEnv: { AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED: 'true', AGENT_OS_REVIEWER_QUOTA_STATUS_DIR: statusDir },
    reviewerRuntimeAdapterOverride: {
      async spawnReviewer() {
        capture.spawnCalls += 1;
        return { ok: true, reviewBody: 'test', reviewBodyDelivery: 'adapter' };
      },
    },
    beginReviewerPassImpl() {},
    async completeReviewerPassImpl(_rootDir, args) {
      capture.completed.push(args);
    },
    postGitHubReviewWithCaptureImpl: async () => {},
    readBestReviewerEvidenceTokenUsageImpl: async () => null,
    ledgerLookupSleepImpl: async () => {},
  };
}

test('reviewer spawn guard refuses to spawn on the pause suspension status file', async () => {
  await withStatusFile(pauseSuspension('anthropic'), async (statusDir) => {
    const capture = { spawnCalls: 0, completed: [] };
    const result = await spawnReviewer(spawnArgs(statusDir, capture));
    assert.equal(capture.spawnCalls, 0);
    assert.equal(result.failureClass, 'quota-exhausted');
    assert.equal(result.transient, true);
    assert.equal(capture.completed[0].metadata.quotaState, 'exhausted');
  });
});
