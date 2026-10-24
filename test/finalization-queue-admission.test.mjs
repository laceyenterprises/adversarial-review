import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openFinalizationQueueStore } from '../src/finalization/queue-store.mjs';
import { createQueueOwner } from '../src/finalization/queue-owner.mjs';
import { createQueueHandoffService } from '../src/finalization/queue-handoff-store.mjs';
import { createCleanReviewService } from '../src/finalization/queue-clean-review.mjs';
import { createQueueAdmissionService } from '../src/finalization/queue-admission.mjs';
import { foldQueue } from '../src/finalization/ledger-fold.mjs';
import { probeQueueOwner } from '../src/finalization/queue-probe.mjs';
import { queueWaitMs } from '../src/finalization/queue-wait.mjs';
import { MAX_TIMER_DELAY_MS } from '../src/load-aware-timeout.mjs';
import { queueHandoffFixture, handoffTime as time } from './helpers/queue-handoff-fixture.mjs';
import { queueCleanFixture, queueLiveFixture } from './helpers/queue-clean-fixture.mjs';
const lane = { repository: 'example/review', base: 'main' };
const idle = { enabled: false };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mgq-admit-'));
  let store = openFinalizationQueueStore({ rootDir: root }), clock = time(0);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, get store() { return store; }, now: () => clock, clock: n => { clock = time(n); },
    reopen() { store.close(); store = openFinalizationQueueStore({ rootDir: root }); } };
}
async function submit(f, kind = 'clean', pr = 102, reviewId) {
  const { h, e } = (kind === 'clean' ? queueCleanFixture : queueHandoffFixture)(pr);
  if (reviewId !== undefined) { h.sourceReview.id = reviewId; e.review.id = reviewId; }
  const service = (kind === 'clean' ? createCleanReviewService : createQueueHandoffService)({ store: f.store,
    now: f.now, load: idle, evidenceAdapter: { read: async () => e } });
  const ack = await service.submit(h);
  return { h, e, ack, service, entry: f.store.readEntry(ack.entryId), live: queueLiveFixture(h) };
}
async function owner(f) {
  return (await createQueueOwner({ store: f.store, now: f.now }).claim({ lane, ownerId: 'owner', expiresAt: time(4000) })).fence;
}
const admission = (f, read, load = idle) => createQueueAdmissionService({ store: f.store, now: f.now, load,
  liveAdapter: { read } });

test('10 independent mixed-source contention trials acknowledge each admission exactly once in shared FIFO', async t => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) {
    const specs = ['clean', 'remediated', 'clean', 'remediated'].map(kind => ({
      root: f.root, kind, ...(kind === 'clean' ? queueCleanFixture : queueHandoffFixture)(100 + i * 2 + (kind === 'clean' ? 0 : 1)),
    }));
    const workers = specs.map(s => fork(fileURLToPath(new URL('./helpers/queue-admission-client.mjs', import.meta.url)), [JSON.stringify(s)], {
      execArgv: ['--preserve-symlinks', '--preserve-symlinks-main'], env: { ...process.env, NODE_TEST_CONTEXT: '' },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    }));
    const exits = workers.map(w => once(w, 'exit'));
    await Promise.all(workers.map(w => once(w, 'message')));
    const reading = workers.map(w => once(w, 'message'));
    workers.forEach(w => w.send('submit')); await Promise.all(reading);
    const replies = workers.map(w => once(w, 'message').then(([m]) => m));
    workers.forEach(w => w.send('commit'));
    const results = await Promise.all(replies); await Promise.all(exits);
    assert.equal(results.some(r => r.error), false, JSON.stringify(results));
    assert.equal(results[0].entryId, results[2].entryId); assert.equal(results[1].entryId, results[3].entryId);
    const entries = f.store.entries(lane);
    assert.equal(entries.length, (i + 1) * 2);
    assert.deepEqual(entries.map(e => e.readinessSeq), Array.from({ length: entries.length }, (_, n) => n + 1));
    f.reopen();
    assert.deepEqual(f.store.entries(lane), entries);
  }
  t.diagnostic('fixed: 10/10 consecutive four-process mixed-source trials; zero duplicate entries or sequence gaps');
});

