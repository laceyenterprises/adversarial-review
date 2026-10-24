import assert from 'node:assert/strict';
import test from 'node:test';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openFinalizationQueueStore } from '../src/finalization/queue-store.mjs';
import { createQueueHandoffService } from '../src/finalization/queue-handoff-store.mjs';
import { createCloserQueueHandoffBoundary } from '../src/ama/closer-queue-handoff.mjs';
import { createQueueOwner } from '../src/finalization/queue-owner.mjs';
import { foldQueue } from '../src/finalization/ledger-fold.mjs';
import { probeQueueOwner } from '../src/finalization/queue-probe.mjs';
import { queueHandoffFixture, handoffTime, handoffHead } from './helpers/queue-handoff-fixture.mjs';

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mgq-handoff-'));
  const store = openFinalizationQueueStore({ rootDir: root });
  const { h, e } = queueHandoffFixture();
  let reads = 0;
  const service = createQueueHandoffService({ store, evidenceAdapter: { read: async () => { reads++; return e; } },
    now: () => handoffTime(0), load: { enabled: false }, ...options });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, service, h, e, reads: () => reads };
}
const count = (store, table) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('duplicate and lost acknowledgement return the durable receipt without rereads or readiness changes', async t => {
  const f = fixture(t);
  const first = await f.service.submit(f.h);
  f.e.subject.state = 'closed';
  const reordered = Object.fromEntries(Object.entries(f.h).reverse());
  for (let i = 0; i < 20; i++) assert.deepEqual(await f.service.submit(reordered), first);
  assert.equal(f.reads(), 1);
  assert.equal(count(f.store, 'finalization_queue_handoff'), 1);
  assert.equal(count(f.store, 'finalization_queue_entry'), 1);
  assert.equal(count(f.store, 'finalization_queue_event'), 1);
  assert.equal(f.store.readOwner(f.h.lane).readiness_seq, 1);
  const reopened = openFinalizationQueueStore({ rootDir: f.root });
  try {
    const service = createQueueHandoffService({ store: reopened });
    assert.deepEqual(await service.submit(f.h), first, 'no evidence adapter needed to replay committed receipt');
  } finally { reopened.close(); }
});

