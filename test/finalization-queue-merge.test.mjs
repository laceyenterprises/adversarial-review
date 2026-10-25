import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { createQueueMergeService, observeQueueMergeOperation, reconcileQueueMergeObservation, queueMergeSubject } from '../src/finalization/queue-merge.mjs';
import { createQueueClosureAuditDelivery, createQueueMergeActionDelivery } from '../src/finalization/queue-delivery.mjs';
import { createQueueChecksService } from '../src/finalization/queue-checks.mjs';
import { createQueueRebaseService } from '../src/finalization/queue-rebase.mjs';
import { createQueueOwner } from '../src/finalization/queue-owner.mjs';
import { resolveQueueRequiredSet } from '../src/finalization/queue-check-reader.mjs';
import { openFinalizationLedgerStore } from '../src/finalization/ledger-store.mjs';
import { halted } from '../src/finalization/ledger-events.mjs';
import { foldQueue } from '../src/finalization/ledger-fold.mjs';
import { probeQueueOwner } from '../src/finalization/queue-probe.mjs';
import { readAmaAuditEntry } from '../src/ama/audit.mjs';
import { gitFixture, admitted, idle } from './helpers/queue-rebase-fixture.mjs';
import { handoffTime } from './helpers/queue-handoff-fixture.mjs';

const high = { enabled: true, loadAvg1m: 1000, cpuCount: 1, cpuBusyPercent: 100 };
const BOT = 'queue-app[bot]';
const requiredSet = resolveQueueRequiredSet({ cfg: { requiredCheckContexts: ['unit'] }, rules: { complete: true, contexts: [], sourceRef: 'rules:fixture', version: '1' } });
const green = entry => ({ head: entry.candidate, base: entry.exactBase, requiredSet, complete: true, observedAt: handoffTime(0),
  results: [{ name: 'unit', head: entry.candidate, conclusion: 'SUCCESS', url: 'https://example.invalid/check/1' }] });
const mergeSha = 'd'.repeat(40);
const count = (f, table) => f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

// Drive one synthetic admission to an exact green `finalizing` candidate.
async function finalizing(t, { noop = false, remediated = false } = {}) {
  const f = gitFixture(t, { noop }), a = await admitted(f, { remediated });
  const world = { merged: false, mergedBy: BOT, mergeSha, mergedHead: null };
  const live = { read: async () => {
    const s = a.live.subject;
    s.head = world.mergedHead ?? f.g(['--git-dir', f.remote, 'rev-parse', 'topic']);
    a.live.eligibility.primaryChange.headSha = s.head;
    const copy = structuredClone(a.live);
    if (world.merged) Object.assign(copy.subject, { state: 'merged', mergeCommitSha: world.mergeSha, mergedAt: f.now(), mergedBy: world.mergedBy });
    return copy;
  } };
  const base = { store: f.store, owner: a.owner, now: f.now, load: idle, liveAdapter: live, gitAdapter: f.adapter };
  await createQueueRebaseService(base).run({ fence: a.fence, entryId: a.ack.entryId });
  const checkReader = { read: async ({ entry }) => green(entry) };
  const entry = await createQueueChecksService({ ...base, checkReader }).poll({ fence: a.fence, entryId: a.ack.entryId });
  assert.equal(entry.phase, 'finalizing');
  const hqRoot = join(f.root, 'hq');
  mkdirSync(join(hqRoot, '.hq'), { recursive: true, mode: 0o750 });
  writeFileSync(join(hqRoot, '.hq', 'config.json'), JSON.stringify({ ownerUser: userInfo().username }));
  const calls = [];
  const mergeSurface = { name: 'fake-squash', merge: async request => {
    calls.push(request); world.merged = true; world.mergedHead = request.revisionRef;
    return { ok: true, payload: { merged: true, sha: world.mergeSha } };
  } };
  const pages = [];
  const options = { ...base, checkReader, mergeSurface,
    identitySurface: { check: async () => ({ ok: true, login: BOT, producerClass: 'closer-hammer', sourceRef: 'identity:merge' }) },
    pageAdapter: { read: async ({ payload }) => { pages.push(payload); return { id: payload.causeKey, status: 'queued' }; } },
    deliveryAdapters: { 'merge-action-receipt': createQueueMergeActionDelivery({ hqRoot }), 'closure-audit': createQueueClosureAuditDelivery({ hqRoot }) } };
  const p = { f, a, world, live, calls, pages, hqRoot, options, entry,
    service: (overrides = {}) => createQueueMergeService({ ...p.options, ...overrides }),
    finalize: (overrides = {}, fence = a.fence) => p.service(overrides).finalize({ fence, entryId: a.ack.entryId }) };
  return p;
}
const mergeActions = p => {
  const dir = join(p.hqRoot, 'dispatch', 'audit', 'automation-merge-actions');
  try { return readdirSync(dir).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(join(dir, n), 'utf8'))); }
  catch { return []; }
};

