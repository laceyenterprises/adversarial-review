import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isKnownDispatch,
  reconcileDispatches,
} from '../src/adapters/agent-runtime/router/reconcile.mjs';

test('isKnownDispatch: any non-terminal-unknown status is known/adoptable', () => {
  assert.equal(isKnownDispatch({ status: 'accepted' }), true);
  assert.equal(isKnownDispatch({ status: 'running' }), true);
  assert.equal(isKnownDispatch({ status: 'succeeded' }), true);
  assert.equal(isKnownDispatch({ status: 'found' }), true);
  assert.equal(isKnownDispatch({ status: 'not_found' }), false);
  assert.equal(isKnownDispatch({ status: 'unknown' }), false);
  assert.equal(isKnownDispatch({ status: '' }), false);
  assert.equal(isKnownDispatch(null), false);
});

test('reconcile ADOPTS an accepted-but-unobserved dispatch and never re-issues it', async () => {
  // Two keys were handed to the OS before failover. On resume the endpoint still
  // knows about them (one running, one already succeeded); one other key it has
  // forgotten (not_found).
  const statusByKey = {
    'code-pr:pr-14:abc:code-review:reviewer:1': { status: 'running' },
    'code-pr:pr-14:abc:security:reviewer:1': { status: 'succeeded', artifact: { kind: 'review' } },
    'code-pr:pr-19:def:code-review:reviewer:1': { status: 'not_found' },
  };
  const statusCalls = [];
  const adopted = [];

  const result = await reconcileDispatches({
    keys: Object.keys(statusByKey),
    dispatchStatus: async (key) => {
      statusCalls.push(key);
      return statusByKey[key];
    },
    adopt: async (key, payload) => {
      adopted.push({ key, status: payload.status });
    },
  });

  // Every candidate was queried exactly once.
  assert.equal(statusCalls.length, 3);
  // The two known dispatches were adopted; the not_found one was not.
  assert.equal(result.adoptedCount, 2);
  assert.equal(adopted.length, 2);
  assert.deepEqual(
    adopted.map((a) => a.key).sort(),
    ['code-pr:pr-14:abc:code-review:reviewer:1', 'code-pr:pr-14:abc:security:reviewer:1'],
  );
  // not_found is reissuable, NOT a duplicate.
  assert.equal(result.notFoundCount, 1);
  assert.equal(result.notFound[0].key, 'code-pr:pr-19:def:code-review:reviewer:1');
  // The core guarantee: zero duplicates, and reconcile itself never dispatches.
  assert.equal(result.duplicatedCount, 0);
});

test('reconcile does not call adopt for not_found keys', async () => {
  let adoptCalls = 0;
  const result = await reconcileDispatches({
    keys: ['k1', 'k2'],
    dispatchStatus: async () => ({ status: 'not_found' }),
    adopt: async () => { adoptCalls += 1; },
  });
  assert.equal(adoptCalls, 0);
  assert.equal(result.adoptedCount, 0);
  assert.equal(result.notFoundCount, 2);
});

test('a transport failure during status query is recorded unknown, never re-issued', async () => {
  const result = await reconcileDispatches({
    keys: ['k1', 'k2'],
    dispatchStatus: async (key) => {
      if (key === 'k2') {
        const err = new Error('ECONNRESET');
        err.code = 'ECONNRESET';
        throw err;
      }
      return { status: 'running' };
    },
    adopt: async () => {},
  });
  assert.equal(result.adoptedCount, 1);
  assert.equal(result.unknownCount, 1);
  assert.equal(result.unknown[0].key, 'k2');
  assert.match(result.unknown[0].error, /ECONNRESET/);
  assert.equal(result.duplicatedCount, 0);
});

test('duplicate candidate keys are de-duplicated before querying', async () => {
  const calls = [];
  const result = await reconcileDispatches({
    keys: ['k1', 'k1', ' k1 ', '', null, 'k2'],
    dispatchStatus: async (key) => { calls.push(key); return { status: 'running' }; },
    adopt: async () => {},
  });
  assert.deepEqual(calls, ['k1', 'k2']);
  assert.equal(result.adoptedCount, 2);
});

test('an adopt callback that throws does not abort reconcile or re-issue', async () => {
  const result = await reconcileDispatches({
    keys: ['k1', 'k2'],
    dispatchStatus: async () => ({ status: 'running' }),
    adopt: async (key) => { if (key === 'k1') throw new Error('adopt boom'); },
    logger: { warn() {} },
  });
  // Both still counted as adopted (known); the throw is swallowed.
  assert.equal(result.adoptedCount, 2);
  assert.equal(result.duplicatedCount, 0);
});

test('status queries start concurrently instead of serializing resume latency', async () => {
  const resolvers = new Map();
  const started = [];
  const reconciliation = reconcileDispatches({
    keys: ['k1', 'k2', 'k3'],
    dispatchStatus: (key) => new Promise((resolve) => {
      started.push(key);
      resolvers.set(key, resolve);
    }),
  });

  await Promise.resolve();
  assert.deepEqual(started, ['k1', 'k2', 'k3']);
  for (const resolve of resolvers.values()) resolve({ status: 'not_found' });
  const result = await reconciliation;
  assert.equal(result.notFoundCount, 3);
});
