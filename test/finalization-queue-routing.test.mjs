import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFinalizationQueueStore } from '../src/finalization/queue-store.mjs';
import { createQueueOwner, resolveQueueOwnerAdapter } from '../src/finalization/queue-owner.mjs';
import { createLaneRoutingController, resolveLaneRoute } from '../src/finalization/queue-routing.mjs';
import { routeFinalizationWriter } from '../src/finalization/queue-routing-boundary.mjs';
import { runLegacyLaneWrite } from '../src/finalization/legacy-lane-write.mjs';
import { queueWaitMs } from '../src/finalization/queue-wait.mjs';

const lane = { repository: 'example/review', base: 'main' };
const queue = { laneRoutes: [{ ...lane, executor: 'queue-v2' }] };
const at = '2026-10-25T00:00:00.000Z';
const drained = { read: async () => ({ quiescent: true, sourceRef: 'inventory:1', results: {} }) };
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'route-'));
  const store = openFinalizationQueueStore({ rootDir });
  const routing = createLaneRoutingController({ store, now: () => at, runtime: { build: 'fixture-build', pid: 42 } });
  t.after(() => { store.close(); rmSync(rootDir, { recursive: true, force: true }); });
  return { rootDir, store, routing };
}
const transfer = (f, cfg, extra = {}) => f.routing.transfer({ cfg, lane, expectedGeneration: f.store.readOwner(lane)?.route_generation ?? 0, drainAdapter: drained, ...extra });
const run = (f, cfg, extra = {}) => f.routing.run({ cfg, lane, kind: 'daemon', legacy: async () => 'legacy', queue: async () => 'queue-v2', ...extra });

test('selector has legacy defaults, per-lane isolation, canonical identity and independent brake', () => {
  assert.equal(resolveLaneRoute({}, lane).executor, 'legacy');
  assert.equal(resolveLaneRoute(queue, lane).executor, 'queue-v2');
  assert.equal(resolveLaneRoute(queue, { ...lane, base: 'Main' }).executor, 'legacy');
  assert.equal(resolveLaneRoute({ ...queue, autonomousMergeExecutionEnabled: false }, lane).executor, 'queue-v2');
});

test('both routes refuse mutations under existing brake and unavailable composition stays visible', async t => {
  const f = fixture(t);
  assert.equal(await run(f, {}), 'legacy');
  assert.equal((await run(f, { autonomousMergeExecutionEnabled: false })).reason, 'autonomous-merge-execution-disabled');
  assert.equal((await run(f, { autonomousMergeExecutionEnabled: true, autonomous_merge_execution_enabled: false }, {
    legacy: () => assert.fail('raw brake must refuse legacy execution'),
  })).reason, 'autonomous-merge-execution-disabled');
  assert.equal((await run(f, queue)).reason, 'lane-transfer-required');
  assert.equal((await transfer(f, queue)).ok, true);
  assert.equal(await run(f, queue), 'queue-v2');
  assert.equal((await run(f, { ...queue, autonomousMergeExecutionEnabled: false })).reason, 'autonomous-merge-execution-disabled');
  assert.equal((await run(f, { ...queue, autonomous_merge_execution_enabled: false }, {
    queue: () => assert.fail('raw brake must refuse queue admission'),
  })).reason, 'autonomous-merge-execution-disabled');
  assert.equal((await run(f, queue, { queue: undefined })).reason, 'queue-composition-unavailable');
  assert.equal((await run(f, {})).reason, 'lane-transfer-required');
});

