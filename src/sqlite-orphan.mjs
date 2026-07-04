// SQLite connection health detection.
//
// SQLite returns `SQLITE_READONLY_DBMOVED` when a connection's
// underlying file has been replaced on disk (the inode the connection
// holds no longer matches the path). better-sqlite3 surfaces this on
// the error's `code` property. The watcher and any other long-lived
// SQLite consumer needs to detect this and respond — the cleanest
// response is to exit cleanly and let launchd's KeepAlive respawn the
// process with a fresh handle, since prepared statements bound to the
// orphaned connection can't be migrated in place.
//
// We match defensively (code, cause.code, message substring) because
// some better-sqlite3 builds wrap the underlying error and surface the
// code one level deeper. A wrapper layer should not be able to silence
// the recovery path. The write canary below broadens the same restart
// path to any connection that accepts write calls without durably
// round-tripping them.

const SQLITE_READONLY_DBMOVED = 'SQLITE_READONLY_DBMOVED';
const SQLITE_WRITE_CANARY_FAILED = 'SQLITE_WRITE_CANARY_FAILED';
const DB_WRITE_CANARY_ID = 'watcher-db-write-canary';

class SqliteWriteCanaryError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'SqliteWriteCanaryError';
    this.code = SQLITE_WRITE_CANARY_FAILED;
    if (options.cause) this.cause = options.cause;
    if (options.expected !== undefined) this.expected = options.expected;
    if (options.actual !== undefined) this.actual = options.actual;
  }
}

function isSqliteOrphanError(err) {
  if (!err) return false;
  if (err.code === SQLITE_READONLY_DBMOVED) return true;
  if (err.code === SQLITE_WRITE_CANARY_FAILED) return true;
  if (err.cause && err.cause.code === SQLITE_READONLY_DBMOVED) return true;
  if (err.cause && err.cause.code === SQLITE_WRITE_CANARY_FAILED) return true;
  if (typeof err.message === 'string' && err.message.includes(SQLITE_READONLY_DBMOVED)) return true;
  if (typeof err.message === 'string' && err.message.includes(SQLITE_WRITE_CANARY_FAILED)) return true;
  return false;
}

function dbWriteCanaryToken({ now = () => new Date(), random = Math.random } = {}) {
  const timestamp = now();
  const iso = timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString();
  return `${iso}:${random().toString(36).slice(2)}`;
}

function assertReviewDbWritesRoundTrip(db, {
  canaryId = DB_WRITE_CANARY_ID,
  token = dbWriteCanaryToken(),
} = {}) {
  let info;
  try {
    db.prepare(
      `INSERT OR IGNORE INTO watcher_db_canary (id, token, updated_at)
       VALUES (?, '', '')`
    ).run(canaryId);
    info = db.prepare(
      `UPDATE watcher_db_canary
          SET token = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(token, canaryId);
  } catch (err) {
    throw new SqliteWriteCanaryError(
      `SQLite write canary failed during write: ${err?.message || err}`,
      { cause: err, expected: token }
    );
  }

  if (info?.changes !== 1) {
    throw new SqliteWriteCanaryError(
      `SQLite write canary did not update exactly one row (changes=${info?.changes ?? 'unknown'})`,
      { expected: token }
    );
  }

  let row;
  try {
    row = db.prepare('SELECT token FROM watcher_db_canary WHERE id = ?').get(canaryId);
  } catch (err) {
    throw new SqliteWriteCanaryError(
      `SQLite write canary failed during read-back: ${err?.message || err}`,
      { cause: err, expected: token }
    );
  }

  if (row?.token !== token) {
    throw new SqliteWriteCanaryError(
      'SQLite write canary read-back mismatch; connection writes are not durable',
      { expected: token, actual: row?.token }
    );
  }

  return { ok: true, token };
}

export {
  DB_WRITE_CANARY_ID,
  SQLITE_READONLY_DBMOVED,
  SQLITE_WRITE_CANARY_FAILED,
  SqliteWriteCanaryError,
  assertReviewDbWritesRoundTrip,
  isSqliteOrphanError,
};
