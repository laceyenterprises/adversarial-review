import test from 'node:test';
import assert from 'node:assert/strict';

import { createCompositeOperatorSurface } from '../../src/adapters/operator/index.mjs';

test('composite operator surface exposes controls and triage sync methods', () => {
  const surface = createCompositeOperatorSurface({
    controls: {
      fetchLatestLabelEventImpl: async () => null,
      execFileImpl: async () => ({ stdout: '{}' }),
    },
    triage: {
      linearClientProvider: async () => null,
      logger: {},
    },
  });

  assert.equal(typeof surface.observeOverrides, 'function');
  assert.equal(typeof surface.observeOperatorApproved, 'function');
  assert.equal(typeof surface.observeMergeAgentOverride, 'function');
  assert.equal(typeof surface.syncTriageStatus, 'function');
  assert.equal(typeof surface.recordReviewerEngagement, 'function');
  assert.equal(typeof surface.recordReviewCompleted, 'function');
  assert.equal(typeof surface.routePR, 'function');
});