test('30 repetitions reproduce unfixed and optimistic paused writers, then 30 consecutive fenced transfers', async t => {
  let unfixed = 0, generationOnly = 0, fixed = 0;
  const baseline = fixture(t);
  const fixedAssertFence = baseline.store.assertFence;
  // Archived MGQ-07 queue-store assertFence implementation (810b5870):
  // actual owner.issue/intent/flock machinery below uses this unfixed predicate.
  const unfixedAssertFence = (fence, now) => {
    const row = baseline.store.readOwner(fence.lane);
    if (!row || row.owner_state !== 'active' || row.owner_id !== fence.ownerId
      || row.generation !== fence.generation || row.route_generation !== fence.routeGeneration
      || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.parse(now)) throw new Error('stale queue owner fence');
    return row;
  };
  baseline.store.assertFence = unfixedAssertFence;
  const owner = createQueueOwner({ store: baseline.store, now: () => at });
  for (let i = 0; i < 30; i++) {
    const key = { ...lane, base: `baseline-${i}` }, entryId = `q-baseline-${i}`;
    baseline.store.tx(() => {
      baseline.store.ensureLane(key);
      baseline.store.db.prepare("INSERT INTO finalization_queue_route VALUES (?,?,'queue-v2','fixture',NULL,NULL,?)").run(key.repository, key.base, at);
    });
    const { fence } = await owner.claim({ lane: key, ownerId: 'old-queue', expiresAt: '2026-10-25T00:01:00Z' });
    baseline.store.acknowledge({ lane: key, entryId, prNumber: 101, head: 'old', admissionGeneration: 1,
      handoffId: `baseline-h-${i}`, ackId: `baseline-a-${i}`, at });
    for (const phase of ['ready', 'rebasing', 'publishing']) baseline.store.progress({ fence, entryId, phase, at,
      patch: phase === 'publishing' ? { candidate: 'candidate', exactBase: 'base', proof: { sourceRef: 'proof' } } : {} });
    // Legacy now owns the lane; the old fence still passes because the old
    // predicate never reads execution routing. Invoke only the fake remote.
    baseline.store.db.prepare("UPDATE finalization_queue_route SET executor='legacy' WHERE repository=? AND base=?").run(key.repository, key.base);
    await owner.issue({ fence, entryId, operationId: `baseline-push-${i}`, kind: 'push', invoke: async () => {
      unfixed++; return { outcome: 'succeeded', sourceRef: 'fake:push' };
    } });
    // Intermediate optimistic route check before an await still races a flip.
    baseline.store.db.prepare("UPDATE finalization_queue_route SET executor='queue-v2' WHERE repository=? AND base=?").run(key.repository, key.base);
    const checked = baseline.routing.read(key).route.executor === 'queue-v2';
    const optimistic = (async () => { await Promise.resolve(); if (checked) await owner.issue({ fence, entryId,
      operationId: `optimistic-push-${i}`, kind: 'push', invoke: async () => { generationOnly++; return { outcome: 'succeeded', sourceRef: 'fake:push' }; } }); })();
    baseline.store.db.prepare("UPDATE finalization_queue_route SET executor='legacy' WHERE repository=? AND base=?").run(key.repository, key.base);
    await optimistic;
    baseline.store.assertFence = fixedAssertFence;
    await assert.rejects(owner.issue({ fence, entryId, operationId: `fixed-push-${i}`, kind: 'push', invoke: () => assert.fail('mixed ownership') }), /route/);
    // Restore the archived predicate only for the next unfixed fixture trial.
    baseline.store.assertFence = unfixedAssertFence;
  }
  const f = fixture(t);
  for (let i = 0; i < 30; i++) {
    const key = { ...lane, base: `trial-${i}` }, cfg = { laneRoutes: [{ ...key, executor: 'queue-v2' }] };
    let enter, release;
    const entered = new Promise(r => { enter = r; }), done = new Promise(r => { release = r; });
    const old = f.routing.run({ cfg: {}, lane: key, kind: 'daemon', legacy: async () => { enter(); await done; return 'drained'; } });
    await entered;
    const attempted = await f.routing.transfer({ cfg, lane: key, expectedGeneration: 0, drainAdapter: drained });
    assert.equal(attempted.reason, 'owner-operation-in-flight');
    release(); await old;
    assert.equal((await f.routing.transfer({ cfg, lane: key, expectedGeneration: 0, drainAdapter: drained })).ok, true);
    assert.equal((await f.routing.run({ cfg: {}, lane: key, kind: 'closer', legacy: () => assert.fail('stale legacy write') })).reason, 'lane-transfer-required');
    fixed++;
  }
  assert.equal(unfixed, 30); assert.equal(generationOnly, 30); assert.equal(fixed, 30);
  t.diagnostic(`unfixed 30/30 mixed ownership; optimistic pre-await check 30/30; fixed ${fixed}/30 consecutive exclusive outcomes`);
});

