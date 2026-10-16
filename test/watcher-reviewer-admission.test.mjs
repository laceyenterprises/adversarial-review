import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewerAdmissionQueue } from '../src/watcher-reviewer-admission.mjs';
import { createDetachedReviewerDispatchTracker } from '../src/watcher-reviewer-pool.mjs';
import { createReviewerDispatchDrain } from '../src/watcher-reviewer-dispatch.mjs';
import Database from 'better-sqlite3';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { createDurableReviewerRefill } from '../src/watcher-reviewer-refill.mjs';

const quiet = { log() {}, warn() {}, error() {} };
const flush = async () => { for (let turn = 0; turn < 40; turn++) await Promise.resolve(); };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 1000;
  const scheduled = [], logs = [], starts = [], completions = [];
  const admission = createReviewerAdmissionQueue({
    now: () => now, schedule: callback => scheduled.push(callback),
    logger: { ...quiet, log: line => logs.push(line) },
  });
  const tracker = createDetachedReviewerDispatchTracker({ onCapacityFreed: admission.capacityFreed, logger: quiet });
  let concurrentDrains = 0, maxDrains = 0, active = 0, maxActive = 0;
  let beforeDrain = async () => {};
  const drain = createReviewerDispatchDrain({
    reviewerPoolConfig: { enabled: true, maxConcurrent: 3 },
    reviewerDispatchCandidates: admission.candidates,
    detachedReviewerDispatchTracker: tracker,
    readWatcherDrainState: () => ({ active: false }),
    resolveGeminiCredentialConcurrencyForDispatchCandidates: async () => 1,
    prepareSpillover: async candidates => candidates,
    singleWaveSettleGraceMs: 0, logger: quiet,
  });
  admission.setDrain(async () => {
    concurrentDrains++;
    maxDrains = Math.max(maxDrains, concurrentDrains);
    try {
      await beforeDrain();
      return await drain('test');
    } finally { concurrentDrains--; }
  });
  function candidate(prNumber, hasPriorPostedReview = false, headSha = `head-${prNumber}`) {
    const completion = deferred();
    completions.push(completion);
    return {
      repoPath: 'example/review-fixture', prNumber, reviewerModel: 'gemini',
      hasPriorPostedReview, subject: { headSha },
      async run() {
        this.markAdmissionStarted();
        starts.push(prNumber);
        active++; maxActive = Math.max(maxActive, active);
        await completion.promise;
        active--;
      },
    };
  }
  function enqueue(...args) { admission.enqueue(candidate(...args)); }
  async function launchWave() {
    await flush(); t.mock.timers.tick(0); await flush();
  }
  async function schedulerTick() {
    now++;
    for (const callback of scheduled.splice(0)) callback();
    await launchWave();
  }
  return { admission, tracker, enqueue, candidate, completions, starts, logs, launchWave, schedulerTick,
    blockDrain: gate => { beforeDrain = () => gate.promise; },
    counts: () => ({ active, maxActive, maxDrains }), scheduled };
}

test('SEATIDLE-01: one scheduler tick hands the seat to queued first passes and rereviews during a blocked poll', async t => {
  const f = fixture(t);
  f.enqueue(201); f.enqueue(202, true); f.enqueue(203); f.enqueue(204, true);
  let pollFinished = false;
  const pollGate = deferred();
  const poll = (async () => { await f.admission.drain('poll'); await pollGate.promise; pollFinished = true; })();
  await f.launchWave();
  assert.deepEqual(f.starts, [201]);
  assert.equal(f.admission.candidates.length, 3);
  f.completions[0].resolve(); await flush(); await f.schedulerTick();
  assert.equal(pollFinished, false);
  assert.equal(f.starts.length, 2);
  assert.equal(f.counts().maxActive, 1);
  assert.match(f.logs[0], /reviewer admission on capacity-freed: dispatched=1 idle_ms=1$/);
  // The poll remains blocked through another completion and direct handoff.
  const second = f.starts[1] - 201;
  f.completions[second].resolve(); await flush(); await f.schedulerTick();
  assert.equal(f.starts.length, 3);
  assert.equal(pollFinished, false);
  pollGate.resolve(); await poll;
  for (const completion of f.completions) completion.resolve();
  await flush();
});

