import test from 'node:test';
import assert from 'node:assert/strict';

import { createTickHcpHealthzProbe } from '../src/watcher-tick-preflight.mjs';

test('watcher caches failed HCP healthcheck results for the whole poll tick', async () => {
  let calls = 0;
  const getHcpHealthzForTick = createTickHcpHealthzProbe({
    checkHcpHealthzImpl: async () => {
      calls += 1;
      return { ready: false, reason: 'fixture-down', failureClass: 'hcp-unavailable' };
    },
  });

  assert.deepEqual(await getHcpHealthzForTick(), {
    ready: false,
    reason: 'fixture-down',
    failureClass: 'hcp-unavailable',
  });
  assert.deepEqual(await getHcpHealthzForTick(), {
    ready: false,
    reason: 'fixture-down',
    failureClass: 'hcp-unavailable',
  });
  assert.equal(calls, 1);
});