test('ambiguous legacy intent parks transfer, then authoritative drain allows it', async t => {
  const f = fixture(t);
  await assert.rejects(run(f, {}, { legacy: async () => { throw new Error('lost reply'); } }));
  const id = f.routing.read(lane).legacyWriters[0].writer_id;
  assert.equal((await transfer(f, queue)).reason, 'route-drain-unproven');
  assert.equal((await run(f, {})).reason, 'lane-transfer-required');
  assert.equal((await transfer(f, queue, { drainAdapter: { read: async () => ({ quiescent: true, sourceRef: 'drain:1', results: {
    [id]: { outcome: 'not-applied', sourceRef: 'live:open' },
  } }) } })).ok, true);
});

test('rollback fences old owner immediately and durably returns pending and parked entries once', async t => {
  const f = fixture(t); await transfer(f, queue);
  const owner = createQueueOwner({ store: f.store, now: () => at });
  const { fence } = await owner.claim({ lane, ownerId: 'queue:1', routeGeneration: 1, expiresAt: '2026-10-25T00:01:00Z' });
  for (const pr of [101, 102]) f.store.acknowledge({ lane, entryId: `q-${pr}`, prNumber: pr, head: 'a'.repeat(40),
    admissionGeneration: 1, handoffId: `h-${pr}`, ackId: `a-${pr}`, at });
  f.store.progress({ fence, entryId: 'q-102', phase: 'parked-hold', patch: { reason: 'operator-hold' }, at });
  assert.equal((await transfer(f, {}, { drainAdapter: null })).reason, 'route-drain-unproven');
  await assert.rejects(owner.issue({ fence, entryId: 'q-101', operationId: 'old', kind: 'merge', invoke: () => assert.fail() }), /route|fence/);
  const seen = new Set(); let lost = true;
  const returnAdapter = { read: async r => {
    seen.add(r.deliveryKey);
    if (lost) { lost = false; throw new Error('ack lost'); }
    return { acknowledged: true, deliveryKey: r.deliveryKey, sourceRef: 'legacy:durable' };
  } };
  assert.equal((await transfer(f, {}, { returnAdapter })).reason, 'legacy-return-unacknowledged');
  assert.equal(f.routing.read(lane).pendingReturns.length, 2);
  const reopened = openFinalizationQueueStore({ rootDir: f.rootDir });
  try {
    const resumed = { store: reopened, routing: createLaneRoutingController({ store: reopened, now: () => at }) };
    assert.equal((await transfer(resumed, {}, { returnAdapter })).ok, true);
  } finally { reopened.close(); }
  assert.equal(seen.size, 2);
  assert.equal(f.store.entries(lane).every(e => e.phase === 'returned-to-closer'), true);
  assert.equal((await owner.claim({ lane, ownerId: 'old', routeGeneration: 2, expiresAt: '2026-10-25T00:01:00Z' })).reason, 'queue-route-not-owned');
  assert.equal(await run(f, {}), 'legacy');
  assert.equal((await transfer(f, {})).replay, true);
  const { foldQueue } = await import('../src/finalization/ledger-fold.mjs');
  const folded = foldQueue(f.store.readEvents(lane));
  for (const entry of f.store.entries(lane)) assert.deepEqual(folded.entries[entry.entryId], entry);
});

test('real daemon/closer boundary selects same durable route, and shell command obeys it', async t => {
  const f = fixture(t); await transfer(f, queue);
  for (const kind of ['daemon', 'closer']) {
    const result = await routeFinalizationWriter({ rootDir: f.rootDir, cfg: {}, lane, kind, legacy: () => assert.fail('legacy fallback') });
    assert.equal(result.reason, 'lane-transfer-required');
  }
  let invoked = 0;
  assert.equal((await runLegacyLaneWrite({ rootDir: f.rootDir, ...lane, command: 'fake', argv: [], readConfig: () => queue,
    exec: () => { invoked++; } })).reason, 'queue-composition-unavailable');
  assert.equal(invoked, 0);
});