const invalid = [
  ['missing non-blocking finding', h => h.dispositions.pop()],
  ['missing blocking finding', h => h.dispositions.shift()],
  ['duplicate finding', h => h.dispositions.push(h.dispositions[0])],
  ['foreign finding', h => { h.dispositions[0].findingId = 'foreign'; }],
  ['severity downgrade', h => { h.dispositions[0].severity = 'non-blocking'; }],
  ['ack as disposition', h => { h.dispositions[0].resolution = 'acknowledged'; }],
  ['budget as disposition', h => { h.dispositions[0].resolution = 'exhausted'; }],
  ['fixed without evidence', h => { h.dispositions[0].evidence = 'done'; }],
  ['fixed without paths', h => { h.dispositions[0].paths = []; }],
  ['withdrawn without explanation', h => { h.dispositions[1].explanation = ''; }],
  ['withdrawn without source', h => { h.dispositions[1].sourceLocations = []; }],
  ['withdrawn without concrete evidence', h => { h.dispositions[1].evidence = 'not valid'; }],
  ['wrong evidence head', h => { h.dispositions[0].head = 'c'.repeat(40); }],
  ['stale source review commit', h => { h.sourceReview.commitId = 'c'.repeat(40); }],
  ['review commit_id missing', h => { delete h.sourceReview.commitId; }],
  ['wrong finding commit', h => { h.dispositions[0].reviewCommitId = 'c'.repeat(40); }],
  ['unknown inventory', (_h, e) => { e.review.complete = false; }],
  ['unknown finding currency', (_h, e) => { e.review.findings[0].currency.current = false; }],
  ['stale review currency', (_h, e) => { e.currency.currentHead = 'c'.repeat(40); }],
  ['unknown currency proof', (_h, e) => { e.currency.proof = 'assumed-current'; }],
  ['invalid produced signature', (_h, e) => { e.attestations.produced.valid = false; }],
  ['invalid reviewed signature', (_h, e) => { e.attestations.reviewed.valid = false; }],
  ['wrong signed head', (_h, e) => { e.attestations.reviewed.record.head_sha = handoffHead; }],
  ['missing signature', (_h, e) => { delete e.attestations.produced.record.signature; }],
  ['empty signature', (_h, e) => { e.attestations.reviewed.record.signature = {}; }],
  ['wrong signed repo', (_h, e) => { e.attestations.produced.record.repo = 'example/other'; }],
  ['wrong signed reviewer', (_h, e) => { e.attestations.reviewed.record.producer_identity = 'other-app'; }],
  ['wrong signed closer', (_h, e) => { e.attestations.produced.record.payload.launch_request_id = 'other'; }],
  ['invalid worker identity', h => { h.worker.workerId = 'other'; }],
  ['invalid closer identity', h => { h.closer.launchRequestId = 'other'; }],
  ['unverified identities', (_h, e) => { e.identities.ok = false; }],
  ['failed publication', (_h, e) => { e.publication.ok = false; }],
  ['missing publication receipt', h => { h.publication.sourceRef = ''; }],
  ['wrong live head', (_h, e) => { e.subject.head = 'c'.repeat(40); }],
  ['wrong base', (_h, e) => { e.subject.lane.base = 'other'; }],
  ['primary change unverified', (_h, e) => { e.primaryChange.ok = false; }],
  ['validation unverified', (_h, e) => { e.localValidation.ok = false; }],
];
for (const [name, mutate] of invalid) test(`reject ${name} without entry, receipt or event`, async t => {
  const f = fixture(t); mutate(f.h, f.e);
  await assert.rejects(f.service.submit(f.h));
  for (const table of ['handoff', 'entry', 'event', 'lane']) assert.equal(count(f.store, `finalization_queue_${table}`), 0);
});

test('changed handoff content or reused id conflicts; changed object key order does not', async t => {
  const f = fixture(t); await f.service.submit(f.h);
  for (const mutate of [h => { h.handoffId = 'other'; }, h => { h.prNumber++; },
    h => { h.dispositions[1].explanation = 'Different adjudication'; }]) {
    const h = structuredClone(f.h); mutate(h);
    await assert.rejects(f.service.submit(h), /conflicting/);
  }
  assert.equal(count(f.store, 'finalization_queue_handoff'), 1);
});

test('receipt insert failure rolls back readiness, queue entry and acknowledgement event', async t => {
  const f = fixture(t);
  f.store.db.exec(`CREATE TRIGGER refuse_handoff BEFORE INSERT ON finalization_queue_handoff
    BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;`);
  await assert.rejects(f.service.submit(f.h), /fixture write failure/);
  for (const table of ['handoff', 'entry', 'event', 'lane']) assert.equal(count(f.store, `finalization_queue_${table}`), 0);
  f.store.db.exec('DROP TRIGGER refuse_handoff');
  assert.equal((await f.service.submit(f.h)).readinessSeq, 1);
});

test('boundary confirms acknowledgement before release and suppresses duplicate closer dispatch', async t => {
  const f = fixture(t), boundary = createCloserQueueHandoffBoundary({ handoffService: f.service });
  let releases = 0, dispatches = 0;
  assert.equal(await boundary.dispatch(f.h, () => ++dispatches), 1);
  const result = await boundary.handoff(f.h, { releaseResources: ack => {
    assert.deepEqual(f.service.readAcknowledgement(f.h), ack); releases++;
  } });
  assert.equal(result.outcome, 'queue-handoff-acknowledged'); assert.equal(releases, 1);
  for (let i = 0; i < 20; i++) await boundary.dispatch(f.h, () => ++dispatches);
  assert.equal(dispatches, 1);
  assert.equal(f.reads(), 1, 'no new model judgement or review');
});

