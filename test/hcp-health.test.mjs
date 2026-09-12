import test from 'node:test';
import assert from 'node:assert/strict';

import { checkHcpHealthz } from '../src/hcp-health.mjs';

function abortError(message = 'This operation was aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

test('HCP healthz retries a single aborted probe before failing closed', async () => {
  let calls = 0;
  const sleeps = [];
  const result = await checkHcpHealthz({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw abortError();
      return { ok: true, status: 200 };
    },
    timeoutMs: 8_000,
    delayImpl: async (ms) => sleeps.push(ms),
  });

  assert.equal(result.ready, true);
  assert.equal(result.reason, 'ok');
  assert.equal(result.attempts, 2);
  assert.equal(result.recoveredAfterFailure, true);
  assert.deepEqual(sleeps, [100]);
});

test('HCP healthz sustained unavailable probes still fail closed', async () => {
  const result = await checkHcpHealthz({
    fetchImpl: async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8002'), { code: 'ECONNREFUSED' });
    },
    delayImpl: async () => {},
  });

  assert.equal(result.ready, false);
  assert.equal(result.failureClass, 'hcp-unavailable');
  assert.equal(result.attempts, 3);
  assert.match(result.failureMessage, /after 3 attempts/);
});

test('concurrent HCP healthz probes do not share AbortControllers or failure state', async () => {
  const callsByProbe = new Map();
  const fetchImpl = async (_url, options = {}) => {
    const id = options.headers['x-fixture-probe-id'];
    const calls = Number(callsByProbe.get(id) || 0) + 1;
    callsByProbe.set(id, calls);
    if (calls === 1) throw abortError(`aborted ${id}`);
    assert.equal(options.signal.aborted, false);
    return { ok: true, status: 200 };
  };
  const probe = (id) => checkHcpHealthz({
    fetchImpl: (url, options = {}) => fetchImpl(url, {
      ...options,
      headers: { ...options.headers, 'x-fixture-probe-id': id },
    }),
    delayImpl: async () => {},
  });

  const [left, right] = await Promise.all([probe('left'), probe('right')]);

  assert.equal(left.ready, true);
  assert.equal(right.ready, true);
  assert.equal(left.attempts, 2);
  assert.equal(right.attempts, 2);
  assert.deepEqual(Object.fromEntries(callsByProbe), { left: 2, right: 2 });
});
