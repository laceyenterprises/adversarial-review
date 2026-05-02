import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SQLITE_READONLY_DBMOVED,
  isSqliteOrphanError,
  looksSqliteShaped,
} from '../src/sqlite-orphan.mjs';

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

test('isSqliteOrphanError ignores plain wrapper messages that merely mention the string', () => {
  // A logged/proxied error that just embeds the canonical string in its
  // text — without any SQLite-shaped code or class — must NOT crash the
  // watcher. This is the regression the message-fallback tightening
  // exists to prevent: cron pipelines, log relays, and IPC wrappers
  // routinely re-emit text containing canonical error names.
  const cases = [
    new Error('Logger relay: upstream reported SQLITE_READONLY_DBMOVED'),
    new Error('SQLITE_READONLY_DBMOVED was the upstream complaint'),
    Object.assign(new Error('SQLITE_READONLY_DBMOVED in stderr'), { code: 'EPIPE' }),
    Object.assign(new Error('SQLITE_READONLY_DBMOVED in stderr'), { name: 'TypeError' }),
  ];
  for (const err of cases) {
    assert.equal(
      isSqliteOrphanError(err),
      false,
      `non-SQLite-shaped wrapper mentioning the string must not match: ${err.message}`
    );
  }
});

test('isSqliteOrphanError matches a SqliteError-named error whose message embeds the string', () => {
  // better-sqlite3's error class is `SqliteError`. If a build surfaces
  // the orphan condition with the canonical string in `.message` but
  // an unset/wrapped `.code`, the message fallback should still fire
  // because the error itself is unambiguously SQLite-shaped.
  const err = new Error(`disk full: SQLITE_READONLY_DBMOVED reported during commit`);
  err.name = 'SqliteError';
  assert.equal(isSqliteOrphanError(err), true);
});

test('isSqliteOrphanError matches when err.code starts with SQLITE_ and message embeds the string', () => {
  // A different SQLite error code surfaced on the outer error, with
  // SQLITE_READONLY_DBMOVED in the message — still SQLite-shaped, so
  // the message fallback fires.
  const err = new Error('SQLITE_READONLY_DBMOVED encountered while writing');
  err.code = 'SQLITE_IOERR';
  assert.equal(isSqliteOrphanError(err), true);
});

test('looksSqliteShaped recognises SqliteError, SQLITE_*-coded, and wrapped causes', () => {
  assert.equal(looksSqliteShaped(Object.assign(new Error('x'), { name: 'SqliteError' })), true);
  assert.equal(looksSqliteShaped(Object.assign(new Error('x'), { code: 'SQLITE_BUSY' })), true);
  const wrapped = new Error('x');
  wrapped.cause = Object.assign(new Error('inner'), { name: 'SqliteError' });
  assert.equal(looksSqliteShaped(wrapped), true);
  assert.equal(looksSqliteShaped(Object.assign(new Error('x'), { code: 'EPIPE' })), false);
  assert.equal(looksSqliteShaped(null), false);
});

test('SQLITE_READONLY_DBMOVED constant is exported as the canonical string', () => {
  assert.equal(SQLITE_READONLY_DBMOVED, 'SQLITE_READONLY_DBMOVED');
});
