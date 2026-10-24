import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchRequestInFlight, launchRequestOwned, launchRequestMeaning, withLiveLaunchRetry } from '../src/ama/launch-request-status.mjs';
import { launchHoldsCloserCapacity } from '../src/ama/closure-capacity.mjs';
import { acquireAmaCloserLease, updateAmaCloserLease, readAmaCloserLease, rekeyAmaCloserLease, isHeldAmaCloserLease,
  isReclaimableTerminalAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { reconcileAmaCloserLeaseAsync, maybeDispatchAmaCloser, updateAmaCloserDispatchRecord,
  findActiveAmaCloserLaunches, amaCloserDispatchFilePath, isAmaCloserLaunchInProgress } from '../src/ama/dispatch-closer.mjs';
import { readLaunchRequestObservationFromLedgerAsync } from '../src/session-ledger-read-adapter.mjs';
import { decideClosureOwner } from './helpers/closure-owner-fixture.mjs';
import { reapStaleCloserLeases } from '../src/recovery-reaper.mjs';
import { probeOrphanOwnership } from '../src/ama/orphan-watchdog.mjs';

// Use the installed release, with no producer checkout or OS state.
import { LAUNCH_REQUEST_STATUSES, TERMINAL_LAUNCH_REQUEST_STATUSES, readDispatchStatus } from '@agent-os/app-sdk';
const vocabulary = { statuses: [...LAUNCH_REQUEST_STATUSES] };
const scheduling = {
  admitted: [true, true], blocked_needs_decision: [false, true],
  canceled: [false, false], failed: [false, false], leased: [true, true],
  operator_triage_required: [false, false], reaped_stuck_requested: [false, false],
  requested: [true, true], running: [true, true], starting: [true, true],
  succeeded: [false, false], superseded: [false, false],
  waiting_approval: [false, true], waiting_input: [false, true],
};
assert.deepEqual(Object.keys(scheduling).sort(), [...vocabulary.statuses].sort(), 'table covers the complete producer vocabulary');
for (const status of vocabulary.statuses) {
  test(`LRQSTATUS-01: ${status} scheduling and ownership`, () => {
    const [inFlight, owned] = scheduling[status];
    const probe = { ok: true, row: { status } };
    assert.equal(launchRequestInFlight(probe), inFlight);
    assert.equal(launchRequestOwned(probe), owned);
    assert.equal(launchHoldsCloserCapacity(probe.row), inFlight);
  });
}

test('wire booleans take precedence; missing/invalid booleans use producer meanings', () => {
  for (const status of ['running', 'succeeded', 'future']) {
    for (const terminal of [true, false]) {
      for (const succeeded of [true, false]) {
        const row = { status, terminal, succeeded };
        assert.equal(launchRequestInFlight({ ok: true, row }), !terminal);
        assert.equal(launchRequestMeaning(row).succeeded, succeeded);
      }
    }
  }
  assert.equal(launchRequestInFlight({ ok: true, row: { status: 'future' } }), null);
  assert.equal(launchRequestInFlight({ ok: true, row: { status: 'succeeded', terminal: 'false' } }), false);
  for (const status of ['blocked_needs_decision', 'waiting_input', 'waiting_approval']) {
    assert.equal(launchRequestInFlight({ ok: true, row: { status, terminal: false } }), false);
  }
  assert.equal(launchRequestInFlight({ ok: true, row: { status: 'failed' }, retryChainUnreadable: true }), null);
});

test('parked retry descendants retain ownership without capacity', () => {
  const probe = { ok: true, row: { status: 'failed' }, retryChain: [
    { status: 'blocked_needs_decision', launch_request_id: 'parked-retry' },
  ] };
  assert.equal(withLiveLaunchRetry(probe).liveRetryLaunchRequestId, 'parked-retry');
  assert.equal(launchRequestInFlight(probe), false);
  assert.equal(launchRequestOwned(probe), true);
});

test('producer-terminal decision evidence retains ownership until its status resolves', () => {
  for (const status of ['blocked_needs_decision', 'canceled', 'failed', 'superseded']) {
    const row = { status, terminal: true, succeeded: false };
    assert.equal(launchRequestMeaning(row).terminal, true);
    assert.equal(launchRequestInFlight({ ok: true, row }), false);
    assert.equal(launchRequestOwned({ ok: true, row }), status === 'blocked_needs_decision');
  }
});

test('wire-only live ownership returns a wait reason without a status string', () => {
  for (const status of [undefined, null, '', 42]) {
    const row = { status, terminal: false };
    const owner = decideClosureOwner({
      lease: { lrqId: 'wire-only', status: 'terminal', terminalOutcome: 'deferred' },
      launchStatusProbe: { ok: true, row }, currentHead: 'head',
      reviewState: { verdict: 'approved', headSha: 'head' },
    });
    assert.equal(owner.owner, 'hammer');
    assert.equal(owner.reason, 'live-owner');
  }
});

for (const status of ['blocked_needs_decision', 'waiting_input', 'waiting_approval']) {
  test(`fresh terminal ledger evidence overrides stored parked ${status}`, () => {
    const record = { state: 'dispatched', launchRequestId: 'parked', lastObservedStatus: status,
      dispatchedAt: '2026-10-01T00:00:00Z' };
    const options = { now: '2026-10-10T00:00:00Z', lease: null };
    assert.equal(isAmaCloserLaunchInProgress(record, options), true, 'parked ownership survives age and lease absence');
    assert.equal(isAmaCloserLaunchInProgress(record, { ...options, ledgerActive: undefined }), true,
      'unknown ledger evidence preserves parked ownership');
    assert.equal(isAmaCloserLaunchInProgress(record, { ...options, ledgerActive: false }), false,
      'confirmed terminal ledger evidence releases parked ownership');
    assert.equal(isAmaCloserLaunchInProgress({ ...record, state: 'dispatching' },
      { ...options, ledgerActive: false }), false, 'unreceipted intents fence their PR without reserving fleet capacity');
  });

  test(`parked ${status} releases lease and capacity without reassignment or scratch cleanup`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'launch-status-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const identity = { repo: 'fixture/repo', prNumber: 7, headSha: 'synthetic-head' };
    const now = '2026-10-01T12:00:00Z';
    acquireAmaCloserLease({ rootDir, ...identity, now });
    updateAmaCloserLease({ rootDir, ...identity, now, status: 'dispatched', lrqId: 'parked' });
    updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
      state: 'dispatched', launchRequestId: 'parked', dispatchedAt: now, lastObservedStatus: 'running' }));
    const probe = { ok: true, row: { status } };
    const reader = async () => probe;
    const noCleanup = () => assert.fail('parked worker retains scratch');
    assert.equal(await reconcileAmaCloserLeaseAsync({ rootDir, ...identity, now,
      statusProbe: probe, cleanupScratchImpl: noCleanup }), true);
    assert.equal(readAmaCloserLease(rootDir, identity).status, 'terminal');
    for (const reader of [async () => probe, async () => ({ ok: false })]) {
      // Closure-owner is synchronous; use the same known/unknown evidence.
      const launchProbe = await reader();
      const owner = decideClosureOwner({ rootDir, lease: readAmaCloserLease(rootDir, identity),
        currentHead: identity.headSha, readLaunchRequestStatusImpl: () => launchProbe,
        reviewState: { verdict: 'approved', headSha: identity.headSha } });
      assert.equal(owner.owner, 'hammer');
      assert.equal(owner.reason, launchProbe.ok ? 'live-owner' : 'ownership-unreadable');
    }

    assert.equal(isHeldAmaCloserLease(rootDir, identity, { now, launchStatusProbe: probe }), false);
    assert.equal(isReclaimableTerminalAmaCloserLease(readAmaCloserLease(rootDir, identity), { launchStatusProbe: probe }), false);
    const before = readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8');
    const active = await findActiveAmaCloserLaunches(rootDir, { now,
      readLaunchRequestStatusImpl: reader, cleanupScratchImpl: noCleanup });
    assert.equal(active.length, 1);
    assert.equal(active[0].holdsCapacity, false);
    assert.equal(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'), before);
    const ownership = await probeOrphanOwnership({ rootDir, ...identity, now,
      readStatusImpl: reader, processKillImpl: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } });
    assert.equal(ownership.owned, true);
    const result = await maybeDispatchAmaCloser({ cfg: { enabled: true },
      prMetadata: identity, dispatchContext: { rootDir, repo: identity.repo, dispatchedAt: now,
        orphanRecovery: { ownerProof: true, headSha: identity.headSha } },
      readLaunchRequestStatusImpl: reader, cleanupScratchImpl: noCleanup,
      execFileImpl: async () => assert.fail('must not dispatch or probe GitHub') });
    assert.equal(result.dispatched, false);
    assert.equal(result.reason, `dispatch-status-${status.replaceAll('_', '-')}`);
    assert.equal(result.inFlight, undefined);
    assert.equal(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'), before);
    const unavailable = async () => ({ ok: false, reason: 'synthetic-unavailable' });
    assert.equal((await probeOrphanOwnership({ rootDir, ...identity, now,
      readStatusImpl: unavailable })).owned, true, 'unreadable evidence cannot resolve a recorded decision');
    const unknownActive = await findActiveAmaCloserLaunches(rootDir, { now,
      readLaunchRequestStatusImpl: unavailable, cleanupScratchImpl: noCleanup });
    assert.equal(unknownActive.length, 1);
    assert.equal(unknownActive[0].holdsCapacity, false);
    // Parked evidence is not cached: cancellation releases watchdog ownership.
    assert.equal((await probeOrphanOwnership({ rootDir, ...identity, now,
      readStatusImpl: async () => ({ ok: true, row: { status: 'canceled' } }) })).owned, false);
  });
}

