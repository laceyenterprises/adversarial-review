import assert from 'node:assert/strict';
import test from 'node:test';

import { alertReviewerSnapshotBaseFailure } from '../src/reviewer-alerts.mjs';

test('unsafe default-checkout snapshots alert the operator as infrastructure failures', async () => {
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
  assert.match(delivered.message, /Repair the base checkout; this is not a PR-authored finding/);
});
