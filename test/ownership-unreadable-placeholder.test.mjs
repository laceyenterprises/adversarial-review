import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchReadTransport } from '../src/dispatch-read-client.mjs';
import { closureOwnerShadowEvidence } from '../src/pr-next-action-consumer.mjs';
import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import { registerSharedNextAction, shadowNextAction, resolveSharedNextAction } from '../src/pr-next-action-shadow.mjs';
import { requestEligibleHammerWake } from '../src/hammer-wake.mjs';

const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40);
const AT = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T04:00:00.000Z';
const LRQ = 'synthetic-closer';
const wire = retry => ({ schema_version: 1, status: 'found', complete: true,
  roots: [LRQ], items: [{ launch_request_id: LRQ, status: 'succeeded' }, ...(retry ? [retry] : [])],
  retry_edges: retry ? [{ parent: LRQ, child: retry.launch_request_id }] : [] });

function fixture(t, receiptOnly = false) {
  const rootDir = mkdtempSync(join(tmpdir(), 'ownership-placeholder-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const evidence = closureOwnerShadowEvidence({ currentHead: HEAD,
    lease: receiptOnly ? null : { status: 'terminal', terminalOutcome: 'failed-without-merge', lrqId: LRQ, headSha: HEAD },
    launchRecord: { launchRequestId: LRQ, terminalOutcome: 'failed-without-merge' },
    reviewState: { verdict: 'comment-only', headSha: OLD, blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
    checks: 'SUCCESS', roundsLeft: false,
    closerAuthoredStale: { decision: 'carry-forward', carryForward: true, reviewedHead: OLD, currentHead: HEAD },
  }, { rootDir, subjectKey: 'example/repo#1', observedAt: LATER, anchors: { firstActionableAt: AT },
    autonomousMergeExecutionEnabled: true, candidate: { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE' } });
  const snapshot = deriveNextActionSnapshot({ ...evidence, observations: { ...evidence.observations, controls: {} } });
  assert.equal(nextAction(snapshot).row, 'R04-ownership');
  let wakes = 0;
  const wake = shared => requestEligibleHammerWake({ rootDir, repo: 'example/repo', prNumber: 1, headSha: HEAD,
    shared, observedAt: LATER, nowMs: Date.parse(LATER), log: { log() {}, warn() {} },
    requestWatcherWakeImpl: () => { wakes++; return { requested: true }; } });
  return { rootDir, snapshot, wake, wakes: () => wakes };
}

for (const receiptOnly of [false, true]) {
  test(`OWNERUNREADABLE-02: snapshot resolves terminal ${receiptOnly ? 'receipt' : 'lease'} placeholder before R04`, async t => {
    const f = fixture(t, receiptOnly);
    let reads = 0;
    t.mock.method(dispatchReadTransport, 'lookup', async selector => {
      reads++;
      assert.equal(selector.include_retry_chain, true);
      return wire();
    });
    const shared = await resolveSharedNextAction({ snapshot: f.snapshot, rootDir: f.rootDir });
    assert.equal(reads, 1, 'snapshot recovery must actually resolve the ledger reference');
    assert.equal(shared.decision.row, 'R08-retry');
    assert.equal(shared.decision.queue.intent, 'dispatch');
    assert.deepEqual(shared.snapshot.observations.launches.value.closer.retryChain, []);
    assert.equal(f.wake(shared).outcome, 'requested');
    assert.equal(f.wake(shared).outcome, 'duplicate');
    assert.equal(f.wakes(), 1);
  });
}

for (const status of ['running', 'waiting_input', 'suspended']) {
  test(`OWNERUNREADABLE-02: ${status} retry retains R03 behind a snapshot placeholder`, async t => {
    const f = fixture(t);
    t.mock.method(dispatchReadTransport, 'lookup', async () => wire({ launch_request_id: 'synthetic-retry', status }));
    const shared = await resolveSharedNextAction({ snapshot: f.snapshot, rootDir: f.rootDir });
    assert.equal(shared.decision.row, 'R03-live-owner');
    assert.equal(shared.decision.queue.intent, 'owned');
    assert.equal(f.wake(shared).outcome, 'skipped');
    assert.equal(f.wakes(), 0);
  });
}

for (const failure of ['throw', 'partial', 'unknown-status']) {
  test(`OWNERUNREADABLE-02: ${failure} ledger evidence remains fenced past the deadline`, async t => {
    const f = fixture(t, true);
    t.mock.method(dispatchReadTransport, 'lookup', async () => {
      if (failure === 'throw') throw new Error('synthetic ledger read failure');
      if (failure === 'partial') return { ...wire(), complete: false };
      return wire({ launch_request_id: 'synthetic-retry', status: 'unknown-future-status' });
    });
    const shared = await resolveSharedNextAction({ snapshot: f.snapshot, rootDir: f.rootDir });
    assert.equal(shared.decision.reason, 'ownership-unreadable');
    assert.equal(shared.snapshot.observations.launches.value.closer.retryChainReadState, 'failed');
    assert.ok(shared.decision.evidenceRefs.includes('launch:retry-chain-unreadable'));
    assert.equal(f.wake(shared).outcome, 'skipped');
    assert.equal(f.wakes(), 0);
  });
}

test('OWNERUNREADABLE-02: unresolved provenance is distinct from a failed read and never bypasses R04', async t => {
  const f = fixture(t);
  const before = nextAction(f.snapshot);
  assert.ok(before.evidenceRefs.includes('launch:retry-chain-unresolved'));
  assert.ok(!before.evidenceRefs.includes('launch:retry-chain-unreadable'));
  const held = await resolveSharedNextAction({ snapshot: f.snapshot });
  assert.equal(held.decision.row, 'R04-ownership', 'missing reader authority cannot prove absence');
  assert.equal(f.wake(held).outcome, 'skipped');
});

test('OWNERUNREADABLE-02: older unmarked lease placeholders are resolved and cached', async t => {
  const f = fixture(t);
  const launches = structuredClone(f.snapshot.observations.launches);
  delete launches.value.closer.retryChainReadState;
  const snapshot = deriveNextActionSnapshot({ base: f.snapshot, observations: { launches } });
  let reads = 0;
  t.mock.method(dispatchReadTransport, 'lookup', async () => { reads++; return wire(); });
  const first = await resolveSharedNextAction({ snapshot, rootDir: f.rootDir });
  const second = await resolveSharedNextAction({ snapshot, rootDir: f.rootDir });
  assert.equal(first.decision.row, 'R08-retry');
  assert.equal(second.decision.row, 'R08-retry');
  assert.equal(reads, 1);
});


test('OWNERUNREADABLE-02: a registered unresolved snapshot is refreshed for the shadow too', async t => {
  const f = fixture(t);
  registerSharedNextAction(f.snapshot, { snapshot: f.snapshot, decision: nextAction(f.snapshot) });
  t.mock.method(dispatchReadTransport, 'lookup', async () => wire());
  const observed = await shadowNextAction({ snapshot: f.snapshot, rootDir: f.rootDir,
    sink: () => {}, now: () => Date.parse(LATER) });
  assert.equal(observed.decision.row, 'R08-retry');
  assert.equal(nextAction(f.snapshot).row, 'R04-ownership', 'the original snapshot stays immutable');
});
