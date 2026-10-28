import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchReadTransport } from '../src/dispatch-read-client.mjs';
import { readLaunchRequestObservationFromLedgerAsync } from '../src/session-ledger-read-adapter.mjs';
import { closureOwnerShadowEvidence } from '../src/pr-next-action-consumer.mjs';
import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import { registerSharedNextAction, resolveSharedNextAction } from '../src/pr-next-action-shadow.mjs';
import { resolveClosureNextAction } from '../src/ama/closure-next-action.mjs';
import { requestEligibleHammerWake } from '../src/hammer-wake.mjs';
import { evaluateMergeEligibility } from '../src/ama/merge-eligibility.mjs';

const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40);
const AT = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T04:00:00.000Z';
const lease = { status: 'terminal', terminalOutcome: 'failed-without-merge', lrqId: 'synthetic-closer', headSha: HEAD };
const review = { verdict: 'comment-only', headSha: OLD, blockingFindingState: 'known', blockingFindingCount: 0,
  nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 };
const quiet = { log() {}, warn() {} };
const wire = (retry = null) => ({ schema_version: 1, status: 'found', complete: true,
  roots: [lease.lrqId], items: [{ launch_request_id: lease.lrqId, status: 'succeeded' }, ...(retry ? [retry] : [])],
  retry_edges: retry ? [{ parent: lease.lrqId, child: retry.launch_request_id }] : [] });

function fixture(t, { observedAt = AT, terminalProof = false } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'ownership-unreadable-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const input = { currentHead: HEAD, lease, reviewState: review, checks: 'SUCCESS', roundsLeft: false,
    closerAuthoredStale: { decision: 'carry-forward', carryForward: true, reviewedHead: OLD, currentHead: HEAD },
    ...(terminalProof ? { terminalReview: { validated: true, headSha: HEAD, reviewedHeadSha: OLD } } : {}) };
  const options = { rootDir, subjectKey: 'example/repo#1', observedAt,
    candidate: { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
    autonomousMergeExecutionEnabled: true, anchors: { firstActionableAt: AT } };
  const evidence = closureOwnerShadowEvidence(input, options);
  const passSnapshot = deriveNextActionSnapshot({ ...evidence, observations: { ...evidence.observations, controls: {} } });
  const snapshot = deriveNextActionSnapshot({ base: passSnapshot });
  const prior = { snapshot, decision: nextAction(snapshot) };
  assert.equal(prior.decision.row, 'R04-ownership');
  // Reproduce a consumer registering the unresolved closer-lease reference.
  registerSharedNextAction(passSnapshot, prior);
  const resolve = (extra = {}) => resolveClosureNextAction({ input, passSnapshot, ...options, ...extra });
  let wakes = 0;
  const wake = shared => requestEligibleHammerWake({ rootDir, repo: 'example/repo', prNumber: 1,
    headSha: HEAD, shared, observedAt, nowMs: Date.parse(observedAt), log: quiet,
    requestWatcherWakeImpl: () => { wakes++; return { requested: true }; } });
  return { prior, input, options, passSnapshot, resolve, wake, wakes: () => wakes };
}

test('OWNERUNREADABLE-01: a complete terminal root with no retry edges is readable through the public SDK', async () => {
  let reads = 0;
  const observation = await readLaunchRequestObservationFromLedgerAsync({ launchRequestId: lease.lrqId,
    dispatchSession: { dispatchLookup: async selector => {
      reads++;
      assert.equal(selector.include_retry_chain, true);
      return wire();
    } }, readWorkerStatusImpl: () => assert.fail('terminal launch outranks stale worker projections') });
  assert.equal(reads, 1);
  assert.equal(observation.state, 'complete');
  assert.equal(observation.value.terminal, true);
  assert.equal(observation.value.inFlight, false);
  assert.deepEqual(observation.value.retryChain, []);
  assert.equal(observation.value.retryChainUnreadable, false);
});