test('failed publication and missing, mismatched or unreadable acknowledgement cannot release resources', async t => {
  const f = fixture(t); f.e.publication.ok = false;
  const releaseResources = () => assert.fail('unacknowledged resource release');
  await assert.rejects(createCloserQueueHandoffBoundary({ handoffService: f.service }).handoff(f.h, { releaseResources }));
  for (const readAcknowledgement of [() => null, () => ({}), () => { throw new Error('unreadable'); }]) {
    const handoffService = { submit: async () => ({ status: 'acknowledged' }), readAcknowledgement };
    await assert.rejects(createCloserQueueHandoffBoundary({ handoffService }).handoff(f.h, { releaseResources }));
  }
  assert.equal(f.service.readAcknowledgement(f.h), null);
});

test('missing trusted evidence adapter refuses submission; failed resource release can retry the durable ack', async t => {
  const f = fixture(t);
  await assert.rejects(createQueueHandoffService({ store: f.store }).submit(f.h), /adapter unavailable/);
  const boundary = createCloserQueueHandoffBoundary({ handoffService: f.service });
  await assert.rejects(boundary.handoff(f.h, { releaseResources: () => { throw new Error('release failed'); } }), /release failed/);
  const ack = f.service.readAcknowledgement(f.h);
  let releases = 0;
  assert.deepEqual((await boundary.handoff(f.h, { releaseResources: () => releases++ })).ack, ack);
  assert.equal(releases, 1); assert.equal(f.reads(), 1);
});

test('inconsistent durable receipt refuses completion and dispatch without remote work', async t => {
  const f = fixture(t); await f.service.submit(f.h);
  f.store.db.prepare('UPDATE finalization_queue_handoff SET payload_digest=?').run('corrupted');
  const boundary = createCloserQueueHandoffBoundary({ handoffService: f.service });
  await assert.rejects(boundary.dispatch(f.h, () => assert.fail('inconsistent receipt dispatched')), /inconsistent/);
  await assert.rejects(boundary.handoff(f.h, { releaseResources: () => assert.fail('inconsistent release') }), /inconsistent/);
});

test('MGQ-01 storage acknowledgements are not completed validated handoffs: 20 baseline admissions', async t => {
  const f = fixture(t), boundary = createCloserQueueHandoffBoundary({ handoffService: f.service });
  let dispatches = 0;
  for (let i = 1; i <= 20; i++) {
    const key = { ...f.h, prNumber: i };
    f.store.acknowledge({ ...key, entryId: `old:${i}`, ackId: `ack:${i}`, handoffId: `old-handoff:${i}`, at: handoffTime(0) });
    assert.equal(f.service.readAcknowledgement(key), null);
    await boundary.dispatch(key, () => ++dispatches);
  }
  assert.equal(dispatches, 20);
  assert.equal(count(f.store, 'finalization_queue_handoff'), 0);
  t.diagnostic('baseline storage-only path: 20/20 entries lack full handoff acknowledgement; none claims closer completion');
});

test('bot candidate derivation retains original signatures and fixed/withdrawn finding identities', async t => {
  const f = fixture(t); const ack = await f.service.submit(f.h);
  const receipt = f.service.readReceipt(f.h);
  const owner = createQueueOwner({ store: f.store, now: () => handoffTime(0) });
  const { fence } = await owner.claim({ lane: f.h.lane, ownerId: 'queue-owner', expiresAt: handoffTime(60) });
  for (const phase of ['ready', 'rebasing', 'publishing']) f.store.progress({ fence, entryId: ack.entryId, phase,
    at: handoffTime(1), patch: phase === 'publishing' ? { candidate: 'c'.repeat(40), exactBase: 'd'.repeat(40),
      proof: { sourceHead: f.h.head, sourceRef: 'derivation:1', handoffDigest: ack.payloadDigest } } : {} });
  assert.deepEqual(f.service.readReceipt(f.h), receipt);
  assert.deepEqual(receipt.handoff.dispositions.map(d => d.resolution), ['fixed', 'withdrawn']);
  assert.equal(receipt.evidence.attestations.produced.record.head_sha, f.h.head);
  assert.equal(receipt.evidence.attestations.reviewed.record.head_sha, f.h.sourceReview.commitId);
  const replay = foldQueue(f.store.readEvents(f.h.lane));
  assert.equal(replay.entries[ack.entryId].handoffDigest, ack.payloadDigest);
  assert.equal(replay.entries[ack.entryId].candidate, 'c'.repeat(40));
});

