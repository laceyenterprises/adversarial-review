import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createQueueCheckReader, classifyQueueChecks, resolveQueueRequiredSet } from '../src/finalization/queue-check-reader.mjs';
import { createQueueChecksService, createQueueInfrastructurePageAdapter } from '../src/finalization/queue-checks.mjs';
import { createQueueRebaseService } from '../src/finalization/queue-rebase.mjs';
import { createQueueOwner } from '../src/finalization/queue-owner.mjs';
import { probeQueueOwner, queueProbeMain } from '../src/finalization/queue-probe.mjs';
import { queuePatience, queueWaitMs } from '../src/finalization/queue-wait.mjs';
import { readQueueEvidence } from '../src/finalization/queue-read.mjs';
import { MAX_TIMER_DELAY_MS } from '../src/load-aware-timeout.mjs';
import { foldQueue } from '../src/finalization/ledger-fold.mjs';
import { gitFixture, admitted, idle } from './helpers/queue-rebase-fixture.mjs';
import { handoffTime } from './helpers/queue-handoff-fixture.mjs';

const high = { enabled: true, loadAvg1m: 1000, cpuCount: 1, cpuBusyPercent: 100 };
const head = 'b'.repeat(40), base = 'c'.repeat(40);
const rules = contexts => ({ complete: true, contexts, sourceRef: 'rules:fixture', version: '1' });
const requiredSet = resolveQueueRequiredSet({ cfg: { requiredCheckContexts: ['unit'] }, rules: rules(['final']) });
const snapshot = (e, results = [{ name: 'unit', head: e.candidate, conclusion: 'SUCCESS' }, { name: 'final', head: e.candidate, conclusion: 'SUCCESS' }]) => ({
  head: e.candidate, base: e.exactBase, requiredSet, results, complete: true, observedAt: handoffTime(0),
});
const runItem = (id, name = 'unit', overrides = {}) => ({ id, name, head_sha: head, status: 'completed', conclusion: 'success',
  created_at: handoffTime(id), html_url: `https://example.invalid/check/${id}`, ...overrides });
function readerFixture({ runs = [], statuses = [], contexts = ['unit'], response, policy } = {}) {
  const calls = [];
  const reader = createQueueCheckReader({ cfg: { requiredCheckContexts: contexts }, load: idle, now: () => handoffTime(0),
    policyAdapter: { read: policy ?? (async () => rules([])) }, request: { read: async req => {
      calls.push(req);
      if (response) return response(req);
      return { body: req.path.includes('/statuses?') ? statuses : { check_runs: runs, total_count: runs.length },
        nextPage: null, sourceRef: req.path };
    } } });
  return { calls, read: () => reader.read({ entry: { candidate: head, exactBase: base, lane: { repository: 'example/review' }, patience: queuePatience(handoffTime(0), idle) } }) };
}

for (const [name, results] of [
  ['last required missing', [{ name: 'unit', head, conclusion: 'success' }]],
  ['old head green', [{ name: 'unit', head: 'a'.repeat(40), conclusion: 'success' }, { name: 'final', head, conclusion: 'success' }]],
  ['empty', []], ['pending', [{ name: 'unit', head, status: 'in_progress', conclusion: 'success' }]],
  ['inconclusive', [{ name: 'unit', head, conclusion: 'unknown' }]],
]) test(`${name} cannot authorize finalization`, () => {
  assert.equal(classifyQueueChecks(snapshot({ candidate: head, exactBase: base }, results)).kind, 'wait');
});

test('required set unions configured and policy names and pins both versions; unknown rules refuse', () => {
  assert.deepEqual(requiredSet.contexts, ['final', 'unit']);
  assert.notEqual(resolveQueueRequiredSet({ cfg: { requiredCheckContexts: ['extra'] }, rules: rules(['final']) }).version, requiredSet.version);
  assert.throws(() => resolveQueueRequiredSet({ cfg: {}, rules: { contexts: [] } }), /unresolved/);
  assert.equal(classifyQueueChecks({ ...snapshot({ candidate: head, exactBase: base }), complete: false }).kind, 'wait');
});

