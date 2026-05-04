import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STALE_DRIFT_STOP_CODE,
  shouldSkipReviewerForStaleDrift,
  staleDriftStopDecision,
} from '../src/stale-drift.mjs';

test('reviewer path skips PRs labeled stale-drift', () => {
  const result = shouldSkipReviewerForStaleDrift({
    number: 188,
    labels: [{ name: 'stale-drift' }],
  });

  assert.deepEqual(result, {
    action: 'reviewer',
    reason: 'stale-drift',
    message: '[watcher] Skipping reviewer for #188: stale-drift label set',
  });
});

test('remediation path skips PRs labeled stale-drift', () => {
  const result = staleDriftStopDecision(
    {
      prState: 'open',
      labels: [{ name: 'stale-drift' }],
    },
    { prNumber: 188, site: 'consume' }
  );

  assert.deepEqual(result, {
    stopCode: STALE_DRIFT_STOP_CODE,
    actionReason: 'stale-drift',
    workerState: 'never-spawned',
    stopReason: 'PR #188 carries the stale-drift label; skipping remediation spawn.',
    logMessage: '[watcher] Skipping remediation for #188: stale-drift label set',
  });
});

test('remediation stale-drift gate does not fire for reconcile or terminal PRs', () => {
  assert.equal(
    staleDriftStopDecision(
      {
        prState: 'open',
        labels: [{ name: 'stale-drift' }],
      },
      { prNumber: 188, site: 'reconcile' }
    ),
    null
  );

  assert.equal(
    staleDriftStopDecision(
      {
        prState: 'merged',
        labels: [{ name: 'stale-drift' }],
      },
      { prNumber: 188, site: 'consume' }
    ),
    null
  );
});