function client(t, root, fixture, crash = false) {
  const child = fork(fileURLToPath(new URL('./helpers/queue-handoff-client.mjs', import.meta.url)),
    [JSON.stringify({ root, ...fixture, crash })], { execArgv: ['--preserve-symlinks', '--preserve-symlinks-main'],
      env: { ...process.env, NODE_TEST_CONTEXT: '' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  return child;
}
test('20 independent duplicate submitter pairs commit one entry/ack after both observe absence', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 20; i++) {
    const input = queueHandoffFixture(i), children = [client(t, f.root, input), client(t, f.root, input)];
    const exits = children.map(c => once(c, 'exit'));
    assert.deepEqual(await Promise.all(children.map(c => once(c, 'message').then(([m]) => m))), ['ready', 'ready']);
    const reading = children.map(c => once(c, 'message'));
    children.forEach(c => c.send('submit')); await Promise.all(reading);
    const responses = children.map(c => once(c, 'message').then(([m]) => m));
    children.forEach(c => c.send('commit'));
    const [a, b] = await Promise.all(responses); await Promise.all(exits);
    assert.equal(a.status, 'acknowledged'); assert.deepEqual(a, b);
    assert.equal(f.service.readAcknowledgement(input.h).readinessSeq, i);
    assert.equal(count(f.store, 'finalization_queue_handoff'), i);
    assert.equal(count(f.store, 'finalization_queue_entry'), i);
  }
  t.diagnostic('fixed: 20/20 consecutive process pairs; one durable entry and identical ack per pair; zero duplicate entries');
});

test('actual process exit after commit before reply replays one durable acknowledgement', async t => {
  const f = fixture(t), child = client(t, f.root, { h: f.h, e: f.e }, true);
  const exit = once(child, 'exit');
  await once(child, 'message');
  const reading = once(child, 'message'); child.send('submit'); await reading;
  child.send('commit'); assert.equal((await exit)[0], 23);
  const ack = await f.service.submit(f.h);
  assert.deepEqual(ack, f.service.readAcknowledgement(f.h)); assert.equal(f.reads(), 0);
  for (const table of ['handoff', 'entry', 'event']) assert.equal(count(f.store, `finalization_queue_${table}`), 1);
});

const highLoad = { enabled: true, maxMultiplier: 20, loadAvg1m: 100, cpuCount: 1, cpuBusyPercent: 100 };
test('evidence wait scales nominal once, clips remaining deadline and caps timer overflow', async t => {
  const f = fixture(t); let observed;
  const service = createQueueHandoffService({ store: f.store, now: () => handoffTime(0), load: highLoad,
    evidenceAdapter: { read: async ({ timeoutMs }) => { observed = timeoutMs; return f.e; } } });
  await service.submit(f.h, { deadline: handoffTime(2) }); assert.equal(observed, 2_000);
  const second = fixture(t, { load: highLoad, evidenceAdapter: { read: async ({ timeoutMs }) => {
    assert.equal(timeoutMs, 30_000); assert.ok(timeoutMs <= 2 ** 31 - 1); return f.e;
  } } });
  await second.service.submit(second.h, { deadline: '9999-01-01T00:00:00Z' });
  assert.equal(second.store.readEntry(second.service.readAcknowledgement(second.h).entryId).patience.effectiveMs, 3_600_000);
});

test('read and commit waits each scale once below their ceiling; DB wait clips and restores after failure', async t => {
  const f = fixture(t); let at = handoffTime(0), commitWait;
  const priorWait = f.store.db.pragma('busy_timeout', { simple: true });
  const acknowledge = f.store.acknowledge;
  f.store.acknowledge = args => {
    commitWait = f.store.db.pragma('busy_timeout', { simple: true });
    return acknowledge(args);
  };
  const service = createQueueHandoffService({ store: f.store, now: () => at,
    load: { ...highLoad, loadAvg1m: 1.4 }, evidenceAdapter: { read: async ({ timeoutMs }) => {
      assert.equal(timeoutMs, 10_000, '5 seconds nominal at 2x load');
      at = handoffTime(29); return f.e;
    } } });
  await service.submit(f.h);
  assert.equal(commitWait, 1_000, 'DB wait clipped to one remaining second');
  assert.equal(f.store.db.pragma('busy_timeout', { simple: true }), priorWait);
  const failure = fixture(t);
  const original = failure.store.db.pragma('busy_timeout', { simple: true });
  failure.store.db.exec(`CREATE TRIGGER refuse_handoff BEFORE INSERT ON finalization_queue_handoff
    BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;`);
  await assert.rejects(failure.service.submit(failure.h));
  assert.equal(failure.store.db.pragma('busy_timeout', { simple: true }), original);
});

test('expired deadline refuses reads and elapsed evidence wait cannot commit', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.submit(f.h, { deadline: handoffTime(0) }), /deadline/);
  assert.equal(f.reads(), 0);
  let at = handoffTime(0);
  const service = createQueueHandoffService({ store: f.store, now: () => at, evidenceAdapter: { read: async () => {
    at = handoffTime(31); return f.e;
  } } });
  await assert.rejects(service.submit(f.h), /deadline/);
  assert.equal(count(f.store, 'finalization_queue_handoff'), 0);
});