for (const first of ['clean', 'remediated']) test(`${first} readiness cannot be bypassed by the other source`, async t => {
  const f = fixture(t), a = await submit(f, first, 101), b = await submit(f, first === 'clean' ? 'remediated' : 'clean', 102);
  const fence = await owner(f);
  const service = admission(f, async ({ entry }) => entry.prNumber === 101 ? a.live : b.live);
  assert.equal((await service.reconcile({ fence, entryId: b.entry.entryId })).phase, 'acknowledged');
  assert.equal((await service.reconcile({ fence, entryId: a.entry.entryId })).phase, 'ready');
  assert.deepEqual(service.order(lane).actionable.map(e => e.prNumber), [101, 102]);
});

for (const labels of [['no-merge-hold'], [{ name: 'do-not-merge' }], ['merge-agent-skip'], null, [{}]]) {
  test(`live holds/unknown labels park outside FIFO: ${JSON.stringify(labels)}`, async t => {
    const f = fixture(t), a = await submit(f), b = await submit(f, 'remediated', 103), fence = await owner(f);
    a.live.subject.labels = labels;
    const service = admission(f, async ({ entry }) => entry.prNumber === 102 ? a.live : b.live);
    const parked = await service.reconcile({ fence, entryId: a.entry.entryId });
    assert.equal(parked.phase, 'parked-hold');
    assert.equal(service.order(lane).actionable[0].prNumber, 103);
    assert.equal((await service.reconcile({ fence, entryId: b.entry.entryId })).phase, 'ready');
    a.live.subject.labels = [];
    const recovered = await service.reconcile({ fence, entryId: a.entry.entryId });
    assert.equal(recovered.readinessSeq, 3); assert.deepEqual(recovered.patience, a.entry.patience);
    assert.equal(f.store.readEvents(lane).filter(e => e.type === 'acknowledged').length, 2);
    assert.deepEqual(await a.service.submit(a.h), recovered);
    f.reopen(); assert.equal(f.store.entries(lane).at(-1).prNumber, 102);
  });
}

for (const state of ['closed', 'merged']) test(`live ${state} reconciles without a review or closer`, async t => {
  const f = fixture(t), a = await submit(f), fence = await owner(f);
  const live = { subject: { lane, prNumber: 102, state, sourceRef: 'terminal:1' } };
  const result = await admission(f, async () => live).reconcile({ fence, entryId: a.entry.entryId });
  assert.equal(result.phase, 'closed-observed'); assert.equal(result.reason, `live-${state}`);
  assert.equal(result.delivery, null, 'observation does not assert a queue merge receipt');
});

test('external author head returns for fresh adjudication; repairs join tail with new immutable history', async t => {
  const f = fixture(t), a = await submit(f), b = await submit(f, 'remediated', 103), fence = await owner(f);
  a.live.subject.head = 'd'.repeat(40);
  assert.equal((await admission(f, async () => a.live).reconcile({ fence, entryId: a.entry.entryId })).phase, 'returned-to-closer');
  a.h.admissionGeneration++; a.h.handoffId += ':repaired';
  const repaired = await a.service.submit(a.h);
  assert.equal(repaired.readinessSeq, 3); assert.notEqual(repaired.entryId, a.entry.entryId);
  assert.deepEqual(f.store.entries(lane).map(e => e.entryId), [a.entry.entryId, b.entry.entryId, repaired.entryId]);
});