for (const parked of ['blocked_needs_decision', 'waiting_input', 'waiting_approval']) {
  for (const status of ['requested', 'admitted', 'leased', 'starting', 'running']) {
    test(`${parked} resumed as ${status} fences repeated dispatch and daemon merge${status === 'running' ? ' after rekey' : ''}`, async t => {
      const rootDir = mkdtempSync(join(tmpdir(), 'launch-resumed-'));
      t.after(() => rmSync(rootDir, { recursive: true, force: true }));
      const identity = { repo: 'fixture/repo', prNumber: 7, headSha: 'synthetic-head' };
      const now = '2026-10-01T12:00:00Z';
      acquireAmaCloserLease({ rootDir, ...identity, now });
      updateAmaCloserLease({ rootDir, ...identity, now, status: 'dispatched', lrqId: 'resumed' });
      const liveIdentity = status === 'running' ? { ...identity, headSha: 'rekeyed-head' } : identity;
      if (liveIdentity !== identity) assert.equal(rekeyAmaCloserLease({ rootDir, ...identity,
        fromHeadSha: identity.headSha, toHeadSha: liveIdentity.headSha, now }).rekeyed, true);
      updateAmaCloserLease({ rootDir, ...liveIdentity, now, status: 'terminal',
        terminalOutcome: 'deferred', lrqId: 'resumed' });
      updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
        state: 'dispatched', launchRequestId: 'resumed', lastObservedStatus: parked,
        dispatchedAt: now }));
      const readRecord = () => JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity)));
      const ownerInput = { rootDir, lease: readAmaCloserLease(rootDir, liveIdentity),
        currentHead: liveIdentity.headSha, reviewState: { verdict: 'approved', headSha: liveIdentity.headSha,
          blockingFindingCount: 0, blockingFindingState: 'known',
          nonBlockingFindingCount: 0, nonBlockingFindingState: 'known' } };
      let probe = { ok: true, row: { status } };
      const owner = () => decideClosureOwner({ ...ownerInput, readLaunchRequestStatusImpl: () => probe });
      assert.equal(owner().owner, 'hammer', 'a resumed launch fences an otherwise eligible inline merge');
      const dispatch = orphan => maybeDispatchAmaCloser({ cfg: { enabled: true },
        prMetadata: liveIdentity, dispatchContext: { rootDir, repo: identity.repo, dispatchedAt: now,
          ...(orphan ? { orphanRecovery: { ownerProof: true, headSha: liveIdentity.headSha } } : {}) },
        readLaunchRequestStatusImpl: async () => probe,
        cleanupScratchImpl: () => assert.fail('resumed worker retains scratch'),
        execFileImpl: async () => assert.fail('must not dispatch or probe GitHub') });
      for (const orphan of [false, false, true]) {
        const result = await dispatch(orphan);
        assert.equal(result.dispatched, false);
        assert.equal(result.skipMergeAgent, true);
        assert.equal(result.reason, `dispatch-status-${status}`);
        assert.equal(readRecord().lastObservedStatus, status, 'persist the resolved observation');
        assert.equal(owner().owner, 'hammer', 'persisting running must not remove the fence next poll');
      }
      const active = await findActiveAmaCloserLaunches(rootDir, { now,
        readLaunchRequestStatusImpl: async () => probe,
        cleanupScratchImpl: () => assert.fail('resumed worker retains scratch') });
      assert.equal(active.length, 1, 'resumed receipts remain visible after persisting an in-flight status');
      assert.equal(active[0].holdsCapacity, true, 'resumed execution occupies fleet capacity again');
      probe = { ok: false };
      assert.equal((await dispatch(false)).skipMergeAgent, true, 'unreadable evidence retains resumed ownership');
      assert.equal(owner().owner, 'hammer');
      for (const uncertain of [
        { ok: true, row: { status: 'failed' }, retryChainUnreadable: true },
        { ok: true, row: { status: 'future' } },
        { ok: true, row: { status: 'future', terminal: false } },
        { ok: true, row: { status: 'canceled', terminal: false } },
      ]) {
        probe = uncertain;
        for (let poll = 0; poll < 2; poll++) {
          assert.equal((await dispatch(false)).skipMergeAgent, true);
          assert.equal(readRecord().lastObservedStatus, status, 'unknown evidence must not overwrite the ownership observation');
          assert.equal(owner().owner, 'hammer');
        }
      }
      probe = { ok: true, row: { status: 'failed' }, retryChain: [
        { status, launch_request_id: 'resumed-retry' },
      ] };
      assert.equal((await dispatch(false)).skipMergeAgent, true, 'a live descendant retains ownership');
      assert.equal(owner().owner, 'hammer');
      probe = { ok: true, row: { status: 'canceled' } };
      assert.equal(owner().owner, 'daemon-merge', 'confirmed terminality releases the fence');
    });
  }
}

