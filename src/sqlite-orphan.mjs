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
// We match defensively (code, cause.code, message substring) because
// some better-sqlite3 builds wrap the underlying error and surface the
// code one level deeper. A wrapper layer should not be able to silence
// the recovery path.

const SQLITE_READONLY_DBMOVED = 'SQLITE_READONLY_DBMOVED';

function isSqliteOrphanError(err) {
  if (!err) return false;
  if (err.code === SQLITE_READONLY_DBMOVED) return true;
  if (err.cause && err.cause.code === SQLITE_READONLY_DBMOVED) return true;
  if (typeof err.message === 'string' && err.message.includes(SQLITE_READONLY_DBMOVED)) return true;
  return false;
}

export {
  SQLITE_READONLY_DBMOVED,
  isSqliteOrphanError,
};