test('unresponsive evidence read times out, aborts and never acknowledges late evidence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal, finish;
  const f = fixture(t, { evidenceAdapter: { read: args => {
    signal = args.signal; return new Promise(resolve => { finish = resolve; });
  } } });
  const submitting = f.service.submit(f.h);
  const rejected = assert.rejects(submitting, /deadline expired/);
  await Promise.resolve();
  t.mock.timers.tick(5_000); await rejected;
  assert.equal(signal.aborted, true); finish(f.e); await Promise.resolve();
  assert.equal(count(f.store, 'finalization_queue_handoff'), 0);
});

function tree(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
    .map(e => [join(e.parentPath, e.name).slice(root.length), readFileSync(join(e.parentPath, e.name)).toString('hex')]);
}
test('read-only deployed handoff probe reports real schema, adapter, build and durable ack counts', async t => {
  const f = fixture(t);
  let before = tree(f.root);
  let result = probeQueueOwner({ rootDir: f.root, now: handoffTime(0) });
  assert.equal(result.capabilities.handoff.available, true);
  assert.equal(result.observations.handoff.acknowledgements, 0);
  assert.equal(result.observations.handoff.organicHandoffObserved, false); assert.deepEqual(tree(f.root), before);
  await f.service.submit(f.h); before = tree(f.root);
  result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../src/finalization/queue-probe.mjs', import.meta.url)),
    '--capability', 'handoff', '--json', '--root', f.root], { timeout: 10_000, encoding: 'utf8' }));
  assert.equal(result.capabilities.handoff.available, true); assert.ok(result.runtime.build);
  assert.equal(result.observations.handoff.acknowledgements, 1); assert.deepEqual(tree(f.root), before);
  f.store.db.exec('DROP TABLE finalization_queue_handoff'); before = tree(f.root);
  result = probeQueueOwner({ rootDir: f.root });
  assert.equal(result.capabilities.owner.available, true); assert.equal(result.capabilities.handoff.available, false);
  assert.deepEqual(tree(f.root), before);
});