test('observation preserves terminal and succeeded wire evidence independently', async () => {
  const result = await readLaunchRequestObservationFromLedgerAsync({ launchRequestId: 'wire',
    readLaunchRequestStatusImpl: async () => ({ ok: true,
      row: { status: 'future', terminal: true, succeeded: false }, retryChain: [] }),
    readWorkerStatusImpl: async () => assert.fail('terminal launch needs no worker projection') });
  assert.equal(result.state, 'complete');
  assert.equal(result.value.inFlight, false);
  assert.equal(result.value.terminal, true);
  assert.equal(result.value.processSucceeded, false);
});

test('periodic reaper cannot reassign a decision-blocked worker at any age', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'launch-reaper-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'fixture/repo', prNumber: 8, headSha: 'synthetic-head' };
  const stamp = '2026-10-01T00:00:00Z';
  acquireAmaCloserLease({ rootDir, ...identity, now: stamp });
  updateAmaCloserLease({ rootDir, ...identity, now: stamp, status: 'dispatched', lrqId: 'decision' });
  const result = await reapStaleCloserLeases({ rootDir, now: '2026-10-10T00:00:00Z',
    thresholdMs: 1, deadHolderThresholdMs: 1, isProcessAlive: () => false,
    readLaunchRequestStatusImpl: async () => ({ ok: true, row: { status: 'blocked_needs_decision' } }),
    logger: { info() {}, warn() {}, error() {} } });
  assert.equal(result.released, 0);
  assert.equal(readAmaCloserLease(rootDir, identity).lrqId, 'decision');
});

