import { beforeEach } from 'node:test';
import { rateLimitClock } from '../../src/rate-limit-throttle.mjs';

// Advance through the real throttle policy, including reset expiry, without
// spending a minute on synthetic rate-limit replies.
beforeEach(t => {
  let now = Date.now();
  t.mock.method(rateLimitClock, 'now', () => now);
  t.mock.method(rateLimitClock, 'sleep', async ms => { now += ms; });
});
