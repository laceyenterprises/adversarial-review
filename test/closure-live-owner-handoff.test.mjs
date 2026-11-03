import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './helpers/load-aware-timeout-fixture.mjs';
import { acquireAmaCloserLease, updateAmaCloserLease, readAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { closureOwnerShadowEvidence, launchSource } from '../src/pr-next-action-consumer.mjs';
import { bindClosureNextAction } from '../src/ama/closure-next-action.mjs';
import { resolveMergeAgentCoexistenceForWatcher } from '../src/ama-closure-orchestration.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';

const START = Date.parse('2026-03-01T00:00:00Z');
const BOUND = 30 * 60 * 1000;
const REPO = 'example-org/subject';
const HEAD = 'c'.repeat(40);
const quiet = { info() {}, warn() {}, log() {} };
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'live-owner-handoff-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { rootDir, repo: REPO, prNumber: 41, headSha: HEAD };
  acquireAmaCloserLease({ ...identity, watcherPid: process.pid, now: new Date(START).toISOString() });
  updateAmaCloserLease({ ...identity, status: 'dispatched', lrqId: 'lrq-synthetic', now: new Date(START).toISOString() });
  const lease = readAmaCloserLease(rootDir, identity);
  const decision = { row: 'R03-live-owner', action: 'hammer', actor: 'hammer', reason: 'live-owner',
    head: HEAD, queue: { intent: 'owned' }, deadline: { at: new Date(START + BOUND).toISOString() } };
  const shared = { snapshot: { subjectKey: `${REPO}#41`, head: HEAD, generation: 1, observations: {
    leases: { state: 'complete', value: closureOwnerShadowEvidence({ lease }).observations.leases },
    launches: { state: 'complete', value: { closer: { launchRequestId: lease.lrqId, headSha: HEAD,
      probe: { ok: true, row: { status: 'running', launch_request_id: lease.lrqId, requested_at: new Date(START).toISOString() }, retryChain: [] } } } },
  } }, decision };
  let pages = 0;
  let failures = 0;
  const run = async (now, change = {}) => {
    const result = bindClosureNextAction({ amaEnabled: true, dispatched: false, skipMergeAgent: true,
      reason: 'existing-dispatch', nextAction: shared.decision, boundedWait: { exhausted: false }, ...change }, shared);
    return resolveMergeAgentCoexistenceForWatcher({ rootDir, repoPath: REPO, prNumber: 41,
      currentRevisionRef: HEAD, candidate: { headSha: HEAD, prState: 'open' }, labelNames: [],
      reviewStateRow: {}, dispatchJob: {}, logger: quiet,
      maybeDispatchAmaClosureForImpl: async () => result,
      recoverOrphanImpl: async () => null,
      orphanOptions: { now, env: {}, observeClosureWaitImpl: args => observeClosureWait({ ...args,
        pageImpl: async () => { pages++; if (failures > 0) { failures--; throw new Error('synthetic delivery failure'); } } }) },
    });
  };
  return { rootDir, identity, lease, shared, run, pages: () => pages, failNextPage: () => { failures++; } };
}

test('live preparation cannot renew the operator review deadline; custody survives restart', async t => {
  const f = fixture(t);
  assert.equal((await f.run(START + BOUND - 1)).outcome, 'ama-pending');
  // Fresh heartbeat, tool/token counters and changing preparation timestamps are liveness only.
  updateAmaCloserLease({ ...f.identity, status: 'dispatched', lrqId: f.lease.lrqId,
    now: new Date(START + BOUND).toISOString() });
  const result = await f.run(START + BOUND, { lastProgressAt: new Date(START + BOUND).toISOString(), toolCalls: 900, tokens: 1000000 });
  assert.equal(result.outcome, 'await-operator');
  assert.equal(result.amaClosureResult.liveCloserHandoff.reason, 'live-closer-progress-unverified');
  assert.equal(result.amaClosureResult.nextAction.queue.intent, 'owned');
  assert.deepEqual(readAmaCloserLease(f.rootDir, f.identity), { ...f.lease, updatedAt: new Date(START + BOUND).toISOString() });
  await f.run(START + BOUND + 1000);
  assert.equal(f.pages(), 1);
});

