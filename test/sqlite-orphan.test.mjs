import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SQLITE_READONLY_DBMOVED,
  SQLITE_WRITE_CANARY_FAILED,
  SqliteWriteCanaryError,
  assertReviewDbWritesRoundTrip,
  isSqliteOrphanError,
} from '../src/sqlite-orphan.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { handlePollError } from '../src/watcher.mjs';

function withTempReviewDb(fn) {
  const rootDir = mkdtempSync(join(tmpdir(), 'sqlite-canary-'));
  try {
    const db = openReviewStateDb(rootDir);
    try {
      ensureReviewStateSchema(db);
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

async function captureExitFromHandlePollError(err) {
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  const calls = [];
  let timeout;
  let resolveExit;
  const exitCalled = new Promise((resolve) => {
    resolveExit = resolve;
  });
  process.exitCode = undefined;
  process.exit = (code) => {
    process.exitCode = code;
    calls.push(code);
    resolveExit({ exitCode: process.exitCode, calls: [...calls] });
  };
  try {
    handlePollError(err, 'test db canary');
    return await Promise.race([
      exitCalled,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('timed out waiting for process.exit')),
          1000
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    process.exit = originalExit;
    process.exitCode = originalExitCode;
  }
}

test('isSqliteOrphanError matches better-sqlite3\'s direct code shape', () => {
  // better-sqlite3 surfaces SQLite extended error codes on err.code.
  // SQLITE_READONLY_DBMOVED fires when the underlying file has been
  // replaced on disk and the connection's inode no longer matches.
  const err = new Error('attempt to write a readonly database');
  err.code = SQLITE_READONLY_DBMOVED;
  assert.equal(isSqliteOrphanError(err), true);
});

test('isSqliteOrphanError matches DB write-canary failures', () => {
  assert.equal(
    isSqliteOrphanError(new SqliteWriteCanaryError('read-back mismatch')),
    true
  );
});

test('isSqliteOrphanError matches a wrapped err.cause.code', () => {
  // Some wrapper layers move the original SQLite code into err.cause.
  // The recovery path must not be silenced by a wrapper.
  const cause = new Error('attempt to write a readonly database');
  cause.code = SQLITE_READONLY_DBMOVED;
  const wrapped = new Error('proxy error');
  wrapped.cause = cause;
  assert.equal(isSqliteOrphanError(wrapped), true);
});

test('isSqliteOrphanError matches when the code is in the message text', () => {
  // Belt-and-suspenders: an error whose `.code` is something else but
  // whose message embeds the canonical string still routes through
  // recovery. This catches log-line failures and exotic wrappers.
  const err = new Error('Got SQLITE_READONLY_DBMOVED on prepared statement');
  assert.equal(isSqliteOrphanError(err), true);
});

test('isSqliteOrphanError returns false for unrelated SQLite errors', () => {
  // The recovery path is specifically scoped to inode-orphan recovery.
  // Normal SQLite errors (constraint violations, busy timeouts, etc.)
  // must NOT trigger a process exit.
  const cases = [
    { code: 'SQLITE_BUSY', message: 'database is locked' },
    { code: 'SQLITE_CONSTRAINT', message: 'UNIQUE constraint failed' },
    { code: 'SQLITE_CORRUPT', message: 'database disk image is malformed' },
    { code: 'SQLITE_READONLY', message: 'attempt to write a readonly database' }, // prefix only
  ];
  for (const { code, message } of cases) {
    const err = new Error(message);
    err.code = code;
    assert.equal(
      isSqliteOrphanError(err), false,
      `${code} must NOT be treated as an orphan error`
    );
  }
});

test('assertReviewDbWritesRoundTrip updates and reads back the canary row on a healthy DB', () => {
  withTempReviewDb((db) => {
    const result = assertReviewDbWritesRoundTrip(db, { token: 'healthy-token' });

    assert.deepEqual(result, { ok: true, token: 'healthy-token' });
    assert.deepEqual(
      db.prepare('SELECT id, token FROM watcher_db_canary').all(),
      [{ id: 'watcher-db-write-canary', token: 'healthy-token' }]
    );
  });
});

test('assertReviewDbWritesRoundTrip trips when writes silently no-op', () => {
  const fakeDb = {
    prepare(sql) {
      if (sql.includes('INSERT OR IGNORE')) {
        return { run: () => ({ changes: 1 }) };
      }
      if (sql.includes('UPDATE watcher_db_canary')) {
        return { run: () => ({ changes: 1 }) };
      }
      if (sql.includes('SELECT token')) {
        return { get: () => ({ token: 'stale-token' }) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  assert.throws(
    () => assertReviewDbWritesRoundTrip(fakeDb, { token: 'fresh-token' }),
    (err) => {
      assert.equal(err.code, SQLITE_WRITE_CANARY_FAILED);
      assert.equal(err.expected, 'fresh-token');
      assert.equal(err.actual, 'stale-token');
      return true;
    }
  );
});

test('watcher DB write-canary failure exits 75 for launchd respawn', async () => {
  const result = await captureExitFromHandlePollError(
    new SqliteWriteCanaryError('connection writes are silently no-oping')
  );

  assert.equal(result.exitCode, 75);
  assert.deepEqual(result.calls, [75]);
});

test('watcher inode-orphan detection still exits 75 for launchd respawn', async () => {
  const err = new Error('attempt to write a readonly database');
  err.code = SQLITE_READONLY_DBMOVED;

  const result = await captureExitFromHandlePollError(err);

  assert.equal(result.exitCode, 75);
  assert.deepEqual(result.calls, [75]);
});

test('isSqliteOrphanError returns false for non-Error inputs', () => {
  assert.equal(isSqliteOrphanError(null), false);
  assert.equal(isSqliteOrphanError(undefined), false);
  assert.equal(isSqliteOrphanError(''), false);
  assert.equal(isSqliteOrphanError(0), false);
});

test('SQLITE_READONLY_DBMOVED constant is exported as the canonical string', () => {
  assert.equal(SQLITE_READONLY_DBMOVED, 'SQLITE_READONLY_DBMOVED');
});

test('SQLITE_WRITE_CANARY_FAILED constant is exported as the canonical string', () => {
  assert.equal(SQLITE_WRITE_CANARY_FAILED, 'SQLITE_WRITE_CANARY_FAILED');
});
