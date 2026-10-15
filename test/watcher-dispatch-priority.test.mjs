import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { createRetainedWatcherWakes } from '../src/watcher-retained-wakes.mjs';
import {
  createWatcherDiscoveryBatchDrain,
  createWatcherDispatchPriority,
  reconcileWatcherPriorityDiscoveryPending,
} from '../src/watcher-dispatch-priority.mjs';

test('discovery releases missing subjects without releasing priority work in later repos', () => {
  const pending = new Set(['example/first#1', 'example/first#2', 'example/later#3']);
  reconcileWatcherPriorityDiscoveryPending(pending, {
    repoPath: 'example/first', discoveredPrNumbers: new Set([2]),
  });
  assert.deepEqual([...pending], ['example/first#2', 'example/later#3']);
  pending.delete('example/first#2');
  assert.equal(pending.size, 1, 'later repo priority still prevents an early drain');
  reconcileWatcherPriorityDiscoveryPending(pending, {
    repoPath: 'example/later', discoveredPrNumbers: new Set(),
  });
  assert.equal(pending.size, 0, 'failed or empty discovery releases the last barrier');
});

for (const liveState of ['closed', 'merged', 'unreadable']) {
  test(`${liveState} retained subjects and stale failed rows release discovery barriers across ticks`, async (t) => {
    const rootDir = mkdtempSync(join(tmpdir(), 'priority-discovery-'));
    const db = new Database(':memory:');
    t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
    ensureReviewStateSchema(db);
    const repoPath = 'example/project';
    const laterRepo = 'example/later';
    const identity = { repoPath, prNumber: 1, headSha: 'head-a' };
    createRetainedWatcherWakes({ rootDir }).retain(identity);
    const insert = db.prepare(`INSERT INTO reviewed_prs
      (repo, pr_number, reviewed_at, reviewer, pr_state, review_status)
      VALUES (?, ?, ?, 'gemini', 'open', ?)`);
    insert.run(repoPath, 2, '2026-01-01T00:00:00Z', 'failed');
    insert.run(laterRepo, 3, '2026-01-01T00:00:00Z', 'pending');

    for (let tick = 0; tick < 2; tick += 1) {
      const { retainedWatcherWakes, priorityDiscoveryPending } = createWatcherDispatchPriority({
        rootDir, db, nowMs: Date.parse('2026-01-01T01:00:00Z'),
      });
      assert.equal(priorityDiscoveryPending.has(`${repoPath}#2`), true, 'stale open failed row seeds each tick');
      await retainedWatcherWakes.reconcileMissing({
        repoPath, discoveredPrNumbers: new Set(),
        readLive: async () => {
          if (liveState === 'unreadable') throw new Error('fixture unavailable');
          return { state: 'closed', mergedAt: liveState === 'merged' ? '2026-01-01T00:30:00Z' : null };
        },
      });
      reconcileWatcherPriorityDiscoveryPending(priorityDiscoveryPending, {
        repoPath, discoveredPrNumbers: new Set(),
      });
      assert.deepEqual([...priorityDiscoveryPending], [`${laterRepo}#3`], 'later repository still holds its priority');
      assert.equal(retainedWatcherWakes.matches(identity), liveState === 'unreadable', 'only authoritative closure deletes durable priority');
      const drains = [];
      const drainIfReady = createWatcherDiscoveryBatchDrain({
        priorityDiscoveryPending, reviewerDispatchCandidates: [{ hasPriorPostedReview: false }], batchSize: 1,
        countOpenPrsAwaitingFirstPassReview: () => 0,
        drain: async (reason) => { drains.push(reason); return { dispatched: 1 }; },
      });
      assert.equal((await drainIfReady('later priority not queued')).dispatched, 0);
      // Once later priority work has entered the queue, intermediate draining
      // must be possible even though the failed row still says open in SQLite.
      priorityDiscoveryPending.delete(`${laterRepo}#3`);
      assert.equal(priorityDiscoveryPending.size, 0);
      assert.equal((await drainIfReady('later priority queued')).dispatched, 1);
      assert.equal((await drainIfReady('second wave')).dispatched, 0);
      assert.deepEqual(drains, ['later priority queued']);
    }
  });
}

test('discovery batch admission retains the batch-size and first-pass backlog guards', async () => {
  const candidates = [{ hasPriorPostedReview: true }];
  let firstPassBacklog = 1;
  let drains = 0;
  const drainIfReady = createWatcherDiscoveryBatchDrain({
    priorityDiscoveryPending: new Set(), reviewerDispatchCandidates: candidates, batchSize: 2,
    countOpenPrsAwaitingFirstPassReview: () => firstPassBacklog,
    drain: async () => { drains += 1; return { dispatched: candidates.length }; },
  });
  firstPassBacklog = 0;
  assert.equal((await drainIfReady('incomplete batch')).dispatched, 0);
  candidates.push({ hasPriorPostedReview: true });
  firstPassBacklog = 1;
  assert.equal((await drainIfReady('first-pass backlog')).dispatched, 0);
  candidates.push({ hasPriorPostedReview: false });
  assert.equal((await drainIfReady('first-pass queued')).dispatched, 3);
  assert.equal(drains, 1);
});

test('CASCADECAP-01 timeout retries wait for full discovery before spending a seat', async () => {
  let drains = 0;
  const drain = createWatcherDiscoveryBatchDrain({ priorityDiscoveryPending: new Set(),
    reviewerDispatchCandidates: [{ hasPriorPostedReview: false, sameHeadTimeoutRetry: true }], batchSize: 1,
    countOpenPrsAwaitingFirstPassReview: () => 0,
    drain: async () => { drains++; return { dispatched: 1 }; },
  });
  assert.equal((await drain('partial discovery')).dispatched, 0);
  assert.equal(drains, 0, 'later first-pass and re-review subjects must enter the shared ordering first');
});
