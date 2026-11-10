import { beforeEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { rateLimitClock } from '../../src/rate-limit-throttle.mjs';

// Advance through the real throttle policy, including reset expiry, without
// spending a minute on synthetic rate-limit replies. Keep time monotonic so
// expired in-memory observations cannot become active again in the next test.
let now = Date.now();
beforeEach(t => {
  now = Math.max(now, Date.now());
  // Synchronous budget readers use wall time. They must not inherit a previous
  // test's reset timestamp, which may still be in the future on that clock.
  const previousPath = process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
  const dir = mkdtempSync(join(tmpdir(), 'virtual-rate-limit-'));
  process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = join(dir, 'state.json');
  t.after(() => {
    if (previousPath === undefined) delete process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
    else process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  });
  t.mock.method(rateLimitClock, 'now', () => now);
  t.mock.method(rateLimitClock, 'sleep', async ms => {
    await setImmediate(); // Allow lock holders and their real file I/O to run.
    now += ms;
  });
});