test('clean admissions require final current-head read; terminal full coverage never asks for a review', async t => {
  const f = fixture(t), a = await submit(f), b = await submit(f, 'remediated', 103), fence = await owner(f);
  delete a.live.currentReview; delete b.live.currentReview;
  const service = admission(f, async ({ kind }) => kind === 'clean' ? a.live : b.live);
  assert.equal((await service.reconcile({ fence, entryId: a.entry.entryId })).reason, 'current-head-review-unavailable');
  assert.equal((await service.reconcile({ fence, entryId: b.entry.entryId })).phase, 'ready');
});

for (const [field, value, phase] of [
  ['identity', null, 'parked-infrastructure'], ['permission', { canPush: false, sourceRef: 'rights:1' }, 'parked-permission'],
  ['eligibility', null, 'parked-infrastructure'],
]) test(`unreadable or denied ${field} refuses admission`, async t => {
  const f = fixture(t), a = await submit(f), fence = await owner(f); a.live[field] = value;
  assert.equal((await admission(f, async () => a.live).reconcile({ fence, entryId: a.entry.entryId })).phase, phase);
});

test('shared structural policy retains branch rules, primary change and duplicate-family holds', async t => {
  const f = fixture(t), a = await submit(f), fence = await owner(f);
  a.live.eligibility.branchProtectionRequired = true;
  const service = admission(f, async () => a.live);
  assert.equal((await service.reconcile({ fence, entryId: a.entry.entryId })).reason, 'branch-protection-missing-gate');
  a.live.eligibility.branchProtectionRequired = false; delete a.live.eligibility.primaryChange;
  assert.equal((await service.reconcile({ fence, entryId: a.entry.entryId })).reason, 'primary-change-unknown');
});

for (const [cost, reason] of [
  [null, 'ci-cost-read-failed'], [{ failedCheck: true }, 'ci-cost-check-failed'],
  [{ ok: false }, 'ci-cost-unauthorized'],
]) test(`conflict returns its own diagnostic despite preceding ${reason}`, async t => {
  const previous = process.env.AMA_CI_COST_MODE;
  process.env.AMA_CI_COST_MODE = 'blocking';
  t.after(() => { if (previous === undefined) delete process.env.AMA_CI_COST_MODE; else process.env.AMA_CI_COST_MODE = previous; });
  const f = fixture(t), a = await submit(f), fence = await owner(f);
  a.live.eligibility.primaryChange.ciCost = cost && { headSha: a.h.head, ...cost };
  a.live.eligibility.branchProtectionRequired = true;
  const service = admission(f, async () => a.live);
  const parked = await service.reconcile({ fence, entryId: a.entry.entryId });
  assert.equal(parked.phase, 'parked-infrastructure'); assert.equal(parked.reason, reason);
  a.live.eligibility.mergeable = 'CONFLICTING';
  const result = await service.reconcile({ fence, entryId: a.entry.entryId });
  assert.equal(result.phase, 'returned-to-closer'); assert.equal(result.reason, 'pr-not-mergeable');
  f.reopen();
  assert.deepEqual(f.store.readEntry(result.entryId), result);
  assert.deepEqual(foldQueue(f.store.readEvents(lane)).entries[result.entryId], result);
});

test('primary reversion retains its diagnostic alongside conflict and missing branch rules', async t => {
  const f = fixture(t), a = await submit(f), fence = await owner(f);
  Object.assign(a.live.eligibility, { branchProtectionRequired: true, mergeable: 'CONFLICTING', primaryChange: {
    headSha: a.h.head, hasHammerCommits: true, primaryHead: 'a'.repeat(40), mergeBase: 'c'.repeat(40),
    ciCost: { headSha: a.h.head, ok: true },
    primaryFiles: [{ filename: 'src/feature.mjs', status: 'added', additions: 1, deletions: 0,
      patch: '@@ -0,0 +1 @@\n+feature();' }], finalFiles: [],
  } });
  const result = await admission(f, async () => a.live).reconcile({ fence, entryId: a.entry.entryId });
  assert.equal(result.phase, 'returned-to-closer'); assert.equal(result.reason, 'primary-change-reverted');
});

