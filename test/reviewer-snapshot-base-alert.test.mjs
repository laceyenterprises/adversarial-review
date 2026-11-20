import assert from 'node:assert/strict';
import test from 'node:test';

import { alertReviewerSnapshotBaseFailure, alertReviewerWorkspaceDegradation } from '../src/reviewer-alerts.mjs';

test('unsafe snapshots alert the operator about the snapshot commit', async () => {
  let delivered = null;
  const result = await alertReviewerSnapshotBaseFailure({
    repo: 'laceyenterprises/agent-os',
    prNumber: 1129,
    headSha: 'base-head',
    linkPath: 'escape',
    reason: 'snapshot contains link escaping its root',
  }, {
    deliverAlertImpl: async (message, event) => {
      delivered = { message, event };
      return { id: 'alert-1' };
    },
  });
  assert.deepEqual(result, { id: 'alert-1' });
  assert.equal(delivered.event.event, 'reviewer.snapshot_base_invalid');
  assert.equal(delivered.event.payload.headSha, 'base-head');
  assert.match(delivered.message, /Snapshot commit: base-head/);
});

test('workspace degradation uses the shared alert contract with bounded facts', async () => {
  const payload = { repo: 'example/target', prNumber: 47, headSha: 'a'.repeat(40), cause: 'origin-unverified' };
  const result = await alertReviewerWorkspaceDegradation(payload, {
    deliverAlertImpl: async (message, event) => {
      assert.match(message, /degraded to diff-only/);
      assert.deepEqual(event, { event: 'reviewer.workspace_degraded', payload });
      return { id: 'fixture-alert' };
    },
  });
  assert.deepEqual(result, { id: 'fixture-alert' });
});