test('final eligibility merges the exact candidate once and journals a complete attributed receipt', async t => {
  const p = await finalizing(t); const { f, a } = p;
  const before = f.store.readEntry(a.ack.entryId);
  const result = await p.finalize();
  assert.equal(result.phase, 'merged'); assert.equal(p.calls.length, 1);
  assert.deepEqual(result.patience, before.patience);
  assert.equal(p.calls[0].revisionRef, before.candidate); assert.equal(p.calls[0].mergeMethod, 'squash');
  assert.ok(p.calls[0].timeoutMs > 0 && p.calls[0].timeoutMs <= 60_000);
  const row = f.store.db.prepare('SELECT * FROM finalization_queue_merge_receipt').get();
  const receipt = JSON.parse(row.receipt_json);
  assert.equal(receipt.oldHead, f.oldHead); assert.equal(receipt.newHead, before.candidate); assert.equal(receipt.base, before.exactBase);
  assert.notEqual(receipt.oldHead, receipt.newHead);
  assert.equal(receipt.rebase.proof.digest, before.proof.digest); assert.equal(receipt.rebase.sourceReceiptDigest, before.rebase.sourceReceiptDigest);
  assert.deepEqual(receipt.checks.results.map(r => r.url), ['https://example.invalid/check/1']);
  assert.equal(receipt.decision.kind, 'eligible'); assert.equal(receipt.decision.holds, 'none');
  assert.equal(receipt.decision.executionOwnership, 'lane-fence-replaces-merge-lease');
  assert.equal(receipt.merge.mergeSha, mergeSha); assert.equal(receipt.attribution.bot.login, BOT);
  assert.equal(receipt.attribution.worker.workerId, 'builder-1');
  assert.equal(receipt.attribution.closer, null);
  assert.equal(receipt.decision.attribution.closer, null);
  assert.equal(count(f, 'finalization_queue_delivery'), 2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM finalization_queue_delivery WHERE receipt_json IS NULL').get().n, 0);
  const actions = mergeActions(p);
  assert.equal(actions.length, 1); assert.equal(actions[0].producerClass, 'closer-hammer'); assert.equal(actions[0].headSha, before.candidate);
  const audit = readAmaAuditEntry(p.hqRoot, 'example/review', 102, before.candidate);
  assert.equal(audit.status, 'succeeded'); assert.equal(audit.attempts.length, 1); assert.equal(audit.attempts[0].mergeCommitSha, mergeSha);
  const ledger = openFinalizationLedgerStore({ db: f.store.db }).read(queueMergeSubject(before));
  assert.deepEqual(ledger.map(e => [e.type, e.revisionRef]), [['finalized', before.candidate]]);
  assert.equal(f.store.readOwner(before.lane).owner_state, 'idle');
  assert.deepEqual(foldQueue(f.store.readEvents(a.h.lane)).entries[before.entryId], result);
});

test('remediated admission preserves the admitted closer in the decision and immutable receipt', async t => {
  const p = await finalizing(t, { remediated: true });
  const result = await p.finalize();
  assert.equal(result.phase, 'merged');
  const receipt = JSON.parse(p.f.store.db.prepare('SELECT receipt_json FROM finalization_queue_merge_receipt').get().receipt_json);
  assert.equal(receipt.admissionKind, 'remediated');
  assert.deepEqual(result.decision.attribution.closer, p.a.h.closer);
  assert.deepEqual(receipt.decision.attribution.closer, p.a.h.closer);
  assert.deepEqual(receipt.attribution.closer, p.a.h.closer);
});

test('post-merge delivery waits through a transient SQLite writer using the configured busy timeout', async t => {
  const p = await finalizing(t);
  const { f } = p;
  f.store.db.pragma('busy_timeout = 2000');
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require('better-sqlite3');
    const db = new Database(workerData);
    parentPort.once('message', () => {
      db.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('locked');
      setTimeout(() => { db.exec('COMMIT'); db.close(); parentPort.close(); }, 200);
    });
    parentPort.postMessage('ready');
  `, { eval: true, workerData: join(f.root, 'data/reviews.db') });
  t.after(() => worker.terminate());
  assert.deepEqual(await once(worker, 'message'), ['ready']);
  const exited = once(worker, 'exit');
  const adapter = p.options.deliveryAdapters['merge-action-receipt'];
  p.options.deliveryAdapters['merge-action-receipt'] = { read: async request => {
    const locked = once(worker, 'message');
    worker.postMessage('lock');
    assert.deepEqual(await locked, ['locked']);
    return adapter.read(request);
  } };
  const result = await p.finalize();
  assert.equal(result.phase, 'merged');
  assert.equal(f.store.readOwner(result.lane).owner_state, 'idle');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM finalization_queue_delivery WHERE receipt_json IS NULL').get().n, 0);
  assert.equal(f.store.db.pragma('busy_timeout', { simple: true }), 2000);
  assert.equal(p.calls.length, 1);
  assert.equal(mergeActions(p).length, 1);
  assert.deepEqual(await exited, [0]);
});

for (const [name, mutate, phase, reason] of [
  ['head change', p => { p.world.mergedHead = 'e'.repeat(40); }, 'returned-to-closer', 'external-head-change'],
  ['live hold', p => { p.a.live.subject.labels = ['no-merge-hold']; }, 'parked-hold', 'operator-hold'],
  ['unreadable labels', p => { p.a.live.subject.labels = null; }, 'parked-hold', 'labels-unavailable'],
  ['unavailable identity surface', p => { p.options.identitySurface = null; }, 'parked-infrastructure', 'merge-identity-unavailable'],
  ['denied identity', p => { p.options.identitySurface = { check: async () => ({ ok: false, reason: 'denied' }) }; }, 'parked-infrastructure', 'merge-identity-unavailable'],
  ['unattributed identity', p => { p.options.identitySurface = { check: async () => ({ ok: true, sourceRef: 'identity:1' }) }; }, 'parked-infrastructure', 'merge-identity-unavailable'],
  ['invalid proof', p => { p.options.gitAdapter = { ...p.f.adapter, verify: async () => ({ forged: true }) }; }, 'returned-to-closer', 'persisted-rebase-proof-unavailable'],
  ['emergency brake', p => { p.options.policy = { autonomousExecutionDisabled: true }; }, 'parked-hold', 'autonomous-execution-disabled'],
  ['unreadable brake policy', p => { p.options.policy = () => { throw new Error('policy unreadable'); }; }, 'parked-hold', 'autonomous-execution-disabled'],
  ['pending rerun', p => { p.options.checkReader = { read: async ({ entry }) => ({ ...green(entry), results: [{ name: 'unit', head: entry.candidate, status: 'in_progress' }] }) }; }, 'waiting-checks', 'checks-pending'],
  ['completed red', p => { p.options.checkReader = { read: async ({ entry }) => ({ ...green(entry), results: [{ name: 'unit', head: entry.candidate, conclusion: 'FAILURE' }] }) }; }, 'returned-to-closer', 'checks-completed-red'],
  ['subject ledger halt', p => { openFinalizationLedgerStore({ db: p.f.store.db }).append(halted(queueMergeSubject(p.entry), { at: p.f.now(), reason: 'operator halt' })); }, 'parked-hold', 'subject-ledger-terminal'],
  ['primary change reverted', p => { p.a.live.eligibility.primaryChange = { headSha: null, reverted: true }; }, null, null],
]) test(`${name} blocks the merge before any mutation`, async t => {
  const p = await finalizing(t); const { f, a } = p;
  const before = f.store.readEntry(a.ack.entryId);
  mutate(p);
  const result = await p.finalize();
  if (phase) { assert.equal(result.phase, phase); assert.equal(result.reason, reason); }
  else assert.notEqual(result.phase, 'merged');
  assert.equal(p.calls.length, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM finalization_queue_operation WHERE kind='merge'").get().n, 0);
  assert.equal(count(f, 'finalization_queue_merge_receipt'), 0);
  assert.deepEqual(result.patience, before.patience); assert.equal(result.decision, null);
});

test('outside base write discards stale readiness, rebases and retests under the original deadline before merging', async t => {
  const p = await finalizing(t); const { f, a } = p;
  const first = f.store.readEntry(a.ack.entryId);
  f.g(['checkout', 'main']); f.file('other', 'outside\n'); const moved = f.commit('outside base write');
  f.g(['push', f.remote, 'main']);
  a.live.subject.baseSha = moved;
  f.clock(600);
  let entry = await p.finalize();
  assert.equal(entry.phase, 'rebasing'); assert.equal(entry.reason, 'external-base-change');
  assert.equal(entry.checks, null); assert.equal(entry.decision, null); assert.deepEqual(entry.patience, first.patience);
  assert.equal(p.calls.length, 0);
  const base = { store: f.store, owner: a.owner, now: f.now, load: idle, liveAdapter: p.live, gitAdapter: f.adapter };
  entry = await createQueueRebaseService(base).run({ fence: a.fence, entryId: entry.entryId });
  assert.equal(entry.phase, 'waiting-checks'); assert.equal(entry.exactBase, moved); assert.notEqual(entry.candidate, first.candidate);
  entry = await createQueueChecksService({ ...base, checkReader: p.options.checkReader }).poll({ fence: a.fence, entryId: entry.entryId });
  assert.equal(entry.phase, 'finalizing'); assert.deepEqual(entry.patience, first.patience);
  const merged = await p.finalize();
  assert.equal(merged.phase, 'merged'); assert.equal(p.calls.length, 1); assert.equal(p.calls[0].revisionRef, entry.candidate);
  assert.equal(JSON.parse(f.store.db.prepare('SELECT receipt_json FROM finalization_queue_merge_receipt').get().receipt_json).base, moved);
});

test('a hold, head push or brake observed under the issuance lock settles not-applied without calling merge', async t => {
  for (const change of ['hold', 'head', 'brake']) {
    const p = await finalizing(t); const { f, a } = p;
    let reads = 0, braked = false;
    p.options.policy = () => ({ autonomousExecutionDisabled: braked });
    p.options.liveAdapter = { read: async req => {
      const value = await p.live.read(req);
      if (++reads === 2) {
        if (change === 'hold') value.subject.labels = ['no-merge-hold'];
        if (change === 'head') value.subject.head = 'e'.repeat(40);
        if (change === 'brake') braked = true;
      }
      return value;
    } };
    const result = await p.finalize();
    assert.equal(p.calls.length, 0, change);
    assert.equal(result.phase, { hold: 'parked-hold', head: 'returned-to-closer', brake: 'parked-hold' }[change]);
    const op = f.store.db.prepare("SELECT result_json FROM finalization_queue_operation WHERE kind='merge'").get();
    assert.equal(JSON.parse(op.result_json).outcome, 'not-applied');
    assert.equal(f.store.readOwner(result.lane).owner_state, 'idle');
  }
});

test('stale owner and moved route generation cannot persist a decision or issue a merge', async t => {
  const p = await finalizing(t); const { f, a } = p;
  await assert.rejects(p.finalize({}, { ...a.fence, routeGeneration: a.fence.routeGeneration + 1 }), /stale queue owner fence/);
  f.clock(4001);
  await assert.rejects(p.finalize(), /stale queue owner fence/);
  assert.equal(p.calls.length, 0); assert.equal(f.store.readEntry(a.ack.entryId).decision, null);
});

test('server accepted the merge but the reply was lost: authoritative state reconciles one revision', async t => {
  const p = await finalizing(t);
  const merge = p.options.mergeSurface.merge;
  p.options.mergeSurface = { name: 'lossy', merge: async request => { await merge(request); throw new Error('socket hang up'); } };
  const result = await p.finalize();
  assert.equal(result.phase, 'merged'); assert.equal(p.calls.length, 1); assert.equal(result.merge.mergeSha, mergeSha);
});

test('a lost finalization write after settled merge survives restart without a second merge', async t => {
  const p = await finalizing(t); const { f, a } = p;
  const progress = f.store.progress;
  f.store.progress = args => { if (args.phase === 'merged') throw new Error('synthetic crash before receipt'); return progress(args); };
  await assert.rejects(p.finalize(), /synthetic crash/);
  f.store.progress = progress;
  assert.equal(f.store.readEntry(a.ack.entryId).phase, 'finalizing'); assert.equal(count(f, 'finalization_queue_merge_receipt'), 0);
  f.reopen(); a.owner = createQueueOwner({ store: f.store, now: f.now });
  const result = await p.finalize({ store: f.store, owner: a.owner });
  assert.equal(result.phase, 'merged'); assert.equal(p.calls.length, 1);
  assert.equal(count(f, 'finalization_queue_merge_receipt'), 1); assert.equal(mergeActions(p).length, 1);
});

test('an invisible ambiguous merge stays unresolved until drained takeover reconciles it once', async t => {
  const p = await finalizing(t); const { f, a } = p;
  p.options.mergeSurface = { name: 'timeout', merge: async request => { p.calls.push(request); throw new Error('timeout'); } };
  await assert.rejects(p.finalize(), /drain-reconciliation/);
  assert.equal(f.store.operations(a.h.lane).length, 1);
  assert.equal((await p.finalize()).phase, 'finalizing'); assert.equal(p.calls.length, 1);
  // The remote eventually shows our bot merged the candidate.
  p.world.merged = true; p.world.mergedHead = f.store.readEntry(a.ack.entryId).candidate;
  f.clock(4001);
  const owner = createQueueOwner({ store: f.store, now: f.now, recoveryAdapter: { stopDrainAndReconcile: async ({ operations }) => ({
    quiescent: true, sourceRef: 'drain:fixture', results: Object.fromEntries(await Promise.all(operations.map(async op =>
      [op.operation_id, await observeQueueMergeOperation({ store: f.store, liveAdapter: p.live, operation: op, load: idle })]))) }) } });
  const claim = await owner.claim({ lane: a.h.lane, ownerId: 'successor', expiresAt: handoffTime(8000) });
  assert.equal(claim.ok, true);
  const result = await p.finalize({ owner }, claim.fence);
  assert.equal(result.phase, 'merged'); assert.equal(p.calls.length, 1); assert.equal(count(f, 'finalization_queue_merge_receipt'), 1);
});

test('mismatched, unstructured or foreign already-merged replies are never success', async t => {
  for (const [variant, expected] of [['wrong-head', 'closed-observed'], ['no-sha', null], ['other-actor', 'closed-observed']]) {
    const p = await finalizing(t); const { f } = p;
    p.options.mergeSurface = { name: 'already', merge: async request => {
      p.calls.push(request); p.world.merged = true;
      if (variant === 'wrong-head') p.world.mergedHead = 'e'.repeat(40);
      else p.world.mergedHead = request.revisionRef;
      if (variant === 'no-sha') p.world.mergeSha = null;
      if (variant === 'other-actor') p.world.mergedBy = 'someone-else';
      return { ok: true, payload: { merged: true, idempotent: true, message: 'already merged' } };
    } };
    if (expected) {
      const result = await p.finalize();
      assert.equal(result.phase, expected, variant);
    } else await assert.rejects(p.finalize(), /drain-reconciliation/);
    assert.equal(count(f, 'finalization_queue_merge_receipt'), 0, variant); assert.equal(count(f, 'finalization_queue_delivery'), 0);
    assert.equal(mergeActions(p).length, 0);
  }
  const entry = { lane: { repository: 'example/review', base: 'main' }, prNumber: 1, candidate: 'a'.repeat(40) };
  const s = { lane: entry.lane, prNumber: 1, head: entry.candidate, state: 'merged', mergeCommitSha: mergeSha, mergedAt: handoffTime(0), mergedBy: BOT, sourceRef: 'live' };
  assert.equal(reconcileQueueMergeObservation(entry, { subject: s }, { bot: { login: BOT }, reportedSha: 'f'.repeat(40) }), null);
  assert.equal(reconcileQueueMergeObservation(entry, { subject: { ...s, state: 'open' } }, { bot: { login: BOT } }), null);
  assert.equal(reconcileQueueMergeObservation(entry, { subject: { ...s, state: 'open' } }, { bot: { login: BOT }, drained: true }).outcome, 'not-applied');
});

test('receipt delivery failure survives restart, stays visible pending and delivers once by stable key', async t => {
  const p = await finalizing(t); const { f, a } = p;
  const real = p.options.deliveryAdapters['merge-action-receipt'];
  p.options.deliveryAdapters = { ...p.options.deliveryAdapters, 'merge-action-receipt': { read: () => { throw new Error('accounting-store-unavailable'); } } };
  const result = await p.finalize();
  assert.equal(result.phase, 'merged'); assert.equal(f.store.readOwner(result.lane).owner_state, 'idle');
  const before = readFileSync(join(f.root, 'data/reviews.db'));
  const probe = probeQueueOwner({ rootDir: f.root, now: f.now(), load: idle });
  assert.deepEqual(readFileSync(join(f.root, 'data/reviews.db')), before);
  assert.equal(probe.capabilities.merge.available, true); assert.ok(probe.runtime.build);
  assert.equal(probe.observations.merge.pending, 1); assert.equal(probe.observations.merge.organicMergeObserved, true);
  assert.deepEqual(probe.observations.merge.pendingDeliveries.map(d => [d.kind, d.attempts, d.lastError]), [['merge-action-receipt', 1, 'accounting-store-unavailable']]);
  assert.equal(probe.observations.merge.recentReceipts[0].bot, BOT);
  assert.equal(probe.observations.merge.recentReceipts[0].recordedAt, result.merge.mergedAt);
  f.reopen(); a.owner = createQueueOwner({ store: f.store, now: f.now });
  // A crash after the external write but before its outbox receipt: replay.
  const row = f.store.db.prepare("SELECT payload_json FROM finalization_queue_delivery WHERE kind='merge-action-receipt'").get();
  real.read({ payload: JSON.parse(row.payload_json) });
  const service = p.service({ store: f.store, owner: a.owner, deliveryAdapters: { 'merge-action-receipt': real } });
  assert.deepEqual(await service.deliver(), { delivered: 1, pending: 0 });
  assert.deepEqual(await service.deliver(), { delivered: 0, pending: 0 });
  assert.equal(await p.service({ store: f.store, owner: a.owner }).finalize({ fence: a.fence, entryId: a.ack.entryId }).then(e => e.phase), 'merged');
  const actions = mergeActions(p);
  assert.equal(actions.length, 1); assert.equal(actions[0].producerClass, 'closer-hammer');
  assert.equal(readAmaAuditEntry(p.hqRoot, 'example/review', 102, result.candidate).attempts.length, 1);
  createQueueClosureAuditDelivery({ hqRoot: p.hqRoot }).read({ payload: JSON.parse(f.store.db.prepare("SELECT payload_json FROM finalization_queue_delivery WHERE kind='closure-audit'").get().payload_json) });
  assert.equal(readAmaAuditEntry(p.hqRoot, 'example/review', 102, result.candidate).attempts.length, 1);
  assert.equal(p.calls.length, 1);
});

test('one delivery key names one merge-action receipt; a conflicting record under that key refuses', async t => {
  const p = await finalizing(t);
  const adapter = createQueueMergeActionDelivery({ hqRoot: p.hqRoot });
  const payload = { repo: 'example/review', prNumber: 102, headSha: 'b'.repeat(40), merged: true, executedAt: handoffTime(0),
    producerClass: 'closer-hammer', action: 'gh pr merge', deliveryKey: 'delivery:merge-action-receipt:fixture' };
  adapter.read({ payload }); adapter.read({ payload });
  assert.equal(mergeActions(p).length, 1);
  assert.throws(() => adapter.read({ payload: { ...payload, producerClass: 'ama-daemon' } }), /Conflicting merge-action delivery key/);
  assert.equal(mergeActions(p).length, 1);
});

test('unconfigured delivery adapters keep stable keys pending after the lane advances', async t => {
  const p = await finalizing(t); const { f } = p;
  p.options.deliveryAdapters = {};
  const result = await p.finalize();
  assert.equal(result.phase, 'merged'); assert.equal(f.store.readOwner(result.lane).owner_state, 'idle');
  const rows = f.store.db.prepare('SELECT delivery_key,last_error FROM finalization_queue_delivery ORDER BY kind').all();
  assert.deepEqual(rows.map(r => r.last_error), ['delivery-adapter-unavailable', 'delivery-adapter-unavailable']);
  assert.deepEqual(rows.map(r => r.delivery_key), [`delivery:closure-audit:${result.entryId}:${mergeSha}`, `delivery:merge-action-receipt:${result.entryId}:${mergeSha}`]);
});

test('expired original patience parks with one page and no merge; final waits clip to the remaining deadline', async t => {
  const p = await finalizing(t); const { f, a } = p;
  const deadline = f.store.readEntry(a.ack.entryId).patience.deadline;
  const waits = [];
  const record = adapter => ({ read: async req => { waits.push(req.timeoutMs); return adapter.read(req); } });
  f.clock((Date.parse(deadline) - Date.parse(handoffTime(0))) / 1000 - 2);
  p.options.load = high;
  p.options.checkReader = record(p.options.checkReader);
  p.options.liveAdapter = record(p.live);
  const merged = await p.finalize();
  assert.equal(merged.phase, 'merged');
  assert.ok(waits.length >= 3 && waits.slice(0, 2).every(ms => ms > 0 && ms <= 2_000), JSON.stringify(waits));
  assert.ok(p.calls[0].timeoutMs <= 2_000);

  const q = await finalizing(t);
  q.f.clock(3600);
  const parked = await q.finalize({ load: high });
  assert.equal(parked.phase, 'parked-infrastructure'); assert.equal(parked.reason, 'merge-deadline-expired');
  assert.equal(q.calls.length, 0); assert.equal(q.pages.length, 1);
  assert.equal(q.f.store.readOwner(parked.lane).owner_state, 'idle');
  assert.deepEqual(parked.patience, q.entry.patience);
});

test('delivery waits scale once under high load and stay under the finite ceiling', async t => {
  const p = await finalizing(t);
  const waits = [];
  p.options.deliveryAdapters = Object.fromEntries(Object.entries(p.options.deliveryAdapters).map(([kind, adapter]) =>
    [kind, { read: req => { waits.push(req.timeoutMs); return adapter.read(req); } }]));
  p.options.load = high;
  await p.finalize();
  assert.equal(waits.length, 2); assert.ok(waits.every(ms => ms === 30_000), JSON.stringify(waits));
});

test('ten consecutive overlapping finalize races issue exactly one merge each', async t => {
  let duplicates = 0;
  for (let n = 0; n < 10; n++) {
    const p = await finalizing(t);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const merge = p.options.mergeSurface.merge;
    p.options.mergeSurface = { name: 'slow', merge: async request => { await gate; return merge(request); } };
    const first = p.finalize(), second = p.finalize();
    setTimeout(release, 20);
    const outcomes = await Promise.allSettled([first, second]);
    if (p.calls.length !== 1) duplicates++;
    assert.equal(p.calls.length, 1);
    assert.ok(outcomes.some(o => o.status === 'fulfilled' && o.value.phase === 'merged'));
    assert.equal(count(p.f, 'finalization_queue_merge_receipt'), 1); assert.equal(mergeActions(p).length, 1);
  }
  t.diagnostic(`${10 - duplicates}/10 races issued exactly one merge`);
});

test('ten consecutive stale observers that resume after a settled merge never issue a second merge', async t => {
  // Observer B passes the start checks, then stalls on its first live read and
  // keeps serving that pre-merge snapshot (a stale read cache). A merges and
  // settles, then pauses before recording; B resumes inside that gap.
  let single = 0;
  for (let n = 0; n < 10; n++) {
    const p = await finalizing(t);
    let resumeB, observedB, resumeA, settledA;
    const bReading = new Promise(resolve => { observedB = resolve; }), bGate = new Promise(resolve => { resumeB = resolve; });
    const aSettled = new Promise(resolve => { settledA = resolve; }), aGate = new Promise(resolve => { resumeA = resolve; });
    let cached = null;
    const stalled = { read: async req => {
      if (!cached) { cached = await p.live.read(req); observedB(); await bGate; }
      return structuredClone(cached);
    } };
    const owner = { ...p.a.owner, issue: async args => { const issued = await p.a.owner.issue(args); settledA(); await aGate; return issued; } };
    const b = p.finalize({ liveAdapter: stalled });
    await bReading;
    const a = p.finalize({ owner });
    await aSettled;
    resumeB();
    const bOutcome = await Promise.allSettled([b]);
    resumeA();
    await Promise.allSettled([a]);
    // Whichever recorder lost its snapshot, the settled merge records once.
    const end = await p.finalize();
    assert.equal(end.phase, 'merged'); assert.equal(count(p.f, 'finalization_queue_merge_receipt'), 1);
    if (p.calls.length === 1) single++;
    t.diagnostic(`race ${n + 1}: merges=${p.calls.length} B=${bOutcome[0].status} ${bOutcome[0].reason?.message ?? bOutcome[0].value?.phase}`);
  }
  t.diagnostic(`${single}/10 stale-observer races issued exactly one merge`);
  assert.equal(single, 10);
});

test('merge probe fails honestly for an absent deployment store', () => {
  const result = probeQueueOwner({ rootDir: '/nonexistent-fixture', now: handoffTime(0), load: idle });
  assert.equal(result.capabilities.merge.available, false); assert.ok(result.runtime.build);
});