test('an awaited parked probe cannot terminalize a successor lease', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'parked-successor-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'fixture/repo', prNumber: 9, headSha: 'synthetic-head' };
  const now = '2026-10-01T00:00:00Z';
  acquireAmaCloserLease({ rootDir, ...identity, now });
  updateAmaCloserLease({ rootDir, ...identity, now, status: 'dispatched', lrqId: 'predecessor' });
  await maybeDispatchAmaCloser({ cfg: { enabled: true }, prMetadata: identity,
    dispatchContext: { rootDir, repo: identity.repo, dispatchedAt: now },
    readLaunchRequestStatusImpl: async () => {
      updateAmaCloserLease({ rootDir, ...identity, now, status: 'dispatched', lrqId: 'successor' });
      return { ok: true, row: { status: 'blocked_needs_decision' } };
    }, execFileImpl: async () => assert.fail('no external action') });
  assert.equal(readAmaCloserLease(rootDir, identity).lrqId, 'successor');
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
});

for (const status of LAUNCH_REQUEST_STATUSES) {
  test(`SDK evidence: ${status} respects independent explicit and missing booleans`, () => {
    for (const terminal of [undefined, false, true]) {
      for (const succeeded of [undefined, false, true]) {
        const row = { status, terminal, succeeded };
        const meaning = launchRequestMeaning(row);
        assert.equal(meaning.terminal, terminal ?? TERMINAL_LAUNCH_REQUEST_STATUSES.has(status));
        assert.equal(meaning.succeeded, succeeded ?? (status === 'succeeded'));
        assert.equal(meaning.blockedNeedsDecision, status === 'blocked_needs_decision');
        assert.equal(meaning.parked, /^(blocked_|waiting_)/.test(status));
        assert.deepEqual(meaning.diagnostics, []);
      }
    }
  });
}