test('all 3 check pages and legacy status pages are read; latest rerun and status win', async () => {
  const calls = [];
  const f = readerFixture({ contexts: ['unit', 'legacy'], response: async req => {
    const page = Number(new URL(req.path, 'https://example.invalid').searchParams.get('page'));
    const status = req.path.includes('/statuses?'); calls.push([status, page]);
    if (status) {
      const body = page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, context: 'legacy', state: 'success', created_at: handoffTime(i + 2), target_url: 'https://example.invalid/status' }))
        : [{ id: 101, context: 'legacy', state: 'pending', created_at: handoffTime(500), target_url: 'https://example.invalid/pending' }];
      return { body, nextPage: page === 1 ? 2 : null, sourceRef: req.path };
    }
    const count = page < 3 ? 100 : 1;
    return { body: { total_count: 201, check_runs: Array.from({ length: count }, (_, i) => runItem((page - 1) * 100 + i + 1, 'unit', { conclusion: page === 3 ? 'failure' : 'success' })) },
      nextPage: page < 3 ? page + 1 : null, sourceRef: req.path };
  } });
  const result = await f.read();
  assert.deepEqual(calls, [[false, 1], [false, 2], [false, 3], [true, 1], [true, 2]]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.equal(result.results.length, 2); assert.equal(result.results[0].id, 201); assert.equal(result.results[1].id, 101);
  assert.equal(classifyQueueChecks(result).kind, 'red'); assert.equal(result.results[0].url, 'https://example.invalid/check/201');
});

for (const [name, response] of [
  ['missing total', () => ({ body: { check_runs: [runItem(1)] }, nextPage: null, sourceRef: 'page' })],
  ['truncated last', () => ({ body: { total_count: 2, check_runs: [runItem(1)] }, nextPage: null, sourceRef: 'page' })],
  ['missing pagination contract', () => ({ body: { total_count: 1, check_runs: [runItem(1)] }, sourceRef: 'page' })],
  ['partial middle', () => ({ body: { total_count: 200, check_runs: [runItem(1)] }, nextPage: 2, sourceRef: 'page' })],
  ['stale SHA', () => ({ body: { total_count: 1, check_runs: [runItem(1, 'unit', { head_sha: 'a'.repeat(40) })] }, nextPage: null, sourceRef: 'page' })],
  ['duplicate runs', () => ({ body: { total_count: 2, check_runs: [runItem(1), runItem(1)] }, nextPage: null, sourceRef: 'page' })],
]) test(`reader refuses ${name}`, async () => { await assert.rejects(readerFixture({ response }).read()); });

test('latest cancelled versus successful reruns and legacy status select by creation, not completion', async () => {
  const result = await readerFixture({ contexts: ['unit', 'legacy'], runs: [runItem(2), runItem(1, 'unit', { conclusion: 'cancelled', completed_at: handoffTime(100) })],
    statuses: [{ id: 1, context: 'legacy', state: 'failure', created_at: handoffTime(1), target_url: 'https://example.invalid/1' },
      { id: 2, context: 'legacy', state: 'success', created_at: handoffTime(2), target_url: 'https://example.invalid/2' }] }).read();
  assert.equal(classifyQueueChecks(result).kind, 'green');
  assert.equal(classifyQueueChecks(await readerFixture({ runs: [runItem(1), runItem(2, 'unit', { conclusion: 'cancelled' })] }).read()).kind, 'red');
});

test('required-set changes mid-pagination stay unreadable', async () => {
  let n = 0;
  await assert.rejects(readerFixture({ runs: [runItem(1)], policy: async () => ({ ...rules([]), version: String(++n) }) }).read(), /changed/);
});

test('no-CI needs explicit configured proof pinned to this candidate', () => {
  const s = { ...snapshot({ candidate: head, exactBase: base }, []), requiredSet: { contexts: [], version: '1' } };
  assert.equal(classifyQueueChecks(s).kind, 'wait');
  s.noCi = { ok: true, configured: true, head, sourceRef: 'existing-no-ci:1' };
  assert.equal(classifyQueueChecks(s).kind, 'green');
  s.noCi.head = 'a'.repeat(40); assert.equal(classifyQueueChecks(s).kind, 'wait');
});