for (const labels of [['duplicate-family-hold'], [{ name: 'duplicate-family-hold' }]]) {
  test(`duplicate-family hold remains enforced for ${JSON.stringify(labels)}`, async t => {
    const f = fixture(t), a = await submit(f), fence = await owner(f);
    a.live.subject.labels = labels;
    const result = await admission(f, async () => a.live).reconcile({ fence, entryId: a.entry.entryId });
    assert.equal(result.phase, 'parked-infrastructure'); assert.equal(result.reason, 'duplicate-family-unresolved');
  });
}

for (const uppercase of ['subject', 'review', 'primaryChange']) {
  test(`equivalent ${uppercase} SHA casing and numeric review ID admit the same clean head`, async t => {
    const f = fixture(t), a = await submit(f, 'clean', 102, '12345'), fence = await owner(f);
    a.live.currentReview.id = 12345;
    if (uppercase === 'subject') a.live.subject.head = a.h.head.toUpperCase();
    if (uppercase === 'review') a.live.currentReview.commitId = a.h.head.toUpperCase();
    if (uppercase === 'primaryChange') a.live.eligibility.primaryChange.headSha = a.h.head.toUpperCase();
    const before = structuredClone(a.live);
    const result = await admission(f, async () => a.live).reconcile({ fence, entryId: a.entry.entryId });
    assert.equal(result.phase, 'ready'); assert.deepEqual(a.live, before, 'trusted evidence remains unchanged');
  });
}

for (const [field, value, reason] of [
  ['id', 'foreign-review', 'current-head-review-not-clean'],
  ['commitId', 'f'.repeat(40), 'current-head-review-not-clean'],
  ['commitId', null, 'current-head-review-not-clean'],
  ['primaryHead', 'f'.repeat(40), 'primary-change-read-failed'],
]) test(`identity normalization still refuses ${field}=${value}`, async t => {
  const f = fixture(t), a = await submit(f), fence = await owner(f);
  if (field === 'primaryHead') a.live.eligibility.primaryChange.headSha = value;
  else a.live.currentReview[field] = value;
  const result = await admission(f, async () => a.live).reconcile({ fence, entryId: a.entry.entryId });
  assert.equal(result.reason, reason); assert.notEqual(result.phase, 'ready');
});

test('20 ABA recovery trials refuse late observations and preserve deadline/order across restart', async t => {
  const f = fixture(t), a = await submit(f), fence = await owner(f);
  let staleReadmissions = 0;
  for (let i = 0; i < 20; i++) {
    a.live.subject.labels = ['no-merge-hold'];
    const service = admission(f, async () => structuredClone(a.live));
    await service.reconcile({ fence, entryId: a.entry.entryId });
    let release, started;
    const reading = new Promise(resolve => { started = resolve; });
    const late = admission(f, async () => { started(); return await new Promise(resolve => { release = resolve; }); });
    const pending = late.reconcile({ fence, entryId: a.entry.entryId }); await reading;
    a.live.subject.labels = []; await service.reconcile({ fence, entryId: a.entry.entryId });
    a.live.subject.labels = ['no-merge-hold'];
    const held = await service.reconcile({ fence, entryId: a.entry.entryId });
    const staleLive = structuredClone(a.live); staleLive.subject.labels = []; release(staleLive);
    const result = await pending;
    if (result.phase !== 'parked-hold' || result.readinessSeq !== held.readinessSeq) staleReadmissions++;
    assert.deepEqual(result.patience, a.entry.patience);
    f.reopen();
    assert.deepEqual(foldQueue(f.store.readEvents(lane)).entries[result.entryId], f.store.readEntry(result.entryId));
  }
  assert.equal(staleReadmissions, 0);
  t.diagnostic('fixed: 20/20 consecutive stale-recovery refusals across reopen; 0 duplicate tail allocations');
});