test('new waits scale nominal input once, clip remaining deadline, cap high load and timer overflow', async t => {
  const f = fixture(t), high = { enabled: true, maxMultiplier: 20, loadAvg1m: 1000, cpuCount: 1, cpuBusyPercent: 100 };
  let observed;
  const drainAdapter = { read: async r => { observed = r.timeoutMs; return { quiescent: true, sourceRef: 'drain', results: {} }; } };
  await transfer(f, queue, { load: high, deadline: '2026-10-25T00:00:02Z', drainAdapter });
  assert.equal(observed, 2000);
  await runLegacyLaneWrite({ rootDir: f.rootDir, ...lane, command: 'fake', argv: [], readConfig: () => ({}), now: at,
    deadline: '2026-10-25T00:00:03Z', load: high, exec: (_c, _a, o) => { observed = o.timeout; } });
  // The transferred queue lane refuses legacy before issuing its command.
  assert.equal(observed, 2000);
  const other = { ...lane, base: 'other' };
  await runLegacyLaneWrite({ rootDir: f.rootDir, ...other, command: 'fake', argv: [], readConfig: () => ({}), now: at,
    deadline: '2026-10-25T00:00:03Z', load: high, exec: async (_c, _a, o) => { observed = o.timeout; return {}; } });
  assert.equal(observed, 3000);
  assert.equal(queueWaitMs(30_000, { ceilingMs: 60_000, load: high }), 60_000);
  assert.ok(queueWaitMs(Number.MAX_VALUE, { ceilingMs: Number.MAX_VALUE, load: high }) <= 2 ** 31 - 1);
  await assert.rejects(runLegacyLaneWrite({ rootDir: f.rootDir, ...other, readConfig: () => ({}), now: at, deadline: at }), /deadline/);
});

test('subject executor lane port requires a real lane and validates admission acknowledgement; wait clips once', async t => {
  const { createFinalizationLaneRouting } = await import('../src/finalization/queue-routing-boundary.mjs');
  const f = fixture(t); await transfer(f, queue);
  let budget;
  const high = { enabled: true, maxMultiplier: 20, loadAvg1m: 1000, cpuCount: 1, cpuBusyPercent: 100 };
  const revisionRef = 'a'.repeat(40), subject = { domainId: 'code-pr', subjectExternalId: 'example/review#101' };
  const port = createFinalizationLaneRouting({ rootDir: f.rootDir, readConfig: () => queue, now: () => at, load: high,
    readLane: async request => { budget = request.timeoutMs; return lane; },
    admitQueue: async () => ({ entryId: 'q-101', ackId: 'ack-101', lane, head: revisionRef, prNumber: 101 }) });
  const result = await port.run({ subject, revisionRef, legacy: () => assert.fail('legacy fallback'), deadline: '2026-10-25T00:00:02Z' });
  assert.equal(budget, 2000); assert.equal(result.queued, true);
  assert.equal((await port.run({ subject: { ...subject, subjectExternalId: 'Example/Review#101' }, revisionRef,
    legacy: () => assert.fail('legacy fallback') })).queued, true);
  for (const subjectExternalId of ['other/review#101', 'example/review#102', undefined]) {
    await assert.rejects(port.run({ subject: { ...subject, subjectExternalId }, revisionRef,
      legacy: () => assert.fail('legacy fallback') }), /acknowledgement/);
  }
  const bad = createFinalizationLaneRouting({ rootDir: f.rootDir, readConfig: () => queue, readLane: async () => lane, admitQueue: async () => null });
  await assert.rejects(bad.run({ subject, revisionRef, legacy: () => assert.fail() }), /acknowledgement/);
  const missingLane = createFinalizationLaneRouting({ rootDir: f.rootDir, readConfig: () => ({}), readLane: async () => null });
  await assert.rejects(missingLane.run({ subject, revisionRef, legacy: () => assert.fail() }));
  await assert.rejects(port.run({ subject, revisionRef, deadline: at, legacy: () => assert.fail() }), /deadline/);
});