async function published(t, { load = idle, noop = false } = {}) {
  const f = gitFixture(t, { noop }), a = await admitted(f);
  const live = { read: async () => {
    a.live.subject.head = f.g(['--git-dir', f.remote, 'rev-parse', 'topic']);
    a.live.eligibility.primaryChange.headSha = a.live.subject.head;
    return structuredClone(a.live);
  } };
  await createQueueRebaseService({ store: f.store, owner: a.owner, now: f.now, load, liveAdapter: live, gitAdapter: f.adapter }).run({ fence: a.fence, entryId: a.ack.entryId });
  const pages = new Map(); let pageCalls = 0;
  const pageAdapter = createQueueInfrastructurePageAdapter({ env: {}, deliverAlert: async (_text, { payload }) => {
    pageCalls++; pages.set(payload.causeKey, payload); return { id: payload.causeKey, status: 'queued' };
  } });
  const options = { store: f.store, owner: a.owner, now: f.now, load, liveAdapter: live, gitAdapter: f.adapter, pageAdapter,
    checkReader: { read: async ({ entry }) => snapshot(entry) } };
  return { f, a, options, pages, get pageCalls() { return pageCalls; },
    service: (overrides = {}) => createQueueChecksService({ ...options, ...overrides }),
    poll: (overrides = {}) => createQueueChecksService({ ...options, ...overrides }).poll({ fence: a.fence, entryId: a.ack.entryId }) };
}

test('exact green advances to finalizing; local validation stays at its actual signed source head', async t => {
  const p = await published(t); const { f, a } = p;
  const original = f.store.db.prepare('SELECT * FROM finalization_queue_clean_review').get();
  const result = await p.poll();
  assert.equal(result.phase, 'finalizing'); assert.equal(result.checks.head, result.candidate);
  assert.notEqual(result.candidate, f.oldHead);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM finalization_queue_clean_review').get(), original);
  assert.deepEqual(foldQueue(f.store.readEvents(a.h.lane)).entries[result.entryId], result);
});

test('completed red returns to closer and releases lane without paging', async t => {
  const p = await published(t);
  const result = await p.poll({ checkReader: { read: async ({ entry }) => snapshot(entry, [{ name: 'unit', head: entry.candidate, conclusion: 'failure' }]) } });
  assert.equal(result.phase, 'returned-to-closer'); assert.equal(p.f.store.readOwner(result.lane).owner_state, 'idle'); assert.equal(p.pages.size, 0);
});

