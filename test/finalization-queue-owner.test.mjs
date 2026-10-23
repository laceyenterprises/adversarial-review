import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork, execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { openFinalizationQueueStore } from '../src/finalization/ledger-store.mjs';
import { createQueueOwner } from '../src/finalization/executor-lease-store.mjs';
import { foldQueue, reconcileQueuePublication } from '../src/finalization/ledger-fold.mjs';
import { QUEUE_ACTIONABLE_PHASES, resolveLaneKey } from '../src/finalization/ledger-events.mjs';
import { queueWaitMs } from '../src/finalization/queue-wait.mjs';
import { probeQueueOwner } from '../src/finalization/queue-probe.mjs';

const lane = { repository: 'example/review', base: 'main' };
const time = n => new Date(Date.parse('2026-10-23T00:00:00.000Z') + n * 1000).toISOString();
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mgq-'));
  const store = openFinalizationQueueStore({ rootDir: root });
  let clock = time(0);
  const owner = createQueueOwner({ store, now: () => clock, ...options });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, owner, clock: n => { clock = time(n); } };
}
const ack = (store, id = 'q-101', extra = {}) => store.acknowledge({
  lane, entryId: id, prNumber: id === 'q-101' ? 101 : 102, head: 'old-head',
  admissionGeneration: 1, handoffId: `handoff:${id}`, ackId: `ack:${id}`, at: time(0), ...extra,
});
async function claim(f, ownerId = 'owner-a', expiresAt = time(60), laneKey = lane) {
  return (await f.owner.claim({ lane: laneKey, ownerId, expiresAt })).fence;
}
function advance(store, fence, phase, patch = {}) {
  return store.progress({ fence, entryId: 'q-101', phase, patch, at: time(1) });
}
function publishing(store, fence) {
  for (const phase of ['ready', 'rebasing', 'publishing']) advance(store, fence, phase,
    phase === 'publishing' ? { candidate: 'new-head', exactBase: 'base-head', proof: { sourceRef: 'proof:1' } } : {});
}

test('canonical lane identity preserves distinct Git refs and rejects aliases', () => {
  assert.deepEqual(resolveLaneKey({ repository: 'Example/Review', base: 'feature/Main' }), { repository: 'example/review', base: 'feature/Main' });
  for (const base of ['refs/heads/main', 'a..b', 'bad ref', 'a//b', '.hidden', 'a.lock', '@{a}', '']) {
    assert.throws(() => resolveLaneKey({ ...lane, base }));
  }
});

test('30 simultaneous claimant pairs: exactly one owner and outcome read-back each time', async t => {
  const f = fixture(t);
  let consecutive = 0;
  for (let trial = 0; trial < 30; trial++) {
    const key = { ...lane, base: `trial-${trial}` };
    const workers = ['a','b'].map(id => fork(fileURLToPath(new URL('./helpers/queue-claimant.mjs', import.meta.url)),
      [JSON.stringify({ root: f.root, lane: key, id: `owner-${id}`, now: time(0), expiry: time(60) })], {
      execArgv: ['--preserve-symlinks', '--preserve-symlinks-main'],
      env: { ...process.env, NODE_TEST_CONTEXT: '' },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    }));
    const exited = workers.map(w => once(w, 'exit'));
    assert.deepEqual(await Promise.all(workers.map(w => once(w, 'message').then(([m]) => m))), ['ready','ready']);
    const replies = workers.map(w => once(w, 'message').then(([m]) => m));
    workers.forEach(w => w.send('claim'));
    const results = await Promise.all(replies);
    await Promise.all(exited);
    assert.equal(results.filter(r => r.ok).length, 1, JSON.stringify(results));
    const winner = results.find(r => r.ok);
    const persisted = f.store.readOwner(key);
    assert.equal(persisted.owner_id, winner.fence.ownerId);
    assert.equal(persisted.generation, 1);
    consecutive++;
  }
  t.diagnostic(`fixed: ${consecutive}/30 consecutive single-owner outcomes; 0 duplicate owners`);
});

