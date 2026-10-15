import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReviewerLaneState,
  reviewerDispatchWaitPriority,
  runBoundedReviewerDispatchQueue,
  sortReviewerDispatchCandidates,
} from '../src/watcher-reviewer-pool.mjs';

const thresholdMs = 900_000;
const logger = { log() {}, warn() {}, error() {} };

function candidate(prNumber, { enqueuedAtMs, wakePriority = false,
  retainedWakePriority = false, rereview = false, run = async () => {} } = {}) {
  return {
    repoPath: 'example/project', prNumber, reviewerModel: 'gemini',
    subject: { headSha: `head-${prNumber}`, createdAt: '2026-01-01T00:00:00Z' },
    hasPriorPostedReview: rereview, enqueuedAtMs, wakePriority, retainedWakePriority, run,
  };
}

test('one seat serves an unwoken candidate at the threshold despite a fresh wake every drain', async () => {
  let nowMs = 0;
  const starts = [];
  const old = candidate(1, { enqueuedAtMs: 0, run: async () => starts.push(1) });
  const laneState = createReviewerLaneState();
  for (let drain = 0; drain <= 3; drain += 1) {
    nowMs = drain * 300_000;
    const fresh = candidate(drain + 2, { enqueuedAtMs: nowMs, wakePriority: true,
      run: async () => starts.push(drain + 2) });
    const result = await runBoundedReviewerDispatchQueue([fresh, old], {
      maxConcurrent: 1, geminiCredentialConcurrency: 1, singleWave: true,
      laneState, now: () => nowMs, logger,
    });
    assert.equal(result.dispatched, 1);
    assert.equal(starts.at(-1), nowMs >= thresholdMs ? 1 : drain + 2);
  }
  assert.deepEqual(starts, [2, 3, 4, 1]);
});

test('over-threshold candidates run longest-wait-first ahead of fresh and retained wakes and lane preferences', async () => {
  const nowMs = 2 * thresholdMs;
  const starts = [];
  const tasks = [
    candidate(4, { enqueuedAtMs: nowMs, wakePriority: true }),
    candidate(3, { enqueuedAtMs: nowMs - 10, wakePriority: true, retainedWakePriority: true }),
    candidate(2, { enqueuedAtMs: nowMs - thresholdMs, wakePriority: true }),
    candidate(1, { enqueuedAtMs: 0, rereview: true }),
  ];
  tasks.forEach((task) => { task.run = async () => starts.push(task.prNumber); });
  const laneState = createReviewerLaneState({ firstPassBurstLimit: 100, minShare: 0 });
  assert.deepEqual(sortReviewerDispatchCandidates(tasks, { nowMs }).map((item) => item.prNumber), [1, 2, 3, 4]);
  await runBoundedReviewerDispatchQueue(tasks, {
    maxConcurrent: 1, geminiCredentialConcurrency: 1, laneState, now: () => nowMs, logger,
  });
  assert.deepEqual(starts, [1, 2, 3, 4]);
});

test('the existing wait warning threshold also controls dispatch ordering', async () => {
  const starts = [];
  const tasks = [
    candidate(2, { enqueuedAtMs: 100, wakePriority: true, run: async () => starts.push(2) }),
    candidate(1, { enqueuedAtMs: 0, run: async () => starts.push(1) }),
  ];
  await runBoundedReviewerDispatchQueue(tasks, {
    maxConcurrent: 1, singleWave: true, now: () => 100, waitWarnMs: 100, logger,
  });
  assert.deepEqual(starts, [1]);
  assert.equal(reviewerDispatchWaitPriority(tasks[1], { nowMs: 99, waitWarnMs: 100 }), null);
});

for (const timestamp of ['enqueuedAtMs', 'enqueuedAt']) {
  test(`single-lane modern ${timestamp} candidates use the injected clock`, async () => {
    const nowMs = Date.parse('2026-01-01T00:00:00Z');
    const starts = [];
    const old = candidate(1, { run: async () => starts.push(1) });
    const fresh = candidate(2, { wakePriority: true, run: async () => starts.push(2) });
    const encode = (value) => timestamp === 'enqueuedAtMs' ? value : new Date(value).toISOString();
    old[timestamp] = encode(nowMs - thresholdMs);
    fresh[timestamp] = encode(nowMs);
    // Wall time puts neither (or both) over the threshold. Only the injected
    // clock moves the old candidate across the boundary between these drains.
    for (const time of [nowMs - 1, nowMs]) {
      await runBoundedReviewerDispatchQueue([fresh, old], {
        maxConcurrent: 1, singleWave: true, now: () => time, logger,
      });
    }
    assert.deepEqual(starts, [2, 1]);
  });
}

test('wait priority is enqueue-relative and never inferred from PR creation or pending age', () => {
  const old = candidate(1);
  old.pendingSinceMs = 0;
  assert.equal(reviewerDispatchWaitPriority(old, { nowMs: 2 * thresholdMs }), null);
  old.enqueuedAtMs = 2 * thresholdMs - 1;
  assert.equal(reviewerDispatchWaitPriority(old, { nowMs: 2 * thresholdMs }), null);
  delete old.enqueuedAtMs;
  old.enqueuedAt = '2026-01-01T00:00:00Z';
  assert.equal(reviewerDispatchWaitPriority(old, { nowMs: Date.parse(old.enqueuedAt) + thresholdMs }), thresholdMs);
});

test('equal overdue waits retain deterministic ordering and no timestamp leaves ordinary wakes first', () => {
  const tasks = [candidate(3), candidate(2, { enqueuedAtMs: 0 }), candidate(1, { enqueuedAtMs: 0 })];
  tasks[0].wakePriority = true;
  assert.deepEqual(sortReviewerDispatchCandidates(tasks, { nowMs: thresholdMs }).map((item) => item.prNumber), [1, 2, 3]);
});

test('an overdue rereview can take the free reserved lane seat while total and Gemini caps stay intact', async () => {
  const starts = [];
  const result = await runBoundedReviewerDispatchQueue([
    candidate(2, { enqueuedAtMs: thresholdMs, wakePriority: true, run: async () => starts.push(2) }),
    candidate(1, { enqueuedAtMs: 0, rereview: true, run: async () => starts.push(1) }),
  ], {
    maxConcurrent: 2, geminiCredentialConcurrency: 2,
    activeReviewerCounts: { __total__: 1, '__lane:rereview': 1, gemini: 1 },
    singleWave: true, laneState: createReviewerLaneState(), now: () => thresholdMs, logger,
  });
  assert.deepEqual(starts, [1]);
  assert.equal(result.dispatched, 1);
  assert.equal(result.deferred, 1);
});