test('OWNERUNREADABLE-01: refresh replaces the unreadable closer-lease placeholder after one read', async t => {
  const f = fixture(t);
  let reads = 0;
  t.mock.method(dispatchReadTransport, 'lookup', async () => { reads++; return wire(); });
  const shared = await f.resolve();
  assert.equal(reads, 1);
  assert.equal(shared.decision.row, 'R08-retry');
  assert.equal(shared.decision.actor, 'hammer');
  assert.equal(shared.decision.queue.intent, 'dispatch');
  assert.deepEqual(shared.snapshot.observations.launches.value.closer.retryChain, []);
  assert.equal(f.prior.decision.row, 'R04-ownership', 'previous consumers retain their immutable decision');
  assert.equal(f.wake(shared).outcome, 'requested');
  assert.equal(f.wakes(), 1);
  const permission = evaluateMergeEligibility({ verdict: 'settled-success', leaseHeld: true,
    candidateHead: HEAD, validatedHead: HEAD, requiredChecks: [{ name: 'synthetic-check', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', prState: 'OPEN', branchProtectionRequired: false, labels: [] });
  assert.equal(permission.eligible, true, JSON.stringify(permission.reasons));
  await f.resolve();
  assert.equal(reads, 1, 'readable evidence remains shared within the pass');
});

test('OWNERUNREADABLE-01: a transient unreadable result re-reads with backoff and resolves', async t => {
  const f = fixture(t);
  const times = [];
  t.mock.method(dispatchReadTransport, 'lookup', async () => {
    times.push(Date.now());
    return times.length === 1 ? { ...wire(), status: 'unavailable' } : wire();
  });
  const shared = await f.resolve();
  assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 80, 'recovery does not hot-loop the ledger');
  assert.equal(shared.decision.actor, 'hammer');
  assert.equal(shared.decision.reason, 'retry-no-merge');
});

test('OWNERUNREADABLE-01: a complete unreadable payload stays fenced without immediate retries', async t => {
  const f = fixture(t, { observedAt: LATER });
  let reads = 0;
  const shared = await f.resolve({ readLaunches: async () => {
    reads++;
    return { state: 'complete', value: { closer: {
      launchRequestId: lease.lrqId, headSha: HEAD, row: { status: 'succeeded' },
      retryChainUnreadable: true,
    } } };
  } });
  assert.equal(reads, 1, 'complete unreadable evidence is not a transient read failure');
  assert.equal(shared.decision.reason, 'ownership-unreadable');
  assert.equal(f.wake(shared).retryable, true, 'the next closure pass may refresh the evidence');
  assert.equal(f.wakes(), 0);
});

for (const identity of [{ repo: '' }, { prNumber: 0 }, { prNumber: -1 }, { prNumber: 1.5 }, { headSha: '' }]) {
  test(`OWNERUNREADABLE-01: invalid wake identity is not retryable (${JSON.stringify(identity)})`, t => {
    const f = fixture(t);
    // Keep the R04 head binding valid even for a malformed empty head.
    const headSha = identity.headSha ?? HEAD;
    const result = requestEligibleHammerWake({ rootDir: f.options.rootDir,
      repo: 'example/repo', prNumber: 1, headSha, ...identity,
      shared: { snapshot: { head: headSha }, decision: {
        row: 'R04-ownership', reason: 'ownership-unreadable', head: headSha,
      } }, requestWatcherWakeImpl: () => assert.fail('invalid identity cannot wake the watcher') });
    assert.equal(result.outcome, 'skipped');
    assert.equal(result.reason, 'invalid-wake-identity');
    assert.equal(result.retryable, false);
    assert.equal(result.auditPath, undefined);
  });
}

test('OWNERUNREADABLE-01: recovery also re-reads when a registered snapshot is the pass itself', { timeout: 1000 }, async t => {
  const f = fixture(t);
  registerSharedNextAction(f.passSnapshot, { snapshot: f.passSnapshot, decision: nextAction(f.passSnapshot) });
  t.mock.method(dispatchReadTransport, 'lookup', async () => wire());
  const shared = await f.resolve();
  assert.equal(shared.decision.actor, 'hammer');
  assert.equal(shared.decision.queue.intent, 'dispatch');
});

test('OWNERUNREADABLE-01: refresh retains a live reviewer when there is no closer launch', async t => {
  const f = fixture(t);
  const snapshot = deriveNextActionSnapshot({ base: f.passSnapshot, observations: {
    launches: { closer: null }, leases: { closer: null }, reviews: { ...review, reviewerLive: true },
  } });
  registerSharedNextAction(snapshot, { snapshot, decision: nextAction(snapshot) });
  const shared = await resolveSharedNextAction({ passSnapshot: snapshot, refreshEvidence: true,
    evidence: { observations: { progress: {} } } });
  assert.equal(shared.decision.actor, 'reviewer');
  assert.equal(shared.decision.queue.intent, 'owned');
});

test('OWNERUNREADABLE-01: a lapsed recovery budget hands a certified stale head to hammer without re-review', async t => {
  const f = fixture(t, { observedAt: LATER, terminalProof: true });
  assert.equal(f.prior.decision.deadline.at, '2026-01-01T00:05:00.000Z');
  t.mock.method(dispatchReadTransport, 'lookup', async () => wire());
  const shared = await f.resolve();
  assert.equal(shared.decision.actor, 'hammer');
  assert.equal(shared.decision.row, 'R08-retry');
  assert.equal(shared.decision.queue.intent, 'dispatch');
  assert.equal(shared.snapshot.observations.reviews.value.headSha, OLD);
  assert.equal(f.wake(shared).outcome, 'requested');
});

test('OWNERUNREADABLE-01: an outage stays fenced past the deadline and a later refresh retries', async t => {
  const f = fixture(t, { observedAt: LATER, terminalProof: true });
  let reads = 0, down = true;
  t.mock.method(dispatchReadTransport, 'lookup', async () => {
    reads++;
    if (down) throw new Error('synthetic ledger outage');
    return wire();
  });
  const held = await f.resolve();
  assert.equal(reads, 3, 'the recovery read budget is bounded');
  assert.equal(held.decision.reason, 'ownership-unreadable');
  assert.deepEqual(held.decision.deadline, f.prior.decision.deadline);
  const wake = f.wake(held);
  assert.equal(wake.outcome, 'skipped');
  assert.equal(wake.retryable, true);
  assert.equal(f.wakes(), 0, 'unknown evidence never creates a speculative wake');
  down = false;
  const recovered = await f.resolve();
  assert.equal(reads, 4, 'a failed observation is not cached as permanent');
  assert.equal(recovered.decision.actor, 'hammer');
  assert.equal(f.wake(recovered).outcome, 'requested');
});

test('OWNERUNREADABLE-01: the anchored deadline survives same-pass refresh and transfers at expiry', async t => {
  const f = fixture(t, { observedAt: '2026-01-01T00:04:59.999Z', terminalProof: true });
  t.mock.method(dispatchReadTransport, 'lookup', async () => wire());
  const before = await f.resolve();
  assert.equal(before.decision.actor, 'daemon');
  const after = await f.resolve({ observedAt: '2026-01-01T00:05:00.000Z' });
  assert.equal(after.decision.actor, 'hammer');
  assert.equal(after.decision.queue.intent, 'dispatch');
  assert.equal(after.decision.deadline.anchoredAt, AT);
});

test('OWNERUNREADABLE-01: a stalled read shares one deadline and cannot retry after abort', { timeout: 7000 }, async t => {
  const f = fixture(t, { observedAt: LATER });
  const keepAlive = setTimeout(() => {}, 6500);
  t.after(() => clearTimeout(keepAlive));
  let reads = 0, signal;
  const started = Date.now();
  const shared = await f.resolve({ readLaunches: options => {
    reads++;
    signal = options.signal;
    return new Promise(resolve => signal.addEventListener('abort', () => resolve({ state: 'unknown', value: null }), { once: true }));
  } });
  assert.ok(Date.now() - started < 6500, 'all attempts share the five-second budget');
  assert.equal(reads, 1);
  assert.equal(signal.aborted, true);
  assert.equal(shared.decision.reason, 'ownership-unreadable');
  assert.equal(f.wake(shared).outcome, 'skipped');
  assert.equal(f.wakes(), 0);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(reads, 1, 'no delayed attempt survives the deadline');
});

for (const cap of ['retryExhausted', 'lifetimeExhausted']) {
  test(`OWNERUNREADABLE-01: recovery expiry retains ${cap}`, async t => {
    const f = fixture(t, { observedAt: LATER, terminalProof: true });
    t.mock.method(dispatchReadTransport, 'lookup', async () => wire());
    const shared = await f.resolve({ input: { ...f.input, [cap]: true } });
    assert.equal(shared.decision.actor, 'closure-recovery');
    assert.equal(shared.decision.queue.intent, 'reconcile');
    assert.equal(f.wake(shared).outcome, 'skipped');
    assert.equal(f.wakes(), 0);
  });
}

for (const status of ['running', 'waiting_input', 'unknown-future-status']) {
  test(`OWNERUNREADABLE-01: a ${status} retry still fences takeover after expiry`, async t => {
    const f = fixture(t, { observedAt: LATER, terminalProof: true });
    t.mock.method(dispatchReadTransport, 'lookup', async () => wire({ launch_request_id: 'synthetic-retry', status }));
    const shared = await f.resolve();
    assert.equal(shared.decision.row, status === 'unknown-future-status' ? 'R04-ownership' : 'R03-live-owner');
    assert.notEqual(shared.decision.queue.intent, 'dispatch');
    assert.equal(f.wake(shared).outcome, 'skipped');
    assert.equal(f.wakes(), 0);
  });
}

for (const reply of [{ ...wire(), complete: false },
  { schema_version: 1, status: 'not_found', complete: true, roots: [], items: [], retry_edges: [], scope_complete: false }]) {
  test('OWNERUNREADABLE-01: incomplete or grant-filtered empty evidence cannot release ownership', async t => {
    const f = fixture(t, { observedAt: LATER });
    t.mock.method(dispatchReadTransport, 'lookup', async () => reply);
    const shared = await f.resolve();
    assert.equal(shared.decision.reason, 'ownership-unreadable');
    assert.equal(f.wake(shared).outcome, 'skipped');
    assert.equal(f.wakes(), 0);
  });
}
