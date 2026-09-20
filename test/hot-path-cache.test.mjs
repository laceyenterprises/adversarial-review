import test from 'node:test';
import assert from 'node:assert/strict';

import {
  invalidationReasonForGrounding,
} from '../src/context/hot-path-cache.mjs';
import { createAfhReviewerGroundingCache } from '../src/afh-reviewer-fallback.mjs';

test('quota cache has explicit operator-resume invalidation', async () => {
  let reads = 0;
  const events = [];
  const getGrounding = createAfhReviewerGroundingCache({
    readImpl: async () => ({ available: true, providers: {}, read: ++reads }),
    ttlMs: 100,
    nowFn: () => 1,
    emitCacheEvent: (event) => events.push(event),
  });
  assert.equal((await getGrounding()).read, 1);
  assert.equal((await getGrounding()).read, 1);
  assert.equal(getGrounding.invalidate({ reason: 'operator-resume' }), 1);
  assert.equal((await getGrounding()).read, 2);
  assert.ok(events.some((event) => event.event === 'cache_invalidated' && event.reason === 'operator-resume'));
});

test('hard and soft grounding transitions name route invalidation reasons', () => {
  const healthy = { providers: { openai: { hardGrounded: false, softGrounded: false } } };
  assert.equal(invalidationReasonForGrounding(healthy, { providers: { openai: { hardGrounded: true } } }), 'hard-grounding');
  assert.equal(invalidationReasonForGrounding(healthy, { providers: { openai: { softGrounded: true } } }), 'soft-grounding');
});
