import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileWatcherPriorityDiscoveryPending } from '../src/watcher-dispatch-priority.mjs';

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