test('repositories and case-sensitive bases remain independent', async t => {
  const f = fixture(t);
  for (const key of [lane, { ...lane, base: 'Main' }, { ...lane, repository: 'example/other' }]) {
    assert.equal((await f.owner.claim({ lane: key, ownerId: 'owner', expiresAt: time(60) })).ok, true);
  }
});

test('stale generation/route and expired owner cannot renew, release, progress, push or merge', async t => {
  const f = fixture(t); ack(f.store);
  const old = await claim(f);
  publishing(f.store, old);
  f.clock(61);
  const fresh = await claim(f, 'owner-b', time(120));
  assert.equal(fresh.generation, old.generation + 1);
  for (const fence of [old, { ...fresh, routeGeneration: 99 }]) {
    await assert.rejects(f.owner.renew({ fence, expiresAt: time(200) }), /stale/);
    await assert.rejects(f.owner.release({ fence }), /stale/);
    assert.throws(() => f.store.progress({ fence, entryId: 'q-101', phase: 'waiting-checks', at: time(62) }), /stale/);
    for (const kind of ['push', 'merge']) {
      await assert.rejects(f.owner.issue({ fence, entryId: 'q-101', operationId: `stale-${kind}`, kind,
        invoke: () => assert.fail('stale fence invoked remote mutation') }), /stale/);
    }
  }
  f.clock(121);
  await assert.rejects(f.owner.renew({ fence: fresh, expiresAt: time(200) }), /stale/);
  assert.equal(f.store.readOwner(lane).owner_id, 'owner-b');
});

test('paused issuance prevents takeover and release until drain; stale resumed invocation fails', async t => {
  const f = fixture(t); ack(f.store); const old = await claim(f); publishing(f.store, old);
  let drain;
  let started;
  const start = new Promise(resolve => { started = resolve; });
  const inFlight = f.owner.issue({ fence: old, entryId: 'q-101', operationId: 'push-1', kind: 'push', invoke: async () => {
    started();
    return await new Promise(resolve => { drain = resolve; });
  } });
  await start;
  const pending = f.store.operations(lane);
  assert.equal(pending.length, 1, 'intent is durable before the adapter runs');
  f.clock(61);
  assert.equal((await f.owner.claim({ lane, ownerId: 'owner-b', expiresAt: time(120) })).reason, 'owner-operation-in-flight');
  assert.equal((await f.owner.release({ fence: old })).ok, false);
  assert.equal(f.store.readOwner(lane).generation, old.generation);
  drain({ outcome: 'succeeded', sourceRef: 'remote:push-1' });
  await assert.rejects(inFlight, /stale/);
  assert.equal((await f.owner.claim({ lane, ownerId: 'owner-b', expiresAt: time(120) })).reason, 'prior-operation-quiescence-unproven');
  assert.equal(f.store.readOwner(lane).owner_state, 'parked');
  assert.equal(f.store.operations(lane).length, 1);
});

test('ambiguous push requires proven drain AND every outcome; no duplicate issuance at identical timestamps', async t => {
  let evidence;
  const f = fixture(t, { recoveryAdapter: { stopDrainAndReconcile: async () => evidence } });
  ack(f.store); const old = await claim(f); publishing(f.store, old);
  let calls = 0;
  const request = { fence: old, entryId: 'q-101', operationId: 'push-1', kind: 'push', invoke: () => { calls++; throw new Error('lost reply'); } };
  await assert.rejects(f.owner.issue(request), /lost reply/);
  await assert.rejects(f.owner.issue(request), /reconciliation/);
  assert.equal(calls, 1);
  f.clock(61);
  evidence = { quiescent: true, sourceRef: 'drain:1', results: {} };
  assert.equal((await f.owner.claim({ lane, ownerId: 'owner-b', expiresAt: time(120) })).ok, false);
  evidence.results['push-1'] = { outcome: 'succeeded', sourceRef: 'live-head:new-head' };
  const next = await claim(f, 'owner-b', time(120));
  assert.ok(next);
  assert.equal(f.store.operations(lane).length, 0);
  const resumed = f.store.progress({ fence: next, entryId: 'q-101', phase: 'publishing', at: time(62), recoveryObservation: {
    state: 'open', head: 'new-head', base: 'base-head', sourceRef: 'live:1',
  } });
  assert.equal(resumed.phase, 'waiting-checks');
  assert.equal(calls, 1);
});