test('legacy shell wrapper preserves command, arguments, output and exit code while refusing queue ownership', async () => {
  const { legacyLaneWriteMain } = await import('../bin/legacy-lane-write.mjs');
  let out = '', err = '', request;
  const streams = { stdout: { write: s => { out += s; } }, stderr: { write: s => { err += s; } } };
  const args = ['--root', '/fixture', '--repo', lane.repository, '--base', lane.base, '--', 'fake-node', 'metered-gh.mjs', 'exec-hammer', 'pr', 'merge', 'https://example.invalid/example/review/pull/101', '--match-head-commit', 'a'.repeat(40)];
  assert.equal(await legacyLaneWriteMain(args, { ...streams, run: async r => { request = r; return { stdout: 'merged', stderr: 'notice' }; } }), 0);
  assert.equal(request.command, 'fake-node'); assert.equal(request.subject.head, 'a'.repeat(40));
  assert.equal(out, 'merged'); assert.equal(err, 'notice');
  assert.equal(await legacyLaneWriteMain(args, { ...streams, run: async () => { throw Object.assign(new Error('failed'), { code: 17, stdout: 'out', stderr: 'temporary failure' }); } }), 17);
  assert.equal(out, 'mergedout'); assert.equal(err, 'noticetemporary failure');
  err = '';
  assert.equal(await legacyLaneWriteMain(args, { ...streams, run: async () => { throw new Error('legacy writer deadline expired'); } }), 75);
  assert.equal(err, 'legacy writer deadline expired\n');
  err = '';
  assert.equal(await legacyLaneWriteMain(args, { ...streams, run: async () => { throw new Error(); } }), 75);
  assert.equal(err, 'legacy lane write failed; reconciliation may be required\n');
  assert.equal(await legacyLaneWriteMain(args, { ...streams, run: async () => ({ ok: false, reason: 'lane-transfer-required' }) }), 75);
  err = '';
  assert.equal(await legacyLaneWriteMain(args, { ...streams, run: async () => ({ ok: false,
    reason: 'owner-operation-in-flight', outcome: 'lane-busy', waitedMs: 1234 }) }), 75);
  assert.equal(err, 'legacy lane write refused: owner-operation-in-flight; lane-busy; waited 1234ms\n');
  err = '';
  assert.equal(await legacyLaneWriteMain(args, { ...streams, run: async () => ({ ok: false,
    reason: 'owner-operation-in-flight' }) }), 75);
  assert.equal(err, 'legacy lane write refused: owner-operation-in-flight\n');
  assert.equal(await legacyLaneWriteMain(['--deadline-ms', 'invalid', ...args], streams), 64);
  await legacyLaneWriteMain(['--deadline-ms', '1792886400000', ...args], {
    ...streams, run: async r => { assert.equal(r.deadline, at); return {}; },
  });
});

test('HAMLANEWAIT-01: legacy merge wakes on another operation release within its original deadline', { timeout: 5000 }, async t => {
  const f = fixture(t);
  const adapter = resolveQueueOwnerAdapter(f.store);
  let release = adapter.tryLock(lane);
  t.after(() => release?.());
  let called = false;
  const started = performance.now();
  const pending = runLegacyLaneWrite({ rootDir: f.rootDir, ...lane, command: 'synthetic-merge', argv: [],
    deadline: new Date(Date.now() + 3000).toISOString(), readConfig: () => ({}),
    exec: async (_c, _a, { timeout }) => { called = true; assert.ok(timeout > 0 && timeout < 3000); return { stdout: 'merged' }; } });
  const timer = setTimeout(() => { release(); release = null; }, 50);
  t.after(() => clearTimeout(timer));
  assert.equal(called, false);
  assert.equal((await pending).stdout, 'merged');
  assert.equal(called, true);
  assert.ok(performance.now() - started < 2500, 'release wake must precede deadline');
});

test('HAMLANEWAIT-01: deadline exhaustion is lane-busy with no merge or durable writer intent', { timeout: 5000 }, async t => {
  const f = fixture(t), adapter = resolveQueueOwnerAdapter(f.store);
  const release = adapter.tryLock(lane);
  try {
    const result = await runLegacyLaneWrite({ rootDir: f.rootDir, ...lane,
      deadline: new Date(Date.now() + 80).toISOString(), readConfig: () => ({}),
      exec: () => assert.fail('busy lane cannot issue a merge') });
    assert.equal(result.reason, 'owner-operation-in-flight');
    assert.equal(result.outcome, 'lane-busy');
    assert.ok(result.waitedMs >= 60 && result.waitedMs < 2000);
    assert.deepEqual(f.routing.read(lane).legacyWriters, []);
  } finally { release(); }
  assert.equal((await runLegacyLaneWrite({ rootDir: f.rootDir, ...lane, readConfig: () => ({}),
    exec: async () => ({ stdout: 'next-pass-merged' }) })).stdout, 'next-pass-merged');
});

test('HAMLANEWAIT-01: waking rechecks lane transfer and never invokes the old legacy route', { timeout: 5000 }, async t => {
  const f = fixture(t), adapter = resolveQueueOwnerAdapter(f.store);
  assert.equal((await transfer(f, queue)).ok, true);
  const release = adapter.tryLock(lane);
  const pending = runLegacyLaneWrite({ rootDir: f.rootDir, ...lane, readConfig: () => ({}),
    deadline: new Date(Date.now() + 3000).toISOString(), exec: () => assert.fail('stale route must refuse') });
  release();
  const result = await pending;
  assert.equal(result.reason, 'lane-transfer-required');
  assert.equal(result.outcome, undefined);
});