for (const status of [undefined, null, false, 42, {}, [], 'future', 'completed', 'complete', 'done', 'cancelled', 'reaped', 'rejected']) {
  test(`negative SDK launch mutation: ${JSON.stringify(status)} stays unknown without wire evidence`, () => {
    const row = { status };
    assert.equal(launchRequestMeaning(row).status, null);
    assert.equal(launchRequestMeaning(row).succeeded, false);
    assert.equal(launchRequestMeaning(row).terminal, false);
    assert.equal(launchRequestInFlight({ ok: true, row }), null);
    assert.equal(launchRequestMeaning({ ...row, terminal: false, succeeded: false }).terminal, false);
    assert.equal(launchRequestMeaning({ ...row, terminal: true }).terminal, true);
    assert.match(readDispatchStatus(row).diagnostics[0], /cwp_dispatch.dispatch: \$\.status/);
  });
}

test('negative malformed launch payloads do not fabricate success', () => {
  for (const row of [null, undefined, false, 42, [], {}]) {
    assert.equal(launchRequestMeaning(row).status, null);
    assert.equal(launchRequestMeaning(row).terminal, false);
    assert.equal(launchRequestMeaning(row).succeeded, false);
  }
});

for (const status of ['succeeded', 'failed', 'canceled', 'superseded']) {
  test(`lease reconciliation retains explicit nonterminal ${status} without cleanup`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'wire-lease-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const identity = { repo: 'fixture/repo', prNumber: 7, headSha: 'synthetic-head' };
    const now = '2026-10-01T12:00:00Z';
    acquireAmaCloserLease({ rootDir, ...identity, now });
    updateAmaCloserLease({ rootDir, ...identity, now, status: 'dispatched', lrqId: 'wire-launch' });
    const before = readAmaCloserLease(rootDir, identity);
    assert.equal(await reconcileAmaCloserLeaseAsync({ rootDir, ...identity, now,
      statusProbe: { ok: true, row: { status, terminal: false, succeeded: false } },
      cleanupScratchImpl: () => assert.fail('nonterminal launch keeps scratch'),
      readPullRequestStateImpl: () => assert.fail('nonterminal launch cannot settle ownership'),
    }), false);
    assert.deepEqual(readAmaCloserLease(rootDir, identity), before);
  });
}
