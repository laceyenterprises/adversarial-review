import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shadowObserveQueue, recordQueueShadow } from '../src/finalization/shadow-recorder.mjs';
import { openFinalizationShadowStore, openReadOnlyFinalizationShadowStore } from '../src/finalization/shadow-store.mjs';
import { resolveQueueShadowAdapter } from '../src/finalization/queue-shadow.mjs';
import { buildShadowReport } from '../src/finalization/shadow-report.mjs';
import { buildQueueShadowMetrics } from '../src/finalization/queue-shadow-metrics.mjs';
import { openFinalizationQueueStore } from '../src/finalization/queue-store.mjs';
import { createCleanReviewService } from '../src/finalization/queue-clean-review.mjs';
import { probeQueueOwner } from '../src/finalization/queue-probe.mjs';
import { handoffDigest } from '../src/finalization/queue-handoff.mjs';
import { queueCleanFixture, queueLiveFixture } from './helpers/queue-clean-fixture.mjs';
import { queueHandoffFixture, handoffTime as time } from './helpers/queue-handoff-fixture.mjs';

const consumer = { id: 'fixture-shadow', build: 'fixture-build' };
function fixture(kind = 'clean') {
  const { h, e } = (kind === 'clean' ? queueCleanFixture : queueHandoffFixture)(101);
  const entry = { lane: h.lane, prNumber: 101, entryId: 'q-101', head: h.head, candidate: null, exactBase: null,
    readinessSeq: 1, phase: 'acknowledged', acknowledgedAt: time(0), updatedAt: time(0),
    patience: { deadline: time(3600) } };
  const snapshot = { entry, receipt: kind === 'clean' ? { kind, input: h, evidence: e } : { kind, handoff: h, evidence: e },
    live: queueLiveFixture(h), checks: null, queueEvents: [{ type: 'acknowledged', lane: h.lane, at: time(0), entry: structuredClone(entry) }] };
  const args = { subject: { domainId: 'code-pr', subjectExternalId: 'example/review#101' }, events: [], snapshot,
    v1Action: { kind: 'wait', sourceRef: 'v1:1' }, observedAt: time(10), consumer };
  return { args, snapshot, entry, step(phase, at, patch = {}) {
    const update = { ...patch, phase, updatedAt: time(at), progressVersion: (entry.progressVersion ?? 0) + 1 };
    snapshot.queueEvents.push({ type: 'progress', lane: h.lane, at: time(at), entryId: entry.entryId, patch: update });
    Object.assign(entry, update);
    if (Date.parse(time(at)) >= Date.parse(args.observedAt)) args.observedAt = time(at + 1);
  } };
}
function prepared(f) {
  f.step('ready', 1); f.step('rebasing', 2);
  f.step('publishing', 3, { candidate: f.entry.head, exactBase: f.snapshot.live.subject.baseSha,
    rebase: { sourceReceiptDigest: handoffDigest(f.snapshot.receipt.input ?? f.snapshot.receipt.handoff),
      publication: { head: f.entry.head, base: f.snapshot.live.subject.baseSha } } });
  f.step('waiting-checks', 4);
  f.snapshot.checks = { head: f.entry.candidate, base: f.entry.exactBase, complete: true,
    requiredSet: { contexts: ['unit'], version: 'rules:1' }, results: [{ name: 'unit', head: f.entry.candidate, conclusion: 'SUCCESS' }] };
  f.snapshot.derivation = { verified: true, sourceRef: 'proof:1', head: f.entry.candidate, base: f.entry.exactBase,
    receiptDigest: handoffDigest(f.snapshot.receipt.input ?? f.snapshot.receipt.handoff) };
  f.snapshot.identity = { ok: true, sourceRef: 'identity:1', login: 'queue-app', producerClass: 'ama-daemon' };
  return f;
}
const observe = f => shadowObserveQueue(f.args);

