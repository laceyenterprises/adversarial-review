import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHotPathCache,
  invalidationReasonForGrounding,
  reviewContextCacheKey,
} from '../src/context/hot-path-cache.mjs';
import { createAfhReviewerGroundingCache } from '../src/afh-reviewer-fallback.mjs';

test('fresh context cache hit reuses bundle bytes', async () => {
  let now = 100;
  let loads = 0;
  const events = [];
  const cache = createHotPathCache({ name: 'review-context', ttlMs: 50, nowFn: () => now, emitEvent: (event) => events.push(event) });
  const key = reviewContextCacheKey({ repo: 'o/r', prNumber: 7, headSha: 'head-a', baseSha: 'base-a', reviewerProfile: 'gemini:first' });
  const load = async () => Buffer.from(`bundle-${++loads}`);
  assert.equal((await cache.get(key, load)).toString(), 'bundle-1');
  now = 149;
  assert.equal((await cache.get(key, load)).toString(), 'bundle-1');
  assert.equal(loads, 1);
  assert.deepEqual(events.map(({ event }) => event), ['cache_miss', 'cache_hit']);
});

test('cache hits report saved load time for latency telemetry', async () => {
  const ticks = [100, 100, 175, 200];
  const events = [];
  const cache = createHotPathCache({
    name: 'review-context',
    ttlMs: 500,
    nowFn: () => ticks.shift() ?? 200,
    emitEvent: (event) => events.push(event),
  });
  assert.equal(await cache.get('key', async () => 'bundle'), 'bundle');
  assert.equal(await cache.get('key', async () => 'uncalled'), 'bundle');
  const hit = events.find((event) => event.event === 'cache_hit');
  assert.equal(hit.savedMs, 75);
  assert.equal(hit.ageMs, 25);
});

test('cache evicts oldest entries at its configured size limit', async () => {
  let now = 0;
  const cache = createHotPathCache({ name: 'review-context', ttlMs: 1_000, maxEntries: 2, nowFn: () => now });
  assert.equal(await cache.get('a', async () => 'a'), 'a');
  now += 1;
  assert.equal(await cache.get('b', async () => 'b'), 'b');
  now += 1;
  assert.equal(await cache.get('c', async () => 'c'), 'c');
  assert.equal(cache.size(), 2);
  now += 1;
  assert.equal(await cache.get('a', async () => 'a-reloaded'), 'a-reloaded');
});

test('TTL expiry rebuilds a stale bundle', async () => {
  let now = 0;
  let loads = 0;
  const events = [];
  const cache = createHotPathCache({ name: 'review-context', ttlMs: 10, nowFn: () => now, emitEvent: (event) => events.push(event) });
  await cache.get('key', async () => ++loads);
  now = 10;
  assert.equal(await cache.get('key', async () => ++loads), 2);
  assert.equal(events.at(-1).event, 'cache_stale');
});

test('head SHA changes the context identity', () => {
  const common = { repo: 'o/r', prNumber: 7, baseSha: 'base-a', reviewerProfile: 'gemini:first' };
  assert.notEqual(
    reviewContextCacheKey({ ...common, headSha: 'head-a' }),
    reviewContextCacheKey({ ...common, headSha: 'head-b' })
  );
});

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