test('FIFO acknowledgements, duplicates and parking/readmission retain atomic sequence and deadline', async t => {
  const f = fixture(t); const a = ack(f.store); const b = ack(f.store, 'q-102');
  assert.equal(ack(f.store).readinessSeq, a.readinessSeq);
  assert.equal(b.readinessSeq, a.readinessSeq + 1);
  assert.throws(() => ack(f.store, 'q-101', { head: 'foreign' }), /conflicting/);
  const fence = await claim(f);
  assert.throws(() => f.store.progress({ fence, entryId: b.entryId, phase: 'ready', at: time(1) }), /predecessor/);
  advance(f.store, fence, 'parked-hold', { reason: 'live-hold' });
  const readmitted = f.store.progress({ fence, entryId: a.entryId, phase: 'ready', at: time(2), readmit: true });
  assert.ok(readmitted.readinessSeq > b.readinessSeq);
  assert.deepEqual(readmitted.patience, a.patience);
  assert.deepEqual(f.store.entries(lane).map(e => e.entryId), [b.entryId, a.entryId]);
});

test('crash/reopen at each phase and operation boundary replays candidate, order and original deadline', async t => {
  const f = fixture(t); const a = ack(f.store); ack(f.store, 'q-102'); const fence = await claim(f);
  for (const phase of QUEUE_ACTIONABLE_PHASES.slice(1)) {
    advance(f.store, fence, phase, ['publishing','waiting-checks','finalizing'].includes(phase) ? { candidate: 'new-head', exactBase: 'base-head' } : {});
    const reopened = openFinalizationQueueStore({ rootDir: f.root });
    const events = reopened.readEvents(lane);
    const replay = foldQueue(events);
    assert.deepEqual(replay.entries['q-101'], reopened.readEntry('q-101'));
    assert.equal(replay.entries['q-101'].phase, phase);
    assert.deepEqual(replay.entries['q-101'].patience, a.patience);
    assert.deepEqual(foldQueue(events.slice(2), foldQueue(events.slice(0, 2))), replay);
    reopened.close();
  }
  await assert.rejects(f.owner.issue({ fence, entryId: 'q-101', operationId: 'merge-1', kind: 'merge', invoke: () => { throw new Error('crash'); } }), /crash/);
  let reopened = openFinalizationQueueStore({ rootDir: f.root });
  let replay = foldQueue(reopened.readEvents(lane));
  assert.equal(replay.operations['merge-1'].candidate, 'new-head');
  assert.equal(replay.operations['merge-1'].deadline, a.patience.deadline);
  assert.equal(reopened.operations(lane).length, 1);
  reopened.close();
  f.clock(61);
  const recover = createQueueOwner({ store: f.store, now: () => time(61), recoveryAdapter: { stopDrainAndReconcile: async () => ({
    quiescent: true, sourceRef: 'drain:1', results: { 'merge-1': { outcome: 'not-applied', sourceRef: 'live:open' } },
  }) } });
  assert.equal((await recover.claim({ lane, ownerId: 'owner-b', expiresAt: time(120) })).ok, true);
  reopened = openFinalizationQueueStore({ rootDir: f.root });
  replay = foldQueue(reopened.readEvents(lane));
  assert.equal(replay.operations['merge-1'].result.outcome, 'not-applied');
  assert.deepEqual(replay.entries['q-101'].patience, a.patience);
  reopened.close();
});

