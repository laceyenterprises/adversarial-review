import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { sleepSync, withSqliteBusyRetrySync } from '../src/sqlite-busy-retry.mjs';

test('sync sqlite busy retry no longer depends on Atomics.wait', () => {
  const source = readFileSync(new URL('../src/sqlite-busy-retry.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Atomics\.wait/);
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

test('sync sleep falls back to busy wait on transient spawn resource errors', () => {
  const err = new Error('spawn EAGAIN');
  err.code = 'EAGAIN';

  assert.doesNotThrow(() => sleepSync(1, {
    spawnSyncImpl: () => ({ error: err }),
  }));
});

test('sync sleep still throws unexpected spawn errors', () => {
  const err = new Error('spawn EACCES');
  err.code = 'EACCES';

  assert.throws(
    () => sleepSync(1, {
      spawnSyncImpl: () => ({ error: err }),
    }),
    /spawn EACCES/
  );
});
