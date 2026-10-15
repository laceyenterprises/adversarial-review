import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewerDispatchDrain } from '../src/watcher-reviewer-dispatch.mjs';
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