test('clean admission rejects nonzero findings, invalid signatures and stale reviews atomically', async t => {
  const f = fixture(t);
  for (const mutate of [e => { e.review.findings = [{}]; }, e => { e.attestations.reviewed.valid = false; },
    e => { e.review.commitId = 'f'.repeat(40); }]) {
    const { h, e } = queueCleanFixture(); mutate(e);
    const service = createCleanReviewService({ store: f.store, now: f.now, load: idle, evidenceAdapter: { read: async () => e } });
    await assert.rejects(service.submit(h)); assert.equal(f.store.entries(lane).length, 0);
  }
});

test('admission waits scale once, clip remaining budget and retain finite/timer ceilings', async t => {
  const f = fixture(t), a = await submit(f), fence = await owner(f), seen = [];
  const load = { enabled: true, maxMultiplier: 1000, loadAvg1m: 1e6, cpuCount: 1, cpuBusyPercent: 100 };
  const service = admission(f, async args => { seen.push(args.timeoutMs); return a.live; }, load);
  await service.reconcile({ fence, entryId: a.entry.entryId });
  assert.equal(seen[0], 30_000);
  await service.reconcile({ fence, entryId: a.entry.entryId, deadline: new Date(Date.parse(time(0)) + 7).toISOString() });
  assert.equal(seen[1], 7);
  assert.equal(queueWaitMs(1e12, { ceilingMs: 1e13, load }), MAX_TIMER_DELAY_MS);
  f.clock(1801); const parked = await service.reconcile({ fence, entryId: a.entry.entryId });
  assert.equal(parked.reason, 'admission-deadline-expired'); assert.equal(seen.length, 2);
  assert.deepEqual(parked.patience, a.entry.patience);
});

test('clean evidence wait aborts at its clipped deadline without admitting late evidence', async t => {
  const f = fixture(t), { h, e } = queueCleanFixture(); let signal, supplied;
  const service = createCleanReviewService({ store: f.store, now: f.now, load: idle, evidenceAdapter: { read: async args => {
    signal = args.signal; supplied = args.timeoutMs; return await new Promise(() => {});
  } } });
  await assert.rejects(service.submit(h, { deadline: new Date(Date.parse(time(0)) + 5).toISOString() }), /deadline expired/);
  assert.equal(supplied, 5); assert.equal(signal.aborted, true); assert.equal(f.store.entries(lane).length, 0);
  const high = { enabled: true, maxMultiplier: 1000, loadAvg1m: 1e6, cpuCount: 1, cpuBusyPercent: 100 };
  const normal = createCleanReviewService({ store: f.store, now: f.now, load: high, evidenceAdapter: { read: async args => {
    assert.equal(args.timeoutMs, 30_000); return e;
  } } });
  const entry = await normal.submit(h); assert.equal(entry.patience.effectiveMs, 3_600_000);
});

test('admission probe resolves actual schema/adapters/counts and never writes', async t => {
  const f = fixture(t);
  let probe = probeQueueOwner({ rootDir: f.root, load: idle });
  assert.equal(probe.capabilities.admission.available, true); assert.ok(probe.runtime.build);
  assert.equal(probe.observations.admission.organicAdmissionObserved, false);
  const a = await submit(f), fence = await owner(f);
  await admission(f, async () => a.live).reconcile({ fence, entryId: a.entry.entryId });
  const before = f.store.db.prepare('SELECT * FROM finalization_queue_event').all();
  const files = readdirSync(join(f.root, 'data')).sort();
  probe = probeQueueOwner({ rootDir: f.root, load: idle });
  assert.deepEqual(probe.observations.admission, { clean: 1, remediated: 0, unvalidated: 0,
    actionable: 1, parked: 0, terminal: 0, observed: 1, sampledReceipts: 1, sampleLimit: 100, organicAdmissionObserved: true });
  assert.deepEqual(f.store.db.prepare('SELECT * FROM finalization_queue_event').all(), before);
  assert.deepEqual(readdirSync(join(f.root, 'data')).sort(), files);
  assert.ok(readFileSync(join(f.root, 'data', 'reviews.db')).length);
  f.store.db.exec('DROP TABLE finalization_queue_clean_review');
  assert.equal(probeQueueOwner({ rootDir: f.root, load: idle }).capabilities.admission.available, false);
});


