import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialBrokerReady, deferForCredentialBroker, credentialRefreshUnavailable,
  credentialPublicationRefund, CREDENTIAL_REFRESH_UNAVAILABLE } from '../src/remediation-credential-broker.mjs';
import { createFollowUpJob, claimNextFollowUpJob, markFollowUpJobSpawned, readFollowUpJob,
  summarizePRRemediationLedger } from '../src/follow-up-jobs.mjs';
import { settleInfrastructureRemediationRound } from '../src/remediation-round-accounting.mjs';
import { consumeNextFollowUpJob } from '../src/follow-up-remediation.mjs';

const head = 'a'.repeat(40);
const localCommit = 'b'.repeat(40);
const at = '2026-01-01T00:00:00.000Z';
const later = '2026-01-01T00:01:00.000Z';
const log = { log() {}, warn() {}, error() {} };
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'broker-ready-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const created = createFollowUpJob({ rootDir, repo: 'fixture/repo', prNumber: 1,
    branch: 'fixture/remediation', revisionRef: head, reviewerModel: 'claude',
    reviewBody: 'Fix the bug.', reviewPostedAt: at, critical: true });
  return { rootDir, created };
}

for (const status of [200, 503, 401, 302]) {
  test(`readiness uses the configured base and bounded unauthenticated /readyz (HTTP ${status})`, async () => {
    const signal = new AbortController().signal;
    const result = await credentialBrokerReady({ env: { OAUTH_BROKER_URL: 'http://broker.invalid/base/' },
      signalImpl: ms => { assert.equal(ms, 2000); return signal; },
      fetchImpl: async (url, options) => {
        assert.equal(url, 'http://broker.invalid/base/readyz');
        assert.equal(options.signal, signal);
        assert.equal(options.headers, undefined);
        assert.equal(options.redirect, 'error');
        return { status };
      } });
    assert.equal(result.ready, status === 200);
  });
}
test('timeout and connection refusal fail closed without real sleeps', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = credentialBrokerReady({ env: { OAUTH_BROKER_URL: 'http://broker.invalid' },
    signalImpl: ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    },
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) });
  t.mock.timers.tick(2000);
  assert.deepEqual(await pending, { ready: false });
  assert.deepEqual(await credentialBrokerReady({ env: { OAUTH_BROKER_URL: 'http://broker.invalid' },
    fetchImpl: async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); } }), { ready: false });
});
test('plain Git without broker configuration does not probe', async () => {
  assert.equal((await credentialBrokerReady({ env: {},
    fetchImpl: () => assert.fail('unexpected probe') })).ready, true);
});
test('consume defers before worker preparation or spawn and retains the round', async t => {
  const { rootDir } = fixture(t);
  let probes = 0;
  const result = await consumeNextFollowUpJob({ rootDir, now: () => at, promptTemplate: 'synthetic',
    ensureWorkerRegistryReadyImpl: async () => {},
    resolvePRLifecycleImpl: async () => ({ source: 'live', prState: 'open', headSha: head }),
    credentialBrokerReadyImpl: async () => { probes++; return { ready: false }; },
    spawnImpl: () => assert.fail('unready broker spawned a worker'),
    execFileImpl: () => assert.fail('worker preparation ran'), log });
  assert.equal(probes, 1);
  assert.equal(result.consumed, false);
  assert.equal(result.reason, 'credential-broker-unready');
  assert.equal(result.job.status, 'pending');
  assert.equal(result.job.remediationPlan.currentRound, 0);
  assert.equal(result.job.remediationPlan.rounds.length, 0);
  assert.equal(result.job.remediationPlan.retryAfter, '2026-01-01T00:00:10.000Z');
  assert.deepEqual(readFollowUpJob(result.jobPath), result.job);
  assert.equal(claimNextFollowUpJob({ rootDir, claimedAt: '2026-01-01T00:00:09.000Z' }), null);
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-01-01T00:00:10.000Z' });
  const retry = await deferForCredentialBroker({ rootDir, claimed, now: () => '2026-01-01T00:00:10.000Z',
    probeImpl: async () => ({ ready: false }) });
  assert.equal(retry.job.remediationPlan.currentRound, 0);
  assert.equal(retry.job.remediationPlan.retryAfter, '2026-01-01T00:00:30.000Z');
  assert.equal(retry.job.jobId, result.job.jobId);
});
test('ready broker leaves the claimed job unchanged for spawn', async t => {
  const { rootDir } = fixture(t);
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: at });
  const before = readFollowUpJob(claimed.jobPath);
  assert.equal(await deferForCredentialBroker({ rootDir, claimed, now: () => at,
    probeImpl: async () => ({ ready: true }) }), null);
  assert.deepEqual(readFollowUpJob(claimed.jobPath), before);
});

test('credential diagnostics exclude genuine push and lease rejections', () => {
  const entitled = 'entitled GitHub re-mint unavailable: broker_unavailable; refusing credential fallback';
  const legacy = 'broker mode: transient broker failure exhausted retries for http://broker.invalid (curl_rc=7, HTTP 000)\n'
    + 'worker GitHub push credential is unusable and could not be refreshed (expired).\n'
    + "fatal: could not read Username for 'https://example.invalid': terminal prompts disabled";
  for (const stderr of [entitled, legacy]) {
    assert.equal(credentialRefreshUnavailable({ stderr }), true);
    assert.equal(credentialRefreshUnavailable({ stderr: `${stderr}\n! [rejected] topic -> topic (stale info)` }), false);
    assert.equal(credentialRefreshUnavailable({ stderr, code: 'ETIMEDOUT' }), false);
    assert.equal(credentialRefreshUnavailable({ stderr, signal: 'SIGTERM' }), false);
  }
  for (const stderr of ['Authentication failed', 'lease mismatch',
    'entitled GitHub re-mint unavailable: broker_identity_mismatch; refusing credential fallback',
    'fatal: could not read Username: terminal prompts disabled']) {
    assert.equal(credentialRefreshUnavailable({ stderr }), false);
  }
});

