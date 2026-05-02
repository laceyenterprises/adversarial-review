// SQLite inode-orphan detection.
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
// Detection precedence (strongest signal first, weakest last):
//   1. err.code === 'SQLITE_READONLY_DBMOVED'        (better-sqlite3 native shape)
//   2. err.cause?.code === 'SQLITE_READONLY_DBMOVED' (one wrapper layer deep)
//   3. message text contains the canonical string AND the error otherwise
//      looks SQLite-shaped (SqliteError name, or a code that starts with
//      SQLITE_). The message-only path is intentionally gated: any error
//      that merely mentions the string in its text — a logged message, a
//      proxy wrapper, a downstream summarization — must NOT trigger a
//      process-level recovery exit, because doing so would convert
//      ordinary error reporting into a fatal restart cycle.

const SQLITE_READONLY_DBMOVED = 'SQLITE_READONLY_DBMOVED';

function looksSqliteShaped(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.name === 'SqliteError') return true;
  if (typeof err.code === 'string' && err.code.startsWith('SQLITE_')) return true;
  if (err.cause && typeof err.cause === 'object') {
    if (err.cause.name === 'SqliteError') return true;
    if (typeof err.cause.code === 'string' && err.cause.code.startsWith('SQLITE_')) return true;
  }
  return false;
}

function isSqliteOrphanError(err) {
  if (!err) return false;
  if (err.code === SQLITE_READONLY_DBMOVED) return true;
  if (err.cause && err.cause.code === SQLITE_READONLY_DBMOVED) return true;
  // Message fallback is gated on the error otherwise looking SQLite-shaped,
  // so a wrapper that merely logs the string ("[reviewer] saw
  // SQLITE_READONLY_DBMOVED in upstream output") cannot crash the watcher.
  if (
    typeof err.message === 'string' &&
    err.message.includes(SQLITE_READONLY_DBMOVED) &&
    looksSqliteShaped(err)
  ) {
    return true;
  }
  return false;
}

export {
  SQLITE_READONLY_DBMOVED,
  isSqliteOrphanError,
  looksSqliteShaped,
};