test('SEATIDLE-01: overlapping poll and capacity drains serialize without duplicate dispatch or credential oversubscription', async t => {
  const f = fixture(t);
  f.enqueue(201); f.enqueue(202); f.enqueue(203);
  const gate = deferred(); f.blockDrain(gate);
  const pollDrain = f.admission.drain('poll');
  await flush();
  f.admission.capacityFreed();
  await f.schedulerTick();
  gate.resolve(); await f.launchWave(); await pollDrain;
  await f.launchWave();
  assert.deepEqual(f.starts, [201]);
  assert.deepEqual(f.counts(), { active: 1, maxActive: 1, maxDrains: 1 });
  f.completions[0].resolve(); await flush(); await f.schedulerTick();
  assert.deepEqual(f.starts, [201, 202]);
  assert.equal(new Set(f.starts).size, f.starts.length);
  assert.equal(f.counts().maxActive, 1);
  for (const completion of f.completions) completion.resolve();
  await flush();
});

test('SEATIDLE-01: queue refresh preserves FIFO and an empty handoff waits for discovery', async t => {
  const f = fixture(t);
  f.admission.capacityFreed(); await f.schedulerTick();
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.logs, [], 'empty capacity handoffs do not log admissions');
  f.enqueue(201); f.enqueue(202); f.enqueue(201);
  assert.deepEqual(f.admission.candidates.map(c => c.prNumber), [201, 202]);
  const drain = f.admission.drain('new poll'); await f.launchWave(); await drain;
  assert.deepEqual(f.admission.candidates.map(c => c.prNumber), [202]);
  for (const completion of f.completions) completion.resolve();
  await flush(); await f.schedulerTick();
  assert.deepEqual(f.starts, [201, 202]);
});

test('SEATIDLE-01: a refused candidate does not log a successful capacity handoff', async t => {
  const f = fixture(t);
  f.admission.enqueue({
    repoPath: 'example/review-fixture', prNumber: 201, reviewerModel: 'gemini',
    async run() { return { dispatched: false, reason: 'freshness-read-deferred' }; },
  });
  f.admission.capacityFreed(); await f.schedulerTick();
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.logs, [], 'queue attempts that never spawn do not log admissions');
});

test('SEATIDLE-01: a slow pre-spawn refusal hands capacity to the next candidate without a poll', async t => {
  const f = fixture(t);
  const refusal = deferred();
  f.admission.enqueue({
    repoPath: 'example/review-fixture', prNumber: 200, reviewerModel: 'gemini',
    async run() {
      await refusal.promise;
      return { dispatched: false, reason: 'head-moved-before-spawn' };
    },
  });
  f.enqueue(201);
  f.admission.capacityFreed(); await f.schedulerTick();
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.admission.candidates.map(c => c.prNumber), [201]);
  refusal.resolve(); await flush(); await f.schedulerTick();
  assert.deepEqual(f.starts, [201]);
  assert.equal(f.counts().maxActive, 1);
  f.completions[0].resolve(); await flush();
});


test('SEATIDLE-01: discovery queues a newer head while the previous head still owns the seat', async t => {
  const f = fixture(t);
  f.enqueue(201);
  const drain = f.admission.drain('poll'); await f.launchWave(); await drain;
  f.enqueue(201, true, 'newer-head');
  assert.deepEqual(f.admission.candidates.map(c => c.subject.headSha), ['newer-head']);
  f.completions[0].resolve(); await flush(); await f.schedulerTick();
  assert.deepEqual(f.starts, [201, 201]);
  assert.equal(f.counts().maxActive, 1);
  f.completions[1].resolve(); await flush();
});

test('SEATIDLE-03: gap measures the durable post through settlement and a later poll spawn', async () => {
  let now = 10_000;
  const logs = [], scheduled = [];
  const admission = createReviewerAdmissionQueue({ now: () => now,
    logger: { ...quiet, log: line => logs.push(line) }, schedule: callback => scheduled.push(callback) });
  // The post predates runtime exit and the capacity-freed signal by 40 seconds.
  now = 50_000;
  admission.capacityFreed({ candidate: { reviewerModel: 'gemini', durablePostedAt: 10_000 } });
  scheduled.shift()();
  await flush(); // no backlog yet: preserve the post origin through an empty handoff
  now = 60_000;
  const next = { repoPath: 'example/review-fixture', prNumber: 202, reviewerModel: 'gemini',
    async run() {
      this.markAdmissionStarted();
      now = 65_000; // the adapter takes another five seconds to create its process
      this.markReviewerSpawned?.();
    } };
  admission.enqueue(next);
  await next.run();
  assert.deepEqual(logs, ['[watcher] reviewer seat handoff: model=gemini post_to_spawn_ms=55000']);
});