test('both admission types pair v1 with readiness/order, rebase, check and final proposals', () => {
  for (const kind of ['clean', 'remediated']) {
    const f = fixture(kind), initial = observe(f);
    assert.equal(initial.queue.admissionKind, kind);
    assert.equal(initial.queue.position, 1);
    assert.equal(initial.queue.rebase, 'propose-rebase');
    assert.equal(initial.v1Action.sourceRef, 'v1:1');
    prepared(f);
    const ready = observe(f);
    assert.equal(ready.queue.checks.kind, 'green');
    assert.equal(ready.queue.finalEligibility, 'eligible');
    assert.equal(ready.v2Decision.kind, 'finalize-now');
    assert.equal(ready.classification.disposition, 'open');
    delete f.snapshot.derivation;
    assert.equal(observe(f).queue.finalEligibility, 'unknown');
  }
});

test('head/base moves yield distinct stable pairs and preserve original deadlines', () => {
  const f = prepared(fixture()), first = observe(f), deadline = f.entry.patience.deadline;
  f.args.observedAt = time(11); f.args.consumer = { id: 'restarted', build: 'new-build' };
  assert.equal(observe(f).dedupeKey, first.dedupeKey);
  f.snapshot.live.subject.baseSha = 'd'.repeat(40);
  const base = observe(f);
  assert.notEqual(base.dedupeKey, first.dedupeKey);
  assert.equal(base.queue.rebase, 'propose-rebase');
  f.snapshot.live.subject.head = 'e'.repeat(40);
  const head = observe(f);
  assert.equal(head.v2Decision.kind, 'remediate');
  assert.notEqual(head.dedupeKey, base.dedupeKey);
  assert.equal(f.entry.patience.deadline, deadline);
});

for (const [name, invalidate, reason] of [
  ['missing derivation', f => { delete f.snapshot.derivation; }, 'derivation-unverified'],
  ['unverified derivation', f => { f.snapshot.derivation.verified = false; }, 'derivation-unverified'],
  ['missing derivation provenance', f => { delete f.snapshot.derivation.sourceRef; }, 'derivation-unverified'],
  ['mismatched derivation digest', f => { f.snapshot.derivation.receiptDigest = 'foreign'; }, 'derivation-unverified'],
  ['missing identity', f => { delete f.snapshot.identity; }, 'identity-unresolved'],
  ['unresolved identity', f => { f.snapshot.identity.ok = false; }, 'identity-unresolved'],
  ['missing identity provenance', f => { delete f.snapshot.identity.sourceRef; }, 'identity-unresolved'],
  ['missing identity login', f => { delete f.snapshot.identity.login; }, 'identity-unresolved'],
  ['unsupported producer', f => { f.snapshot.identity.producerClass = 'builder'; }, 'identity-unresolved'],
  ['missing publication', f => { f.step('waiting-checks', 5, { rebase: null }); }, 'publication-unverified'],
  ['mismatched publication', f => {
    f.step('waiting-checks', 5, { rebase: { ...f.entry.rebase, publication: { head: 'foreign', base: f.entry.exactBase } } });
  }, 'publication-unverified'],
]) {
  test(`green checks identify withholding cause: ${name}`, () => {
    const f = prepared(fixture());
    invalidate(f);
    const observation = observe(f);
    assert.equal(observation.queue.admission.phase, 'ready');
    assert.equal(observation.queue.checks.kind, 'green');
    assert.equal(observation.queue.finalEligibility, 'unknown');
    assert.equal(observation.v2Decision.kind, 'wait');
    assert.equal(observation.v2Decision.reason, reason);
  });
}

test('predecessor order, holds, terminal subjects, red and missing checks fail closed', () => {
  const f = prepared(fixture());
  const prior = { ...f.entry, entryId: 'q-100', prNumber: 100, readinessSeq: 0, phase: 'ready' };
  f.snapshot.queueEvents.unshift({ type: 'acknowledged', lane: prior.lane, at: time(0), entry: prior });
  assert.equal(observe(f).queue.position, 2);
  assert.equal(observe(f).v2Decision.reason, 'predecessor-active');
  f.snapshot.queueEvents.shift();
  f.snapshot.live.subject.labels = ['no-merge-hold'];
  assert.notEqual(observe(f).v2Decision.kind, 'finalize-now');
  f.snapshot.live.subject.labels = [];
  f.snapshot.live.subject.state = 'merged';
  assert.equal(observe(f).queue.admission.phase, 'closed-observed');
  assert.equal(observe(f).v2Decision.kind, 'wait');
  f.snapshot.live.subject.state = 'open';
  f.snapshot.checks.results[0].conclusion = 'FAILURE';
  assert.equal(observe(f).v2Decision.kind, 'remediate');
  f.snapshot.checks.results = [];
  assert.equal(observe(f).v2Decision.kind, 'wait');
});

