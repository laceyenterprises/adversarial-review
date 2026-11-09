import './helpers/rate-limit-state-isolation.mjs';
import './helpers/virtual-rate-limit-clock.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import {
  awaitThrottleIfNeeded, githubBudgetKey, rateLimitClock,
  readGitHubBudgetBucketsSync, recordRateLimitedCall,
} from '../src/rate-limit-throttle.mjs';

let previousPath;
let previousNow;
const credential = 'virtual-clock-fixture';

test('virtual reset leaves a persisted future wall-clock bucket', async () => {
  previousPath = process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
  await recordRateLimitedCall('core', credential);
  const key = githubBudgetKey('core', credential);
  const reset = readGitHubBudgetBucketsSync()[key].resetAt;
  assert.ok(Date.parse(reset) > Date.now());
  assert.equal(await awaitThrottleIfNeeded('core', credential), true);
  previousNow = rateLimitClock.now();
  assert.ok(previousNow >= Date.parse(reset));
  assert.match(readFileSync(previousPath, 'utf8'), new RegExp(credential),
    'the expired virtual observation still exists on disk until fixture cleanup');
});

test('the next test has clean sync state and cannot revive expired async state', async () => {
  assert.notEqual(process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH, previousPath);
  assert.equal(existsSync(previousPath), false);
  assert.ok(rateLimitClock.now() >= previousNow);
  assert.deepEqual(readGitHubBudgetBucketsSync(), {});
  assert.equal(await awaitThrottleIfNeeded('core', credential), false);
});

test('virtual sleeps yield while concurrent rate-limit writers retain their observations', async () => {
  let yielded = false;
  const turn = setImmediate().then(() => { yielded = true; });
  await rateLimitClock.sleep(50);
  assert.equal(yielded, true);
  await turn;
  const lockStartedAt = rateLimitClock.now();
  await Promise.all(Array.from({ length: 8 }, (_, i) =>
    recordRateLimitedCall('core', `contended-${i}`)));
  assert.equal(rateLimitClock.now(), lockStartedAt,
    'real lock contention must not advance the virtual budget clock');
  const buckets = readGitHubBudgetBucketsSync();
  for (let i = 0; i < 8; i++) {
    assert.equal(buckets[githubBudgetKey('core', `contended-${i}`)].remaining, 0);
  }
});
