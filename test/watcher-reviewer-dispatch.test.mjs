import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewerDispatchDrain } from '../src/watcher-reviewer-dispatch.mjs';
import { createReviewerAdmissionQueue } from '../src/watcher-reviewer-admission.mjs';
import { createDetachedReviewerDispatchTracker } from '../src/watcher-reviewer-pool.mjs';

const quiet = { log() {}, warn() {}, error() {} };
function candidate(prNumber, run = async () => {}) {
  return { repoPath: 'example/review-fixture', prNumber, reviewerModel: 'gemini', run };
}
function options(candidates, extra = {}) {
  return {
    reviewerPoolConfig: { enabled: true, maxConcurrent: 3 },
    reviewerDispatchCandidates: candidates,
    readWatcherDrainState: () => ({ active: false }),
    detachedReviewerDispatchTracker: createDetachedReviewerDispatchTracker({ logger: quiet }),
    resolveGeminiCredentialConcurrencyForDispatchCandidates: async () => 1,
    prepareSpillover: async candidates => candidates,
    singleWaveSettleGraceMs: 0, logger: quiet,
    ...extra,
  };
}

test('SEATIDLE-01: the shared drain obeys a live drain marker and the credential cap', async () => {
  let held = true, releaseFirst;
  const starts = [];
  const firstDone = new Promise(resolve => { releaseFirst = resolve; });
  const queue = [candidate(201, async () => { starts.push(201); await firstDone; }),
    candidate(202, async () => { starts.push(202); })];
  const drain = createReviewerDispatchDrain(options(queue, {
    readWatcherDrainState: () => ({ active: held }),
  }));
  await drain('capacity-freed');
  assert.deepEqual(starts, []);
  assert.equal(queue.length, 2);
  held = false;
  await drain('poll');
  assert.deepEqual(starts, [201]);
  assert.deepEqual(queue.map(candidate => candidate.prNumber), [202]);
  await drain('overlapping capacity notification');
  assert.deepEqual(starts, [201]);
  releaseFirst();
  await new Promise(resolve => setImmediate(resolve));
  await drain('capacity-freed');
  assert.deepEqual(starts, [201, 202]);
  assert.equal(queue.length, 0);
});

test('SEATIDLE-01: a failed drain restores only unstarted candidates and refunds their spill reservations', async () => {
  const started = candidate(201), deferred = candidate(202);
  const refunded = [], retained = [], tracked = [];
  for (const c of [started, deferred]) {
    c.refundDepthSpill = () => refunded.push(c.prNumber);
    c.retainWakeForCapacity = () => retained.push(c.prNumber);
  }
  const queue = [started, deferred];
  const drain = createReviewerDispatchDrain(options(queue, {
    detachedReviewerDispatchTracker: { activeCounts: () => new Map(), track: value => tracked.push(value.candidate.prNumber) },
    runQueue: async (candidates, { onCandidateStarted }) => {
      onCandidateStarted({ candidate: candidates[0], promise: Promise.resolve() });
      throw new Error('synthetic admission failure');
    },
  }));
  await assert.rejects(drain('poll'), /synthetic admission failure/);
  assert.deepEqual(queue, [deferred]);
  assert.deepEqual(tracked, [201]);
  assert.deepEqual(refunded, [202]);
  assert.deepEqual(retained, [202]);
});

for (const fails of [false, true]) {
  test(`SEATIDLE-01: discovery refresh during an active drain preserves unique FIFO candidates (${fails ? 'failure' : 'deferral'})`, async () => {
    const admission = createReviewerAdmissionQueue();
    const started = candidate(201), waiting = candidate(202), last = candidate(203);
    for (const c of [started, waiting, last]) admission.enqueue(c);
    let enterDrain, releaseDrain;
    const entered = new Promise(resolve => { enterDrain = resolve; });
    const gate = new Promise(resolve => { releaseDrain = resolve; });
    admission.setDrain(createReviewerDispatchDrain(options(admission.candidates, {
      runQueue: async (candidates, { onCandidateStarted }) => {
        onCandidateStarted({ candidate: candidates[0], promise: Promise.resolve() });
        enterDrain();
        await gate;
        if (fails) throw new Error('synthetic admission failure');
        return { dispatched: 1, deferred: 2, deferredCandidates: candidates.slice(1) };
      },
    })));
    const draining = admission.drain('poll');
    await entered;
    const refreshed = { ...candidate(202), subject: { headSha: 'newer-head' } };
    const discovered = candidate(204);
    admission.enqueue(refreshed);
    admission.enqueue(discovered);
    releaseDrain();
    if (fails) await assert.rejects(draining, /synthetic admission failure/);
    else await draining;
    assert.deepEqual(admission.candidates, [refreshed, last, discovered]);
    assert.equal(new Set(admission.candidates.map(c => `${c.repoPath}#${c.prNumber}`)).size, 3);
  });
}