for (const outage of ['missing', 'hung', 'unreadable', 'credentials']) test(`${outage} retains original deadline, parks without remediation, releases and pages once`, async t => {
  const p = await published(t); const { f, a } = p;
  const initial = f.store.readEntry(a.ack.entryId), patience = initial.patience;
  const reader = { read: async ({ entry }) => {
    if (outage === 'credentials' || outage === 'unreadable') throw new Error('synthetic-outage');
    return snapshot(entry, outage === 'missing' ? [] : [{ name: 'unit', head: entry.candidate, status: 'in_progress' }]);
  } };
  f.clock(1799);
  const waits = [];
  let result = await p.poll({ checkReader: { read: async req => { waits.push(req.timeoutMs); return reader.read(req); } } });
  assert.equal(result.phase, 'waiting-checks'); assert.ok(waits.every(ms => ms <= 1000));
  f.reopen(); a.owner = createQueueOwner({ store: f.store, now: f.now });
  f.clock(1800);
  result = await p.poll({ store: f.store, owner: a.owner, checkReader: reader });
  assert.equal(result.phase, 'parked-infrastructure'); assert.deepEqual(result.patience, patience);
  assert.equal(f.store.readOwner(result.lane).owner_state, 'idle'); assert.equal(p.pageCalls, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM finalization_queue_operation').get().n, 1); // publication only
  const claim = await a.owner.claim({ lane: result.lane, ownerId: 'next', expiresAt: handoffTime(4000) });
  await p.service({ store: f.store, owner: a.owner }).poll({ fence: claim.fence, entryId: result.entryId });
  assert.equal(p.pageCalls, 1); assert.equal(p.pages.size, 1);
  const before = readFileSync(join(f.root, 'data/reviews.db'));
  const probe = probeQueueOwner({ rootDir: f.root, now: f.now(), load: idle });
  assert.equal(probe.capabilities.checks.available, true); assert.ok(probe.runtime.build);
  assert.equal(probe.observations.checks.organicParkingObserved, true);
  assert.deepEqual(readFileSync(join(f.root, 'data/reviews.db')), before);
});

test('base churn invalidates checks without resetting patience; foreign head and terminal PR release without remediation dispatch', async t => {
  for (const state of ['base', 'head', 'closed', 'merged']) {
    const p = await published(t); const entry = p.f.store.readEntry(p.a.ack.entryId);
    const s = structuredClone(p.a.live); s.subject.head = entry.candidate;
    if (state === 'base') s.subject.baseSha = 'd'.repeat(40);
    else if (state === 'head') s.subject.head = 'e'.repeat(40);
    else s.subject.state = state;
    const result = await p.poll({ liveAdapter: { read: async () => s } });
    assert.equal(result.phase, state === 'base' ? 'rebasing' : state === 'head' ? 'returned-to-closer' : 'closed-observed');
    assert.deepEqual(result.patience, entry.patience); assert.equal(result.checks, null);
  }
});

test('reprobe is bounded, checks current holds/proof and readmits after predecessor at FIFO tail with original patience', async t => {
  const p = await published(t); const { f, a } = p;
  f.clock(1800); const parked = await p.poll();
  const second = f.store.acknowledge({ lane: parked.lane, entryId: 'second', head: 'f'.repeat(40), prNumber: 103, admissionGeneration: 1,
    handoffId: 'second-h', ackId: 'second-a', at: f.now(), load: idle });
  let claim = await a.owner.claim({ lane: parked.lane, ownerId: 'reprobe', expiresAt: handoffTime(4000) });
  const reclaim = async () => { claim = await a.owner.claim({ lane: parked.lane, ownerId: 'reprobe', expiresAt: handoffTime(4000) }); };
  const calls = [];
  const service = p.service({ load: high, liveAdapter: { read: async req => { calls.push(req.timeoutMs); return p.options.liveAdapter.read(req); } } });
  assert.equal((await service.reprobe({ fence: claim.fence, entryId: parked.entryId })).phase, 'parked-infrastructure');
  f.clock(1860); await reclaim();
  a.live.subject.labels = ['no-merge-hold'];
  assert.equal((await service.reprobe({ fence: claim.fence, entryId: parked.entryId })).phase, 'parked-infrastructure');
  a.live.subject.labels = [];
  f.clock(1950); await reclaim();
  const result = await service.reprobe({ fence: claim.fence, entryId: parked.entryId });
  assert.equal(result.phase, 'ready'); assert.ok(result.readinessSeq > second.readinessSeq);
  assert.deepEqual(result.patience, parked.patience); assert.ok(calls.every(ms => ms > 0 && ms <= 30_000));
  assert.equal(f.store.readOwner(parked.lane).owner_state, 'idle');
  await reclaim();
  await assert.rejects(service.poll({ fence: claim.fence, entryId: parked.entryId }), /predecessor/);
  assert.equal(p.pageCalls, 1);
});

test('load scales entry patience once, clips effective waits and huge timers, never extends stored deadline', () => {
  const p = queuePatience(handoffTime(0), high);
  assert.equal(p.nominalMs, 1_800_000); assert.equal(p.effectiveMs, 3_600_000); assert.equal(p.ceilingMs, 3_600_000);
  for (let n = 0; n < 10; n++) {
    assert.equal(queueWaitMs(5_000, { ceilingMs: 30_000, deadline: p.deadline, now: handoffTime(3599), load: high }), 1000);
    assert.equal(p.deadline, handoffTime(3600));
  }
  assert.equal(queueWaitMs(Number.MAX_VALUE, { ceilingMs: Number.MAX_VALUE, load: high }), MAX_TIMER_DELAY_MS);
  assert.equal(queueWaitMs(5000, { ceilingMs: 30_000, deadline: p.deadline, now: handoffTime(3600), load: high }), 0);
});

test('real read timer rejects hung adapters, refuses expired budget and caps huge already-sized delays', async () => {
  await assert.rejects(readQueueEvidence({ read: async () => new Promise(() => {}) }, {}, 5), /expired/);
  await assert.rejects(readQueueEvidence({ read: async () => true }, {}, 0), /expired/);
  const warnings = [];
  const warn = w => warnings.push(w); process.on('warning', warn);
  try { assert.equal(await readQueueEvidence({ read: async () => 'ok' }, {}, Number.MAX_VALUE), 'ok'); }
  finally { process.removeListener('warning', warn); }
  assert.equal(warnings.some(w => w.name === 'TimeoutOverflowWarning'), false);
});

test('checks probe fails honestly for absent deployment store', () => {
  const result = probeQueueOwner({ rootDir: '/nonexistent-fixture', now: handoffTime(0), load: idle });
  assert.equal(result.capabilities.checks.available, false); assert.ok(result.runtime.build);
  assert.throws(() => queueProbeMain(['--capability', 'unknown', '--json']), /usage/);
});

test('parking intent survives release/enqueue crashes and keeps the same cause on restart', async t => {
  const p = await published(t); const { f, a } = p;
  f.clock(1800);
  await assert.rejects(p.poll({ owner: { release: async () => { throw new Error('synthetic release crash'); } } }), /release crash/);
  const parked = f.store.readEntry(a.ack.entryId);
  assert.equal(parked.phase, 'parked-infrastructure'); assert.equal(p.pageCalls, 0);
  assert.equal(f.store.db.prepare('SELECT receipt_json FROM finalization_queue_check_page').get().receipt_json, null);
  f.reopen(); a.owner = createQueueOwner({ store: f.store, now: f.now });
  await p.poll({ store: f.store, owner: a.owner });
  assert.equal(p.pageCalls, 1); assert.equal(f.store.readOwner(parked.lane).owner_state, 'idle');
  const pending = f.store.db.prepare('SELECT * FROM finalization_queue_check_page').get();
  assert.equal(pending.cause_key, parked.infrastructure.causeKey); assert.ok(pending.receipt_json);
});

test('late check responses cannot overwrite a newer hold in 10 consecutive races', async t => {
  const p = await published(t); const { f, a } = p;
  // The same waiting-checks entry can receive a fresh admission/hold observation
  // while a read is in flight. Persisted progress versions close the ABA case.
  for (let n = 0; n < 10; n++) {
    let observed, finish;
    const started = new Promise(resolve => { observed = resolve; });
    const blocked = new Promise(resolve => { finish = resolve; });
    const polling = p.poll({ checkReader: { read: async ({ entry }) => { observed(); await blocked; return snapshot(entry); } } });
    await started;
    const entry = f.store.readEntry(a.ack.entryId);
    const held = f.store.progress({ fence: a.fence, entryId: entry.entryId, phase: 'parked-hold', at: f.now(), expectedEntry: entry,
      patch: { reason: `synthetic-hold-${n}` } });
    finish(); await assert.rejects(polling, /superseded/);
    assert.deepEqual(f.store.readEntry(entry.entryId), held);
    let resumed = f.store.progress({ fence: a.fence, entryId: entry.entryId, phase: 'ready', readmit: true, at: f.now(), patch: { reason: 'synthetic-hold-cleared' } });
    for (const phase of ['rebasing', 'publishing', 'waiting-checks']) resumed = f.store.progress({ fence: a.fence, entryId: entry.entryId, phase, at: f.now() });
    assert.equal(resumed.phase, 'waiting-checks');
  }
  t.diagnostic('10/10 consecutive late green responses rejected; newer hold retained');
});

test('recovered published candidate reaches finalizing after tail readmission without a fresh CI wait or new publication', async t => {
  const p = await published(t); const { f, a } = p;
  f.clock(1800); const parked = await p.poll();
  let claim = await a.owner.claim({ lane: parked.lane, ownerId: 'recovery', expiresAt: handoffTime(4000) });
  f.clock(1860);
  const recovered = await p.service().reprobe({ fence: claim.fence, entryId: parked.entryId });
  assert.equal(recovered.phase, 'ready');
  claim = await a.owner.claim({ lane: parked.lane, ownerId: 'recovery', expiresAt: handoffTime(4000) });
  f.reopen(); a.owner = createQueueOwner({ store: f.store, now: f.now });
  const result = await p.service({ store: f.store, owner: a.owner, load: high }).poll({ fence: claim.fence, entryId: parked.entryId });
  assert.equal(result.phase, 'finalizing'); assert.deepEqual(result.patience, parked.patience);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM finalization_queue_operation').get().n, 1);
});

test('a recovered dependency that becomes unavailable parks immediately after original expiry', async t => {
  const p = await published(t); const { f, a } = p;
  f.clock(1800); const parked = await p.poll();
  let claim = await a.owner.claim({ lane: parked.lane, ownerId: 'recovery', expiresAt: handoffTime(4000) });
  f.clock(1860);
  await p.service().reprobe({ fence: claim.fence, entryId: parked.entryId });
  claim = await a.owner.claim({ lane: parked.lane, ownerId: 'recovery', expiresAt: handoffTime(4000) });
  const result = await p.service({ checkReader: { read: async () => { throw new Error('synthetic outage'); } } }).poll({ fence: claim.fence, entryId: parked.entryId });
  assert.equal(result.phase, 'parked-infrastructure'); assert.deepEqual(result.patience, parked.patience);
  assert.equal(p.pageCalls, 1); // same dependency/head/base/reason
  assert.equal(f.store.readOwner(parked.lane).owner_state, 'idle');
});

test('persisted high-load patience survives restart, polls and base churn without compounding', async t => {
  const f = gitFixture(t);
  const lane = { repository: 'example/review', base: 'main' };
  const first = f.store.acknowledge({ lane, entryId: 'high-load', prNumber: 101, head, admissionGeneration: 1,
    handoffId: 'high-load-h', ackId: 'high-load-a', at: f.now(), load: high });
  assert.equal(first.patience.effectiveMs, 3_600_000);
  f.reopen();
  const owner = createQueueOwner({ store: f.store, now: f.now });
  const { fence } = await owner.claim({ lane, ownerId: 'load-owner', expiresAt: handoffTime(4000) });
  for (const phase of ['ready', 'rebasing', 'publishing', 'waiting-checks', 'rebasing']) {
    const entry = f.store.progress({ fence, entryId: first.entryId, phase, at: f.now(), patch: { exactBase: base } });
    assert.deepEqual(entry.patience, first.patience);
  }
  f.clock(3599); let requested;
  const request = createQueueCheckReader({ cfg: { requiredCheckContexts: ['unit'] }, load: high, now: f.now,
    policyAdapter: { read: async req => { requested = req.timeoutMs; return rules([]); } },
    request: { read: async req => ({ body: req.path.includes('/statuses?') ? [] : { total_count: 0, check_runs: [] }, nextPage: null, sourceRef: req.path }) } });
  await request.read({ entry: { ...first, candidate: head, exactBase: base } });
  assert.equal(requested, 1000); assert.equal(f.store.readEntry(first.entryId).patience.deadline, handoffTime(3600));
});

test('no-op recovery retains ordinary current-head review currency instead of borrowing a derivation exception', async t => {
  const p = await published(t, { noop: true }); const { f, a } = p;
  f.clock(1800); const parked = await p.poll();
  assert.equal(parked.candidate, parked.head);
  const claim = await a.owner.claim({ lane: parked.lane, ownerId: 'noop-recovery', expiresAt: handoffTime(4000) });
  f.clock(1860); a.live.currentReview.verdict = 'request-changes';
  const result = await p.service().reprobe({ fence: claim.fence, entryId: parked.entryId });
  assert.equal(result.phase, 'returned-to-closer'); assert.equal(result.reason, 'current-head-review-not-clean');
  assert.equal(f.store.readOwner(result.lane).owner_state, 'idle');
});

for (const state of ['closed', 'merged']) test(`a ${state} observation after recovery proof reconciles without a new ready entry`, async t => {
  const p = await published(t); const { f, a } = p;
  f.clock(1800); const parked = await p.poll();
  const claim = await a.owner.claim({ lane: parked.lane, ownerId: 'late-terminal', expiresAt: handoffTime(4000) });
  f.clock(1860); let reads = 0;
  const result = await p.service({ liveAdapter: { read: async req => {
    if (++reads === 2) a.live.subject.state = state;
    return p.options.liveAdapter.read(req);
  } } }).reprobe({ fence: claim.fence, entryId: parked.entryId });
  assert.equal(result.phase, 'closed-observed'); assert.equal(result.readinessSeq, parked.readinessSeq);
  assert.equal(f.store.readOwner(result.lane).owner_state, 'idle');
});