test('publication restart cases preserve patience and candidate across outside base writes', async t => {
  const f = fixture(t); const a = ack(f.store); const fence = await claim(f); publishing(f.store, fence);
  for (const [head, base, phase] of [
    ['new-head','base-head','waiting-checks'], ['old-head','base-head','publishing'],
    ['new-head','changed-base','rebasing'], ['unrelated','base-head','returned-to-closer'],
  ]) {
    const entry = f.store.readEntry(a.entryId);
    assert.equal(reconcileQueuePublication(entry, { state: 'open', head, base, sourceRef: 'live:1' }).phase, phase);
  }
  const reset = f.store.progress({ fence, entryId: a.entryId, phase: 'publishing', at: time(2), recoveryObservation: {
    state: 'open', head: 'new-head', base: 'changed-base', sourceRef: 'live:2',
  } });
  assert.equal(reset.phase, 'rebasing'); assert.equal(reset.checks, null);
  assert.equal(reset.candidate, 'new-head'); assert.deepEqual(reset.patience, a.patience);
});

test('waits scale nominal once, clip remaining deadline, cap effective patience and reject overflow', async t => {
  const high = { enabled: true, maxMultiplier: 20, loadAvg1m: 100, cpuCount: 1, cpuBusyPercent: 100 };
  assert.equal(queueWaitMs(1_000, { ceilingMs: 6_000, load: high }), 6_000);
  assert.equal(queueWaitMs(1_000, { ceilingMs: 6_000, load: high, now: time(0), deadline: time(2) }), 2_000);
  assert.equal(queueWaitMs(1_000, { ceilingMs: 6_000, load: high, now: time(2), deadline: time(1) }), 0);
  assert.equal(queueWaitMs(2 ** 40, { ceilingMs: 2 ** 42, load: high }), 2 ** 31 - 1);
  assert.throws(() => queueWaitMs(1, { ceilingMs: Infinity }));
  assert.throws(() => queueWaitMs(NaN, { ceilingMs: 1_000 }));
  const f = fixture(t); const entry = ack(f.store, 'q-101', { load: high });
  assert.equal(entry.patience.effectiveMs, 3_600_000);
  assert.equal(entry.patience.nominalMs, 1_800_000);
  assert.equal(entry.patience.deadline, time(3_600));
  assert.deepEqual(ack(f.store, 'q-101', { at: time(300), load: high }).patience, entry.patience);
});

test('wait deadline defaults to the current clock while explicit clocks and invalid dates retain their behavior', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(time(0)) });
  const options = { ceilingMs: 6_000, load: { enabled: false } };
  assert.equal(queueWaitMs(5_000, { ...options, deadline: time(2) }), 2_000);
  assert.equal(queueWaitMs(5_000, { ...options, deadline: time(-1) }), 0);
  assert.equal(queueWaitMs(5_000, { ...options, deadline: time(2), now: time(1) }), 1_000);
  assert.throws(() => queueWaitMs(5_000, { ...options, deadline: 'invalid' }), /invalid wait deadline/);
  assert.throws(() => queueWaitMs(5_000, { ...options, deadline: time(2), now: 'invalid' }), /invalid wait deadline/);
});

function tree(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
    .map(e => [join(e.parentPath, e.name).slice(root.length), readFileSync(join(e.parentPath, e.name)).toString('hex')]);
}
test('probe reads deployed schema/claims and adapter; missing/incompatible stores stay unavailable without writes', async t => {
  const f = fixture(t);
  const before = tree(f.root);
  const result = probeQueueOwner({ rootDir: f.root, now: time(0) });
  assert.equal(result.capabilities.owner.available, true);
  assert.ok(result.runtime.build.startsWith('sha256:'));
  assert.equal(result.observations.organicOwnershipObserved, false);
  assert.deepEqual(tree(f.root), before);
  await claim(f);
  assert.equal(probeQueueOwner({ rootDir: f.root }).observations.lanes[0].owner_id, 'owner-a');
  f.store.db.exec('DROP INDEX idx_finalization_queue_event_lane');
  assert.equal(probeQueueOwner({ rootDir: f.root }).capabilities.owner.available, false);
  const missing = mkdtempSync(join(tmpdir(), 'mgq-missing-'));
  t.after(() => rmSync(missing, { recursive: true, force: true }));
  assert.equal(probeQueueOwner({ rootDir: missing }).capabilities.owner.available, false);
  assert.deepEqual(readdirSync(missing), []);
});