test('queue differences require evidence and can be dispositioned in either direction', () => {
  const db = new Database(':memory:'), store = openFinalizationShadowStore({ db });
  try {
    for (const direction of ['v1-defect', 'v2-suspect']) {
      const f = prepared(fixture()); f.args.v1Action.sourceRef = direction;
      const saved = store.append(observe(f));
      assert.equal(saved.classification.disposition, 'open');
      assert.throws(() => store.annotate(saved.id, { disposition: 'resolved', at: time(12) }), /triage requires/);
      store.annotate(saved.id, { disposition: 'resolved', direction, note: 'Evidence inspected; correction verified in fixture', principal: 'operator', at: time(12) });
    }
    const model = buildShadowReport({ observations: store.read(), now: time(20), windowDays: 1 });
    assert.deepEqual(model.divergences.map(d => d.direction), ['v1-defect', 'v2-suspect']);
    assert.ok(model.divergences.every(d => d.evidence.disposition.principal === 'operator'));
  } finally { db.close(); }
});

test('store/fold/read failures return visible unknown escalation without invoking mutation ports', () => {
  const f = prepared(fixture()); let mutations = 0;
  const forbidden = new Proxy({}, { get: () => () => { mutations++; throw new Error('shadow mutation'); } });
  const opts = { ...f.args, entryId: f.entry.entryId, reader: { read: () => f.snapshot },
    shadowStore: { append: () => { throw new Error('offline'); } }, mergeSurface: forbidden, gitAdapter: forbidden,
    runtime: forbidden, owner: forbidden, dispatchAdapter: forbidden };
  const failed = recordQueueShadow(opts);
  assert.equal(failed.persisted, false);
  assert.equal(failed.observation.v2Decision.kind, 'escalate');
  assert.equal(failed.observation.classification.disposition, 'open');
  opts.reader.read = () => { throw new Error('unreadable'); };
  opts.shadowStore.append = o => o;
  const unknown = recordQueueShadow(opts).observation;
  assert.equal(unknown.foldError, true);
  assert.equal(unknown.v2Decision.kind, 'escalate');
  f.snapshot.queueEvents = [{ type: 'progress', entryId: 'missing', patch: {} }];
  assert.equal(observe(f).classification.disposition, 'open');
  assert.equal(mutations, 0);
});