for (const [code, endHead] of [[CREDENTIAL_REFRESH_UNAVAILABLE, head], ['remediation-publication-unproven', head],
  [CREDENTIAL_REFRESH_UNAVAILABLE, localCommit], [CREDENTIAL_REFRESH_UNAVAILABLE, null]]) {
  test(`settlement refunds only credential failure with an unchanged known head (${code}, ${endHead})`, async t => {
    const { rootDir } = fixture(t);
    const claimed = claimNextFollowUpJob({ rootDir, claimedAt: at });
    const saved = join(rootDir, 'saved-commit');
    writeFileSync(saved, localCommit);
    const spawned = markFollowUpJobSpawned({ rootDir, jobPath: claimed.jobPath, spawnedAt: at,
      worker: { processId: 1234, model: 'codex', workspaceDir: rootDir, recordedOutcome: { exitCode: 1 } } });
    const failure = { code, previousHead: head, localCommit, refusedAt: later };
    const result = await settleInfrastructureRemediationRound({ rootDir, ...spawned,
      worker: spawned.job.remediationWorker, liveness: { state: 'exited' },
      lifecycle: { source: 'live', headSha: endHead }, completedAt: later,
      publicationFailure: failure, publicationReply: { outcome: 'blocked', blockers: [], pushback: [],
        operationalBlockers: [{ code }] }, now: () => later, log,
      postOutcomeComment: async () => {} });
    if (code === CREDENTIAL_REFRESH_UNAVAILABLE && endHead === head) {
      assert.equal(result.action, 'requeued');
      assert.equal(result.reason, 'credential-refresh-unavailable');
      assert.equal(result.job.remediationPlan.currentRound, 0);
      assert.equal(result.job.remediationPlan.transientRetries, 0);
      const metadata = result.job.remediationPlan.retryHistory.at(-1).retryMetadata;
      assert.equal(metadata.state, 'infrastructure-failed');
      assert.equal(metadata.localCommit, localCommit);
      assert.equal(metadata.resumeWorkspace, true);
      assert.equal(summarizePRRemediationLedger(rootDir, result.job).completedRoundsForPR, 0);
    } else {
      assert.equal(result, null);
      assert.equal(readFollowUpJob(spawned.jobPath).remediationPlan.currentRound, 1);
    }
    assert.ok(existsSync(saved));
  });
}
test('stale artifacts, other blockers, cancellation and independent failures stay charged', () => {
  const args = { failure: { code: CREDENTIAL_REFRESH_UNAVAILABLE, previousHead: head, localCommit, refusedAt: later },
    job: { revisionRef: head }, worker: { spawnedAt: at }, outcome: { exitCode: 1 },
    reply: { outcome: 'blocked', blockers: [], pushback: [], operationalBlockers: [{ code: CREDENTIAL_REFRESH_UNAVAILABLE }] } };
  assert.equal(credentialPublicationRefund(args), 'credential-refresh-unavailable');
  for (const override of [{ failure: { ...args.failure, refusedAt: '2025-01-01' } },
    { failure: { ...args.failure, previousHead: localCommit } }, { reply: null },
    { reply: { ...args.reply, blockers: ['unresolved finding'] } },
    { reply: { ...args.reply, operationalBlockers: [{ code: 'ci-failed' }] } },
    { reply: { ...args.reply, outcome: 'completed' } },
    { outcome: { failureReason: 'lease-mismatch' } }, { outcome: { signal: 'SIGTERM' } },
    { outcome: { status: 'cancelled' } }]) {
    assert.equal(credentialPublicationRefund({ ...args, ...override }), null);
  }
});

test('repeated proven broker outages keep the round and separate infrastructure allowance', async t => {
  const { rootDir } = fixture(t);
  let clock = Date.parse(at);
  for (let attempt = 0; attempt < 3; attempt++) {
    const startedAt = new Date(clock).toISOString();
    const claimed = claimNextFollowUpJob({ rootDir, claimedAt: startedAt });
    assert.equal(claimed.job.remediationPlan.currentRound, 1);
    const spawned = markFollowUpJobSpawned({ rootDir, jobPath: claimed.jobPath, spawnedAt: startedAt,
      worker: { processId: 1234, model: 'claude-code', workspaceDir: rootDir } });
    const result = await settleInfrastructureRemediationRound({ rootDir, ...spawned,
      worker: spawned.job.remediationWorker, liveness: { state: 'exited' },
      lifecycle: { source: 'live', headSha: head }, completedAt: startedAt,
      publicationFailure: { code: CREDENTIAL_REFRESH_UNAVAILABLE, previousHead: head, localCommit, refusedAt: startedAt },
      publicationReply: { outcome: 'blocked', blockers: [], pushback: [],
        operationalBlockers: [{ code: CREDENTIAL_REFRESH_UNAVAILABLE }] },
      now: () => startedAt, log, postOutcomeComment: async () => {} });
    assert.equal(result.job.remediationPlan.currentRound, 0);
    assert.equal(result.job.remediationPlan.transientRetries, 0);
    assert.equal(result.job.remediationPlan.retryHistory.length, attempt + 1);
    assert.equal(summarizePRRemediationLedger(rootDir, result.job).infrastructureRefundsForPR, 0);
    clock += 30_000;
  }
});
