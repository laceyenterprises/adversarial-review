import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { sleepSync, withSqliteBusyRetrySync } from '../src/sqlite-busy-retry.mjs';

test('sync sqlite busy retry does not spawn a Node.js subprocess for sleeping', () => {
  const source = readFileSync(new URL('../src/sqlite-busy-retry.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.execPath/);
  assert.doesNotMatch(source, /setTimeout\(\(\) => \{\}/);
});

test('sync sqlite busy retry retries busy failures before succeeding', () => {
  const sleeps = [];
  let attempts = 0;
  const result = withSqliteBusyRetrySync(
    () => {
      attempts += 1;
      if (attempts < 2) {
        const err = new Error('database is locked');
        err.code = 'SQLITE_BUSY';
        throw err;
      }
      return 'ok';
    },
    {
      delaysMs: [5],
      sleepImpl: (ms) => sleeps.push(ms),
      log: { warn() {} },
    }
  );

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [5]);
});

test('sync sleep uses Atomics.wait when available', () => {
  const calls = [];

  sleepSync(5, {
    atomicsWaitImpl: (view, index, value, timeout) => calls.push({
      view,
      index,
      value,
      timeout,
    }),
    sharedArrayBufferImpl: SharedArrayBuffer,
    int32ArrayImpl: Int32Array,
    spawnSyncImpl: () => {
      throw new Error('spawn should not be called');
    },
  });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].view instanceof Int32Array);
  assert.equal(calls[0].index, 0);
  assert.equal(calls[0].value, 0);
  assert.equal(calls[0].timeout, 5);
});

test('sync sleep falls back to lightweight sleep binary when Atomics is unavailable', () => {
  const calls = [];

  sleepSync(250, {
    atomicsWaitImpl: null,
    sharedArrayBufferImpl: null,
    spawnSyncImpl: (...args) => {
      calls.push(args);
      return { status: 0 };
    },
  });

  assert.deepEqual(calls, [[
    'sleep',
    ['0.25'],
    {
      stdio: 'ignore',
      timeout: 1250,
    },
  ]]);
});

test('sync sleep busy-waits after transient fallback resource errors', () => {
  const err = new Error('spawn EAGAIN');
  err.code = 'EAGAIN';
  const busyWaits = [];

  sleepSync(1, {
    atomicsWaitImpl: null,
    sharedArrayBufferImpl: null,
    spawnSyncImpl: () => ({ error: err }),
    busyWaitImpl: (ms) => busyWaits.push(ms),
  });

  assert.deepEqual(busyWaits, [1]);
});

test('sync sleep busy-waits after EIO fallback errors', () => {
  const err = new Error('spawn EIO');
  err.code = 'EIO';
  const busyWaits = [];

  sleepSync(1, {
    atomicsWaitImpl: null,
    sharedArrayBufferImpl: null,
    spawnSyncImpl: () => ({ error: err }),
    busyWaitImpl: (ms) => busyWaits.push(ms),
  });

  assert.deepEqual(busyWaits, [1]);
});

test('sync sleep busy-waits after resource temporarily unavailable spawn errors', () => {
  const err = new Error('spawn failed: resource temporarily unavailable');
  const busyWaits = [];

  sleepSync(1, {
    atomicsWaitImpl: null,
    sharedArrayBufferImpl: null,
    spawnSyncImpl: () => ({ error: err }),
    busyWaitImpl: (ms) => busyWaits.push(ms),
  });

  assert.deepEqual(busyWaits, [1]);
});

test('sync sleep throws on premature fallback subprocess exit instead of busy waiting', () => {
  assert.throws(() => sleepSync(5, {
    atomicsWaitImpl: null,
    sharedArrayBufferImpl: null,
    spawnSyncImpl: () => ({ status: 1 }),
  }), /sleep exited with status 1/);
});

test('sync sleep still throws unexpected spawn errors', () => {
  const err = new Error('spawn EACCES');
  err.code = 'EACCES';

  assert.throws(
    () => sleepSync(1, {
      atomicsWaitImpl: null,
      sharedArrayBufferImpl: null,
      spawnSyncImpl: () => ({ error: err }),
    }),
    /spawn EACCES/
  );
});
