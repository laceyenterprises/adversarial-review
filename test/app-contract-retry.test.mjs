import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isTransientAppContractError,
  withAppContractTransientRetry,
} from '../src/app-contract-retry.mjs';

// Coverage for the three #623 (ARC-24) review findings.

test('message-embedded 408/425 are transient, matching the status-property path', () => {
  // Finding 2: property path treats 408/425 as retryable; the message path
  // must agree so an error whose code is only in the string is not dropped.
  assert.equal(isTransientAppContractError({ message: 'app-contract 408: Request Timeout' }), true);
  assert.equal(isTransientAppContractError({ message: 'app-contract 425: Too Early' }), true);
  assert.equal(isTransientAppContractError({ message: 'app-contract 429: Too Many' }), true);
  assert.equal(isTransientAppContractError({ message: 'app-contract 503: Unavailable' }), true);
  // A genuine client error stays fatal.
  assert.equal(isTransientAppContractError({ message: 'app-contract 400: Bad Request' }), false);
  // And the property path still holds.
  assert.equal(isTransientAppContractError({ status: 408 }), true);
  assert.equal(isTransientAppContractError({ status: 400 }), false);
});

test('bare "timeout" messages are transient again (regex regression fix)', () => {
  // Finding 3: undici throws "Headers timeout"/"Request timeout"; the regex
  // must catch the bare `timeout` keyword, not only `timed out`.
  assert.equal(isTransientAppContractError({ message: 'Headers timeout' }), true);
  assert.equal(isTransientAppContractError({ message: 'Request timeout' }), true);
  assert.equal(isTransientAppContractError({ message: 'operation timed out' }), true);
  assert.equal(isTransientAppContractError({ message: 'totally unrelated failure' }), false);
});

test('withAppContractTransientRetry rejects a non-positive maxAttempts loudly', async () => {
  // Finding 1: a zero/negative budget must throw a clear TypeError, never
  // `undefined` from an uninitialized lastError.
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(
      () => withAppContractTransientRetry(async () => 'ok', { maxAttempts: bad }),
      (err) => {
        assert.ok(err instanceof TypeError);
        assert.match(err.message, /maxAttempts must be a positive integer/);
        return true;
      },
    );
  }
});

test('withAppContractTransientRetry retries a transient error then succeeds', async () => {
  let calls = 0;
  const result = await withAppContractTransientRetry(
    async () => {
      calls += 1;
      if (calls < 2) throw { message: 'app-contract 503: Unavailable' };
      return 'ok';
    },
    { maxAttempts: 3, sleepImpl: async () => {} },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('withAppContractTransientRetry does not retry a fatal error', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withAppContractTransientRetry(
        async () => {
          calls += 1;
          throw new Error('app-contract 400: Bad Request');
        },
        { maxAttempts: 3, sleepImpl: async () => {} },
      ),
    /400/,
  );
  assert.equal(calls, 1);
});