function durableFixture(t, f, createCandidate = row => f.candidate(row.pr_number)) {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  t.after(() => db.close());
  const refill = createDurableReviewerRefill({ db, createCandidate });
  f.admission.setRefill(refill.refill, refill.onSettled);
  const insert = db.prepare(`INSERT INTO reviewed_prs
    (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, revision_ref)
    VALUES ('example/review-fixture', ?, '2026-01-01', 'gemini', 'open', 'pending', ?)`);
  return { db, insert: pr => insert.run(pr, `head-${pr}`), refill };
}

test('SEATIDLE-04: a spawn refusal refills two durable pending rows and admits the next without a poll', async t => {
  const f = fixture(t);
  const d = durableFixture(t, f);
  d.insert(200); d.insert(201); d.insert(202);
  const refusal = deferred();
  let refusals = 0;
  f.admission.enqueue({
    ...f.candidate(200),
    async run() { refusals++; await refusal.promise; return { dispatched: false, reason: 'failed-external-ci' }; },
  });
  f.admission.capacityFreed(); await f.schedulerTick();
  assert.deepEqual(f.starts, []);
  refusal.resolve(); await flush();
  await f.schedulerTick();
  assert.equal(refusals, 1);
  assert.deepEqual(f.starts, [201]);
  assert.deepEqual(f.admission.candidates.map(c => c.prNumber), [202]);
  assert.match(f.logs.find(line => line.includes('admission refill:')), /candidates=2 admitted=1 idle_ms=1$/);
  assert.equal(f.counts().maxActive, 1);
  for (const completion of f.completions) completion.resolve();
  await flush();
});

test('SEATIDLE-04: unchanged refused rows stay excluded on successive refills until durable state changes', async t => {
  const f = fixture(t);
  const attempts = [];
  const d = durableFixture(t, f, row => ({
    ...f.candidate(row.pr_number),
    async run() { attempts.push(row.pr_number); return { dispatched: false, reason: 'comment-only-final-round' }; },
  }));
  d.insert(200);
  f.admission.capacityFreed(); await f.schedulerTick();
  await f.schedulerTick();
  assert.deepEqual(attempts, [200]);
  f.admission.capacityFreed(); await f.schedulerTick();
  assert.deepEqual(attempts, [200]);
  d.db.prepare("UPDATE reviewed_prs SET rereview_requested_at = '2026-01-02' WHERE pr_number = 200").run();
  f.admission.capacityFreed(); await f.schedulerTick();
  assert.deepEqual(attempts, [200, 200]);
  await f.schedulerTick();
});

test('SEATIDLE-04: an empty durable backlog is a logged no-op without repeated scheduling', async t => {
  const f = fixture(t);
  durableFixture(t, f);
  f.admission.capacityFreed(); await f.schedulerTick();
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.admission.candidates, []);
  assert.deepEqual(f.scheduled, []);
  assert.deepEqual(f.logs, ['[watcher] reviewer admission refill: candidates=0 admitted=0 idle_ms=1']);
});


test('SEATIDLE-04: an admitted attempt rearmed on its unchanged discovery head cannot spin through refill', async t => {
  const f = fixture(t);
  const d = durableFixture(t, f);
  d.insert(201);
  f.admission.capacityFreed(); await f.schedulerTick();
  assert.deepEqual(f.starts, [201]);
  // A stale-head result may leave pending intact; a cached discovery snapshot
  // cannot authorize another attempt until discovery observes a state edge.
  f.completions[0].resolve(); await flush(); await f.schedulerTick();
  assert.deepEqual(f.starts, [201]);
  d.db.prepare("UPDATE reviewed_prs SET rereview_requested_at = '2026-01-02' WHERE pr_number = 201").run();
  f.admission.capacityFreed(); await f.schedulerTick();
  assert.deepEqual(f.starts, [201, 201]);
  for (const completion of f.completions) completion.resolve();
  await flush();
});