for (const status of ['waiting_for_operator', 'blocked_needs_decision', 'suspended', 'succeeded', 'unknown']) {
  test(`preserves ${status} under its existing owner without a handoff`, async t => {
    const f = fixture(t);
    f.shared.snapshot.observations.launches.value.closer.probe.row.status = status;
    assert.equal((await f.run(START + BOUND)).outcome, 'ama-pending');
    assert.equal(f.pages(), 0);
    assert.deepEqual(readAmaCloserLease(f.rootDir, f.identity), f.lease);
  });
}
for (const kind of ['review', 'research', 'read-only']) {
  test(`does not apply the merge handoff to ${kind} tasks`, async t => {
    const f = fixture(t);
    f.shared.snapshot.observations.launches.value.closer.probe.row.task_kind = kind;
    assert.equal((await f.run(START + BOUND)).outcome, 'ama-pending');
    assert.equal(f.pages(), 0);
  });
}
test('a claimed retry never inherits its ancestor review age', async t => {
  const f = fixture(t);
  f.shared.snapshot.observations.launches.value.closer.probe.retryChain = [
    { launch_request_id: 'lrq-successor', status: 'running' },
  ];
  assert.equal((await f.run(START + BOUND)).outcome, 'ama-pending');
  assert.equal(f.pages(), 0);
});
test('replacement lease generation invalidates an older observation', async t => {
  const f = fixture(t);
  updateAmaCloserLease({ ...f.identity, status: 'dispatched', lrqId: 'lrq-successor',
    now: new Date(START + BOUND).toISOString() });
  assert.equal((await f.run(START + BOUND)).outcome, 'ama-pending');
  assert.equal(f.pages(), 0);
});
for (const field of ['head', 'subjectKey']) {
  test(`a foreign ${field} cannot page this closer`, async t => {
    const f = fixture(t);
    f.shared.snapshot[field] = 'other';
    assert.equal((await f.run(START + BOUND)).outcome, 'ama-pending');
    assert.equal(f.pages(), 0);
  });
}
test('unreadable retry custody stays unknown', async t => {
  const f = fixture(t);
  f.shared.snapshot.observations.launches.value.closer.probe.retryChainUnreadable = true;
  assert.equal((await f.run(START + BOUND)).outcome, 'ama-pending');
  assert.equal(f.pages(), 0);
});
for (const activity of ['long-running-validation', 'active-source-writer', 'uncertain-effect']) {
  test(`${activity} retains its execution decision and lease during operator inspection`, async t => {
    const f = fixture(t);
    const result = await f.run(START + BOUND, { activity });
    assert.equal(result.outcome, 'await-operator');
    assert.equal(result.amaClosureResult.activity, activity);
    assert.equal(result.amaClosureResult.nextAction, f.shared.decision);
    assert.deepEqual(readAmaCloserLease(f.rootDir, f.identity), f.lease);
  });
}

test('failed notification retains the handoff and retries delivery on the next observation', async t => {
  const f = fixture(t);
  f.failNextPage();
  assert.equal((await f.run(START + BOUND)).outcome, 'await-operator');
  assert.equal((await f.run(START + BOUND + 1)).outcome, 'await-operator');
  await f.run(START + BOUND + 2);
  assert.equal(f.pages(), 2);
  assert.deepEqual(readAmaCloserLease(f.rootDir, f.identity), f.lease);
});
test('explicit operator holds keep their existing owner and page', async t => {
  const f = fixture(t);
  f.shared.decision.action = 'operator-hold';
  assert.equal((await f.run(START + BOUND)).outcome, 'await-operator');
  assert.equal(f.pages(), 0);
});

test('a successor adopting the lease receives its own durable request window', async t => {
  const f = fixture(t);
  updateAmaCloserLease({ ...f.identity, status: 'dispatched', lrqId: 'lrq-successor',
    now: new Date(START + BOUND).toISOString() });
  f.shared.snapshot.observations.leases.value.closer = readAmaCloserLease(f.rootDir, f.identity);
  const launch = f.shared.snapshot.observations.launches.value.closer;
  launch.launchRequestId = 'lrq-successor';
  launch.probe.row.launch_request_id = 'lrq-successor';
  launch.probe.row.requested_at = new Date(START + BOUND).toISOString();
  assert.equal((await f.run(START + BOUND)).outcome, 'ama-pending');
  assert.equal(f.pages(), 0);
  assert.equal((await f.run(START + 2 * BOUND)).outcome, 'await-operator');
  assert.equal(f.pages(), 1);
});
for (const requested_at of [null, 'invalid', new Date(START + 2 * BOUND).toISOString()]) {
  test(`missing or future request time cannot charge a launch: ${requested_at}`, async t => {
    const f = fixture(t);
    f.shared.snapshot.observations.launches.value.closer.probe.row.requested_at = requested_at;
    assert.equal((await f.run(START + BOUND)).outcome, 'ama-pending');
    assert.equal(f.pages(), 0);
  });
}

test('the normal ledger consumer projection reaches the bounded handoff', async t => {
  const f = fixture(t);
  f.shared.snapshot.observations.launches = launchSource({ state: 'complete', value: {
    launchRequestId: f.lease.lrqId, retryChain: [], launch: {
      launch_request_id: f.lease.lrqId, status: 'running', requested_at: new Date(START).toISOString(),
    },
  } }, f.lease, {});
  assert.equal((await f.run(START + BOUND)).outcome, 'await-operator');
  assert.equal(f.pages(), 1);
});