test('SEATIDLE-01: the real launch wave retains a refreshed waiting head exactly once', async () => {
  const admission = createReviewerAdmissionQueue();
  const starts = [];
  let enterFirst, releaseFirst;
  const entered = new Promise(resolve => { enterFirst = resolve; });
  const completion = new Promise(resolve => { releaseFirst = resolve; });
  admission.enqueue(candidate(201, async () => { enterFirst(); await completion; }));
  admission.enqueue(candidate(202, async () => { starts.push('old-head'); }));
  admission.setDrain(createReviewerDispatchDrain(options(admission.candidates)));
  const draining = admission.drain('poll');
  await entered;
  const refreshed = candidate(202, async () => { starts.push('new-head'); });
  admission.enqueue(refreshed);
  await draining;
  assert.deepEqual(admission.candidates, [refreshed]);
  releaseFirst();
  await new Promise(resolve => setImmediate(resolve));
  await admission.drain('capacity-freed');
  assert.deepEqual(starts, ['new-head']);
  assert.deepEqual(admission.candidates, []);
});

for (const liveDuringRetry of [false, true]) {
  test(`SEATIDLE-02: stale credential accounting retries without a poll${liveDuringRetry ? ' and rechecks a newly live reviewer' : ''}`, async () => {
    const starts = [], logs = [], delays = [];
    let staleCount = 1, live = false;
    const queue = [candidate(301, async () => { starts.push(301); }),
      candidate(302, async () => { starts.push(302); })];
    const tracker = createDetachedReviewerDispatchTracker({ logger: quiet });
    const activeCounts = tracker.activeCounts;
    tracker.activeCounts = () => {
      const counts = activeCounts();
      if (staleCount) counts.set('gemini', staleCount);
      return counts;
    };
    tracker.liveSpawnEntries = () => live ? [{ reviewerModel: 'gemini' }] : [];
    const drain = createReviewerDispatchDrain(options(queue, {
      detachedReviewerDispatchTracker: tracker,
      logger: { ...quiet, log: line => logs.push(line) },
      capacityFreedRetryDelay: async ms => {
        delays.push(ms);
        staleCount = 0;
        if (liveDuringRetry) { live = true; staleCount = 1; }
      },
    }));
    const result = await drain('capacity-freed');
    assert.deepEqual(delays, [2000], 'one bounded retry follows the stale saturation');
    assert.equal(logs.filter(line => /capacity-freed drain retried: attempt=1/.test(line)).length, 1);
    if (liveDuringRetry) {
      assert.equal(result.dispatched, 0);
      assert.deepEqual(starts, [], 'a genuine live reviewer retains the only credential seat');
      assert.equal(queue.length, 2);
    } else {
      assert.equal(result.dispatched, 1);
      assert.deepEqual(starts, [301]);
      assert.deepEqual(queue.map(c => c.prNumber), [302]);
    }
  });
}

test('SEATIDLE-02: persistent stale saturation has three retries then returns to the poll', async () => {
  const delays = [], logs = [];
  const queue = [candidate(301)];
  const drain = createReviewerDispatchDrain(options(queue, {
    detachedReviewerDispatchTracker: {
      activeCounts: () => new Map([['gemini', 1]]), liveSpawnEntries: () => [], track() {},
    },
    logger: { ...quiet, log: line => logs.push(line) },
    capacityFreedRetryDelay: async ms => { delays.push(ms); },
  }));
  const result = await drain('capacity-freed');
  assert.equal(result.dispatched, 0);
  assert.deepEqual(delays, [2000, 2000, 2000]);
  assert.equal(queue.length, 1);
  assert.deepEqual(logs.filter(line => /capacity-freed drain retried/.test(line)),
    [1, 2, 3].map(attempt => `[watcher] capacity-freed drain retried: attempt=${attempt}`));
});

for (const scenario of ['live', 'pipeline', 'unknown', 'poll', 'zero', 'other-reason', 'draining']) {
  test(`SEATIDLE-02: no credential retry for ${scenario}`, async () => {
    const delays = [], starts = [];
    const queue = [candidate(301, async () => { starts.push(301); })];
    const drain = createReviewerDispatchDrain(options(queue, {
      readWatcherDrainState: () => ({ active: scenario === 'draining' }),
      detachedReviewerDispatchTracker: {
        activeCounts: () => new Map([['gemini', 1], ['__total__', scenario === 'other-reason' ? 3 : 0]]),
        liveSpawnEntries: scenario === 'unknown' ? undefined : () => scenario === 'live'
          ? [{ reviewerModel: 'gemini' }]
          : scenario === 'pipeline' ? [{ reviewerModel: 'claude', pipelineGeminiSeats: 1 }] : [],
        track() {},
      },
      resolveGeminiCredentialConcurrencyForDispatchCandidates: async () => scenario === 'zero' ? 0 : 1,
      capacityFreedRetryDelay: async ms => { delays.push(ms); },
    }));
    await drain(scenario === 'poll' ? 'poll' : 'capacity-freed');
    assert.deepEqual(delays, []);
    assert.deepEqual(starts, []);
    assert.equal(queue.length, 1);
  });
}