test('duplicate/restart store reads retain pair denominator and readiness age', t => {
  const root = mkdtempSync(join(tmpdir(), 'queue-shadow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fixture(); let store = openFinalizationShadowStore({ rootDir: root });
  const first = store.append(observe(f)); store.close();
  store = openFinalizationShadowStore({ rootDir: root });
  for (let i = 0; i < 20; i++) { f.args.observedAt = time(10 + i); assert.equal(store.append(observe(f)).id, first.id); }
  assert.equal(store.read().length, 1); store.close();
  const reader = openReadOnlyFinalizationShadowStore({ rootDir: root });
  const history = reader.readQueueHistory({ to: time(40) }); reader.close();
  const metrics = buildQueueShadowMetrics([...history, ...history], { from: time(0), to: time(40), source: 'synthetic' });
  assert.equal(metrics.observationPairs, 1);
  assert.equal(metrics.lanes[0].entries, 1);
  assert.equal(metrics.lanes[0].oldestReadyAgeMs, 40_000);
});

test('metrics use exact lifecycle service/parking intervals, returns and tail readiness across windows', () => {
  const f = prepared(fixture());
  f.step('parked-infrastructure', 10); f.step('ready', 20, { readinessSeq: 2 });
  const waiting = observe(f);
  let m = buildQueueShadowMetrics([waiting], { from: time(0), to: time(30), source: 'synthetic' }).lanes[0];
  assert.equal(m.oldestReadyAgeMs, 10_000);
  assert.equal(m.infrastructureWaitMs, 6_000);
  assert.equal(m.infrastructureParkMs, 10_000);
  assert.equal(m.returnsToRemediation, 0);
  f.step('rebasing', 21); f.step('publishing', 22); f.step('waiting-checks', 23); f.step('finalizing', 25); f.step('merged', 30);
  m = buildQueueShadowMetrics([waiting, observe(f)], { from: time(15), to: time(40), source: 'synthetic' }).lanes[0];
  assert.equal(m.arrivals, 0); assert.equal(m.merges, 1); assert.equal(m.serviceTimeSamples, 1);
  assert.equal(m.totalServiceTimeMs, 28_000); assert.equal(m.infrastructureParkMs, 5_000);
  assert.equal(m.mergesPerHour, 3600 / 25);
  const returned = fixture(); returned.step('returned-to-closer', 20);
  m = buildQueueShadowMetrics([observe(returned)], { from: time(0), to: time(30), source: 'synthetic' }).lanes[0];
  assert.equal(m.returnsToRemediation, 1); assert.equal(m.infrastructureParks, 0);
});

test('synthetic observations cannot supply organic promotion coverage', () => {
  const f = fixture(), o = observe(f);
  o.sawHeadMove = true; o.sawExhaustion = true;
  const model = buildShadowReport({ observations: [o], now: time(9 * 86400), windowDays: 10 });
  assert.equal(model.organicHeadMoves, 0); assert.equal(model.exhaustionCloses, 0);
  assert.equal(model.promotable, false);
  const db = new Database(':memory:'), store = openFinalizationShadowStore({ db });
  store.append(o); assert.equal(store.readCoverage().earliestObservedAt, null); db.close();
});

test('probe verifies real schema/read adapter, reports pending organic evidence and never changes a lane', async t => {
  const root = mkdtempSync(join(tmpdir(), 'queue-shadow-probe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const queue = openFinalizationQueueStore({ rootDir: root });
  const { h, e } = queueCleanFixture(101);
  const ack = await createCleanReviewService({ store: queue, now: () => time(0), load: { enabled: false },
    evidenceAdapter: { read: async () => e } }).submit(h);
  assert.throws(() => resolveQueueShadowAdapter({ db: queue.db }), /read-only/);
  const store = openFinalizationShadowStore({ rootDir: root });
  const before = queue.db.prepare('SELECT * FROM finalization_queue_lane').all();
  const ro = new Database(join(root, 'data/reviews.db'), { readonly: true });
  const adapter = resolveQueueShadowAdapter({ db: ro });
  const snapshot = adapter.read(ack.entryId);
  assert.equal(snapshot.receipt.kind, 'clean');
  const pending = probeQueueOwner({ rootDir: root, now: time(10), load: { enabled: false } });
  assert.equal(pending.capabilities.shadow.available, true);
  assert.equal(pending.shadow.lastObservationAt, null);
  assert.equal(pending.shadow.organicEvidence, 'pending');
  const args = fixture().args;
  recordQueueShadow({ ...args, source: 'organic', reader: adapter, shadowStore: store, entryId: ack.entryId,
    snapshot: { live: queueLiveFixture(h) } });
  const observed = probeQueueOwner({ rootDir: root, now: time(10), load: { enabled: false } });
  assert.equal(observed.shadow.lastObservationAt, time(10));
  assert.equal(observed.shadow.organicEvidence, 'observed');
  assert.deepEqual(observed.shadow.consumer, consumer);
  assert.equal(observed.shadow.mode, 'observe'); assert.equal(observed.shadow.noMutation, true);
  assert.ok(observed.runtime.build.startsWith('sha256:'));
  assert.deepEqual(queue.db.prepare('SELECT * FROM finalization_queue_lane').all(), before);
  ro.close(); store.close(); queue.close();
});

test('shadow migration converges the existing store without losing legacy observations', () => {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../migrations/20260718_finalization_shadow.sql', import.meta.url), 'utf8'));
  const store = openFinalizationShadowStore({ db });
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='idx_finalization_shadow_dedupe'").get());
  store.append(observe(fixture())); assert.equal(store.read().length, 1); db.close();
});

// Deterministic barrier places both writers after the tempting pre-read. Compare
// the original append, an insufficient read-before-insert fix, and DB uniqueness.
test('ten consecutive duplicate-writer races per variant measure atomic dedupe', async t => {
  const root = mkdtempSync(join(tmpdir(), 'queue-shadow-race-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = openFinalizationShadowStore({ rootDir: root });
  const path = join(root, 'data/reviews.db');
  const outcomes = {};
  try {
    for (const variant of ['original-append', 'pre-read-only', 'unique-index']) {
      store.db.exec('DROP INDEX IF EXISTS idx_finalization_shadow_dedupe');
      if (variant === 'unique-index') store.db.exec(readFileSync(new URL('../migrations/20261028_finalization_queue_shadow.sql', import.meta.url), 'utf8'));
      let duplicates = 0;
      for (let trial = 0; trial < 10; trial++) {
        const key = `${variant}:${trial}`;
        const gate = new SharedArrayBuffer(4);
        const workers = Array.from({ length: 2 }, () => new Worker(`
          const { parentPort, workerData } = require('node:worker_threads');
          const Database = require(workerData.modulePath);
          const db = new Database(workerData.path);
          db.pragma('busy_timeout = 5000');
          const prior = workerData.variant === 'pre-read-only'
            ? db.prepare("SELECT id FROM finalization_shadow WHERE json_extract(payload_json,'$.dedupeKey')=?").get(workerData.key) : null;
          parentPort.postMessage('ready');
          Atomics.wait(new Int32Array(workerData.gate), 0, 0);
          if (!prior) db.prepare("INSERT INTO finalization_shadow(domain_id,subject_external_id,observed_at,relation,direction,disposition,v1_action_kind,v2_decision_kind,payload_json) VALUES ('code-pr','example/review#101','2026-10-23T00:00:00.000Z','agree','benign','resolved','wait','wait',?) ON CONFLICT DO NOTHING")
            .run(JSON.stringify({ dedupeKey: workerData.key }));
          db.close();
        `, { eval: true, workerData: { path, gate, key, variant,
          modulePath: new URL('../node_modules/better-sqlite3/lib/index.js', import.meta.url).pathname } }));
        const exits = workers.map(w => once(w, 'exit'));
        await Promise.all(workers.map(w => once(w, 'message')));
        Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0, 2);
        await Promise.all(exits);
        const count = store.db.prepare("SELECT COUNT(*) AS n FROM finalization_shadow WHERE json_extract(payload_json,'$.dedupeKey')=?").get(key).n;
        if (count > 1) duplicates++;
        assert.equal(count, variant === 'unique-index' ? 1 : 2);
      }
      outcomes[variant] = duplicates;
      store.db.prepare('DELETE FROM finalization_shadow').run();
    }
    assert.deepEqual(outcomes, { 'original-append': 10, 'pre-read-only': 10, 'unique-index': 0 });
  } finally { store.close(); }
});

test('expiry is a new unknown/escalation pair and repeated expired ticks dedupe', () => {
  const f = prepared(fixture()), before = observe(f);
  f.args.observedAt = time(3600);
  const expired = observe(f);
  assert.equal(expired.v2Decision.kind, 'escalate');
  assert.equal(expired.queue.finalEligibility, 'withheld');
  assert.notEqual(expired.dedupeKey, before.dedupeKey);
  f.args.observedAt = time(3601);
  assert.equal(observe(f).dedupeKey, expired.dedupeKey);
});

test('unknown classifications stay visible/open and synthetic/organic denominators stay separate', () => {
  const f = fixture(), synthetic = observe(f);
  const organic = shadowObserveQueue({ ...f.args, source: 'organic' });
  organic.classification = { relation: 'unknown', disposition: 'resolved' };
  const model = buildShadowReport({ observations: [synthetic, organic], now: time(20), windowDays: 1 });
  assert.equal(model.openDivergences, 1);
  assert.equal(model.divergences[0].disposition, 'open');
  assert.equal(model.queue.organic.lanes[0].entries, 1);
  assert.equal(model.queue.synthetic.lanes[0].entries, 1);
  const noProvenance = shadowObserveQueue({ ...f.args, source: 'organic', v1Action: 'wait' });
  assert.equal(noProvenance.v2Decision.kind, 'escalate');
  assert.equal(noProvenance.classification.disposition, 'open');
});