test('deadline crossing while acquiring the DB writer cannot readmit an entry', async t => {
  const f = fixture(t), a = await submit(f), fence = await owner(f);
  const original = f.store.tx;
  f.store.tx = fn => { f.clock(1801); return original(fn); };
  const result = await admission(f, async () => a.live).reconcile({ fence, entryId: a.entry.entryId });
  assert.equal(result.reason, 'admission-deadline-expired');
  assert.deepEqual(result.patience, a.entry.patience);
});

test('corrupt receipt cannot hide an authoritative terminal lifecycle observation', async t => {
  const f = fixture(t), a = await submit(f), fence = await owner(f);
  f.store.db.prepare("UPDATE finalization_queue_clean_review SET evidence_json='{}'").run();
  a.live.subject.state = 'merged';
  assert.equal((await admission(f, async () => a.live).reconcile({ fence, entryId: a.entry.entryId })).reason, 'live-merged');
});


test('progress version fences a same-timestamp ABA with identical parked observations', async t => {
  const f = fixture(t), a = await submit(f), fence = await owner(f);
  const progress = (phase, extra = {}) => f.store.progress({ fence, entryId: a.entry.entryId, phase, at: time(0), ...extra });
  progress('parked-hold'); const snapshot = f.store.readEntry(a.entry.entryId);
  progress('parked-permission'); progress('parked-hold');
  assert.throws(() => progress('ready', { readmit: true, expectedEntry: snapshot }), /observation superseded/);
  assert.equal(f.store.readEntry(a.entry.entryId).readinessSeq, 1);
});


test('empty terminal envelope cannot bypass the normal final current-head review read', async t => {
  const f = fixture(t), { h, e } = queueHandoffFixture();
  h.dispositions = []; e.review.findings = [];
  const ack = await createQueueHandoffService({ store: f.store, now: f.now, load: idle,
    evidenceAdapter: { read: async () => e } }).submit(h);
  const live = queueLiveFixture(h); delete live.currentReview;
  const fence = await owner(f);
  assert.equal((await admission(f, async () => live).reconcile({ fence, entryId: ack.entryId })).reason,
    'current-head-review-unavailable');
});

test('moderate load sizes each nominal read once rather than scaling its result again', async t => {
  const f = fixture(t), a = await submit(f), fence = await owner(f);
  const load = { enabled: true, maxMultiplier: 4, loadAvg1m: 2, cpuCount: 1, cpuBusyPercent: 100 };
  const expected = queueWaitMs(5_000, { ceilingMs: 30_000, load });
  assert.ok(expected > 5_000 && expected < 30_000);
  await admission(f, async args => { assert.equal(args.timeoutMs, expected); return a.live; }, load)
    .reconcile({ fence, entryId: a.entry.entryId });
  const { h, e } = queueCleanFixture(104);
  await createCleanReviewService({ store: f.store, now: f.now, load, evidenceAdapter: { read: async args => {
    assert.equal(args.timeoutMs, expected); return e;
  } } }).submit(h);
});


test('deployed admission CLI emits real capability/build observations without creating work', t => {
  const f = fixture(t);
  const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../src/finalization/queue-probe.mjs', import.meta.url)),
    '--capability', 'admission', '--json', '--root', f.root], { encoding: 'utf8', timeout: 10_000 }));
  assert.equal(result.capabilities.admission.available, true); assert.ok(result.runtime.build);
  assert.equal(result.observations.admission.organicAdmissionObserved, false);
  assert.equal(f.store.entries(lane).length, 0); assert.equal(f.store.readOwner(lane), null);
});