test('HAMLANEWAIT-01: configured queue-v2 route retains immediate contention refusal', async t => {
  const f = fixture(t), adapter = resolveQueueOwnerAdapter(f.store);
  const release = adapter.tryLock(lane);
  try {
    const result = await runLegacyLaneWrite({ rootDir: f.rootDir, ...lane, readConfig: () => queue,
      deadline: new Date(Date.now() + 3000).toISOString(), exec: () => assert.fail('queue cannot run legacy') });
    assert.equal(result.reason, 'owner-operation-in-flight');
    assert.equal(result.outcome, undefined);
    assert.equal(result.waitedMs, undefined);
  } finally { release(); }
});

test('unconfigured lane is legacy even for a raw queue claimant', async t => {
  const f = fixture(t), owner = createQueueOwner({ store: f.store, now: () => at });
  assert.equal((await owner.claim({ lane, ownerId: 'unrouted', expiresAt: '2026-10-25T00:01:00Z' })).reason, 'queue-route-not-owned');
  assert.equal(f.routing.read(lane).route, null);
});

test('transfer never settles an ambiguous successful push before materialized publication evidence', async t => {
  const f = fixture(t); await transfer(f, queue);
  const owner = createQueueOwner({ store: f.store, now: () => at });
  const { fence } = await owner.claim({ lane, ownerId: 'queue:old', routeGeneration: 1, expiresAt: '2026-10-25T00:01:00Z' });
  f.store.acknowledge({ lane, entryId: 'ambiguous', prNumber: 101, head: 'old', admissionGeneration: 1, handoffId: 'h-1', ackId: 'a-1', at });
  for (const phase of ['ready', 'rebasing', 'publishing']) f.store.progress({ fence, entryId: 'ambiguous', phase, at,
    patch: phase === 'publishing' ? { candidate: 'candidate', exactBase: 'base', proof: { sourceRef: 'proof' } } : {} });
  let issued = 0;
  await assert.rejects(owner.issue({ fence, entryId: 'ambiguous', operationId: 'lost-push', kind: 'push', invoke: async () => { issued++; throw new Error('reply lost'); } }));
  const drainAdapter = { read: async () => ({ quiescent: true, sourceRef: 'drain', results: {
    'lost-push': { outcome: 'succeeded', sourceRef: 'live:candidate' },
  } }) };
  assert.equal((await transfer(f, {}, { drainAdapter })).reason, 'operation-receipt-reconciliation-required');
  assert.equal(f.store.operations(lane).length, 1);
  const returnAdapter = { read: async r => ({ acknowledged: true, deliveryKey: r.deliveryKey, sourceRef: 'legacy:ack' }) };
  assert.equal((await transfer(f, {}, { returnAdapter, drainAdapter: { read: async () => {
    const entry = f.store.readEntry('ambiguous');
    entry.rebase = { publication: { head: 'candidate', base: 'base', sourceRef: 'live:publication' } };
    f.store.tx(() => {
      f.store.db.prepare('UPDATE finalization_queue_entry SET payload_json=? WHERE entry_id=?').run(JSON.stringify(entry), entry.entryId);
      f.store.append('progress', lane, { at, entryId: entry.entryId, patch: { rebase: entry.rebase } });
    });
    return drainAdapter.read();
  } } })).ok, true);
  assert.equal(issued, 1); assert.equal(f.store.operations(lane).length, 0);
  assert.equal(f.store.readEntry('ambiguous').phase, 'returned-to-closer');
});

test('shell patience is clipped at execution after config/store work, with no second scaling', async t => {
  const f = fixture(t); let clock = at, timeout;
  await runLegacyLaneWrite({ rootDir: f.rootDir, ...lane, command: 'fake', argv: [], now: () => clock,
    deadline: '2026-10-25T00:00:10Z', readConfig: () => { clock = '2026-10-25T00:00:09Z'; return {}; },
    exec: async (_c, _a, options) => { timeout = options.timeout; return {}; } });
  assert.equal(timeout, 1000);
});
