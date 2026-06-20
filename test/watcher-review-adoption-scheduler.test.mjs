import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function watcherSource() {
  return readFileSync(path.join(ROOT, 'src', 'watcher.mjs'), 'utf8');
}

test('watcher drains queued reviewer dispatches before merge-side handoffs', () => {
  const source = watcherSource();
  const candidateQueue = source.indexOf('const reviewerDispatchCandidates = [];');
  const postedQueue = source.indexOf('const postedReviewHandlers = [];');
  const postedEnqueue = source.indexOf('postedReviewHandlers.push({');
  const drainBeforeMaintenance = source.indexOf(
    "await drainReviewerDispatchCandidates('posted-review handoffs and watcher maintenance');",
  );
  const postedDrain = source.indexOf('for (const postedReviewHandler of postedReviewHandlers)');
  const lifecycleCleanup = source.indexOf('await retryPendingMergeAgentLifecycleCleanups();');
  const dagAutowalk = source.indexOf('await retryPendingDagAutowalkOnMerge();');

  assert.notEqual(candidateQueue, -1, 'reviewer dispatch candidate queue exists');
  assert.notEqual(postedQueue, -1, 'posted review handoffs are queued');
  assert.notEqual(postedEnqueue, -1, 'posted review rows enqueue their handoff');
  assert.notEqual(drainBeforeMaintenance, -1, 'reviewer dispatch drain exists before maintenance');
  assert.notEqual(postedDrain, -1, 'queued posted-review handlers drain after reviewers');
  assert.notEqual(lifecycleCleanup, -1, 'merge-agent cleanup still runs');
  assert.notEqual(dagAutowalk, -1, 'dag autowalk retry still runs');

  assert.ok(candidateQueue < postedQueue, 'queues are initialized near the reviewer scheduler');
  assert.ok(postedQueue < postedEnqueue, 'posted handler queue is initialized before use');
  assert.ok(postedEnqueue < drainBeforeMaintenance, 'posted handoffs do not run inline');
  assert.ok(drainBeforeMaintenance < postedDrain, 'reviewers drain before posted-review handoffs');
  assert.ok(postedDrain < lifecycleCleanup, 'posted-review handoffs run before lifecycle cleanup');
  assert.ok(lifecycleCleanup < dagAutowalk, 'dag autowalk remains post-review maintenance');
});
