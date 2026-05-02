import test from 'node:test';
import assert from 'node:assert/strict';

import { SQLITE_READONLY_DBMOVED, isSqliteOrphanError } from '../src/sqlite-orphan.mjs';

test('isSqliteOrphanError matches better-sqlite3\'s direct code shape', () => {
  // better-sqlite3 surfaces SQLite extended error codes on err.code.
  // SQLITE_READONLY_DBMOVED fires when the underlying file has been
  // replaced on disk and the connection's inode no longer matches.
  const err = new Error('attempt to write a readonly database');
  err.code = SQLITE_READONLY_DBMOVED;
  assert.equal(isSqliteOrphanError(err), true);
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

test('isSqliteOrphanError returns false for non-Error inputs', () => {
  assert.equal(isSqliteOrphanError(null), false);
  assert.equal(isSqliteOrphanError(undefined), false);
  assert.equal(isSqliteOrphanError(''), false);
  assert.equal(isSqliteOrphanError(0), false);
});

test('SQLITE_READONLY_DBMOVED constant is exported as the canonical string', () => {
  assert.equal(SQLITE_READONLY_DBMOVED, 'SQLITE_READONLY_DBMOVED');
});