test('migration converges an existing subject ledger without touching it', t => {
  const root = mkdtempSync(join(tmpdir(), 'mgq-migrate-'));
  mkdirSync(join(root, 'data'));
  const db = new Database(join(root, 'data', 'reviews.db'));
  db.exec("CREATE TABLE legacy_evidence(value TEXT); INSERT INTO legacy_evidence VALUES ('retained')");
  db.close();
  const store = openFinalizationQueueStore({ rootDir: root });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(store.db.prepare('SELECT value FROM legacy_evidence').get().value, 'retained');
  assert.equal(probeQueueOwner({ rootDir: root }).capabilities.owner.available, true);
});

test('actual issuer process crash releases lock but leaves ambiguity blocking replacement', async t => {
  const f = fixture(t); ack(f.store); const fence = await claim(f); publishing(f.store, fence);
  const child = fork(fileURLToPath(new URL('./helpers/queue-crash-issuer.mjs', import.meta.url)),
    [JSON.stringify({ root: f.root, fence, now: time(0) })], {
      execArgv: ['--preserve-symlinks', '--preserve-symlinks-main'], env: { ...process.env, NODE_TEST_CONTEXT: '' },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  assert.equal((await once(child, 'message'))[0], 'intent-durable');
  f.clock(61);
  assert.equal((await f.owner.claim({ lane, ownerId: 'owner-b', expiresAt: time(120) })).reason, 'owner-operation-in-flight');
  child.send('crash'); await exited;
  assert.equal((await f.owner.claim({ lane, ownerId: 'owner-b', expiresAt: time(120) })).reason, 'prior-operation-quiescence-unproven');
  assert.equal(f.store.readOwner(lane).generation, fence.generation);
  assert.equal(f.store.operations(lane)[0].operation_id, 'crash-push');
});

test('successful operation replay is durable; unresolved intents forbid progress/release; invalid expiry fails closed', async t => {
  const f = fixture(t); ack(f.store); const fence = await claim(f); publishing(f.store, fence);
  const request = { fence, entryId: 'q-101', operationId: 'push-1', kind: 'push', invoke: () => ({ outcome: 'succeeded', sourceRef: 'live:push' }) };
  assert.equal((await f.owner.issue(request)).ok, true);
  const replay = await f.owner.issue({ ...request, invoke: () => assert.fail('duplicate push') });
  assert.equal(replay.replay, true);
  const state = foldQueue(f.store.readEvents(lane));
  assert.equal(state.operations['push-1'].result.outcome, 'succeeded');
  advance(f.store, fence, 'waiting-checks'); advance(f.store, fence, 'finalizing');
  await assert.rejects(f.owner.issue({ ...request, operationId: 'merge-1', kind: 'merge', invoke: () => ({ outcome: 'unknown' }) }), /unproven/);
  assert.throws(() => advance(f.store, fence, 'merged'), /unreconciled/);
  await assert.rejects(f.owner.release({ fence }), /unreconciled/);
  f.store.db.prepare('UPDATE finalization_queue_lane SET expires_at=?').run('invalid');
  await assert.rejects(f.owner.renew({ fence, expiresAt: time(120) }), /stale/);
});

test('recovery expiry cannot strand settled operations in a parked lane, and release preserves generation', async t => {
  let ready = false;
  const f = fixture(t, { recoveryAdapter: { stopDrainAndReconcile: async ({ timeoutMs }) => {
    assert.ok(timeoutMs > 0 && timeoutMs <= 60_000);
    if (!ready) return null;
    f.clock(121);
    return { quiescent: true, sourceRef: 'drain:1', results: { 'push-1': { outcome: 'not-applied', sourceRef: 'live:old-head' } } };
  } } });
  ack(f.store); const fence = await claim(f); publishing(f.store, fence);
  await assert.rejects(f.owner.issue({ fence, entryId: 'q-101', operationId: 'push-1', kind: 'push', invoke: () => { throw new Error('crash'); } }));
  f.clock(61);
  await f.owner.claim({ lane, ownerId: 'owner-b', expiresAt: time(120) });
  const events = f.store.readEvents(lane).length;
  await f.owner.claim({ lane, ownerId: 'owner-b', expiresAt: time(120) });
  assert.equal(f.store.readEvents(lane).length, events, 'unchanged parked evidence does not spam appends');
  ready = true;
  assert.equal((await f.owner.claim({ lane, ownerId: 'owner-b', expiresAt: time(120) })).reason, 'claim-deadline-expired');
  assert.equal(f.store.operations(lane).length, 1, 'results remain unresolved until takeover commits with them');
  const next = await claim(f, 'owner-b', time(180));
  assert.ok(next);
  assert.equal(f.store.operations(lane).length, 0);
  await f.owner.release({ fence: next });
  const later = await claim(f, 'owner-c', time(180));
  assert.equal(later.generation, next.generation + 1);
  const replay = await f.owner.issue({ fence: later, entryId: 'q-101', operationId: 'push-1', kind: 'push', invoke: () => assert.fail('completed intent repeated') });
  assert.equal(replay.replay, true);
  assert.equal(replay.result.outcome, 'not-applied');
});


test('concurrent readiness acknowledgements commit unique ordered entries and replay lost acknowledgements', async t => {
  const f = fixture(t);
  const children = [101,102].map(pr => fork(fileURLToPath(new URL('./helpers/queue-claimant.mjs', import.meta.url)),
    [JSON.stringify({ root: f.root, admission: { lane, entryId: `q-${pr}`, prNumber: pr, head: 'old-head', admissionGeneration: 1,
      handoffId: `handoff:q-${pr}`, ackId: `ack:q-${pr}`, at: time(0) } })], {
      execArgv: ['--preserve-symlinks', '--preserve-symlinks-main'], env: { ...process.env, NODE_TEST_CONTEXT: '' },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    }));
  const exited = children.map(c => once(c, 'exit'));
  await Promise.all(children.map(c => once(c, 'message')));
  const replies = children.map(c => once(c, 'message').then(([r]) => r));
  children.forEach(c => c.send('acknowledge'));
  const results = await Promise.all(replies); await Promise.all(exited);
  assert.deepEqual(results.map(r => r.readinessSeq).sort(), [1,2]);
  assert.deepEqual(f.store.entries(lane).map(e => e.readinessSeq), [1,2]);
  for (const entry of results) assert.deepEqual(ack(f.store, entry.entryId), entry);
});

test('completed operation id cannot be rebound to a new candidate or exact base', async t => {
  const f = fixture(t); ack(f.store); const fence = await claim(f); publishing(f.store, fence);
  const request = { fence, entryId: 'q-101', operationId: 'push-1', kind: 'push', invoke: () => ({ outcome: 'succeeded', sourceRef: 'live:1' }) };
  await f.owner.issue(request);
  advance(f.store, fence, 'publishing', { candidate: 'changed-head' });
  await assert.rejects(f.owner.issue({ ...request, invoke: () => assert.fail('stale result invoked') }), /currency/);
});

test('deployed probe CLI uses real disposable store and creates no schema or claims', t => {
  const f = fixture(t); const before = tree(f.root);
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('../src/finalization/queue-probe.mjs', import.meta.url)),
    '--capability', 'owner', '--json', '--root', f.root], { encoding: 'utf8', timeout: 10_000 });
  const result = JSON.parse(output);
  assert.equal(result.capabilities.owner.available, true);
  assert.ok(result.runtime.build);
  assert.deepEqual(result.observations.lanes, []);
  assert.deepEqual(tree(f.root), before);
});

test('probe CLI rejects missing or unsupported capability before emitting observations', t => {
  const f = fixture(t); const before = tree(f.root);
  const cli = fileURLToPath(new URL('../src/finalization/queue-probe.mjs', import.meta.url));
  for (const args of [[], ['--json'], ['--capability'], ['--capability', 'other', '--json']]) {
    const result = spawnSync(process.execPath, [cli, ...args, '--root', f.root], {
      encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'invalid queue probe arguments\n');
  }
  assert.deepEqual(tree(f.root), before);
});
