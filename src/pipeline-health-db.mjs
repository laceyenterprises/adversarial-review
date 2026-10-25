/** Shared read-only database opener for health projections. No schema writes. */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function openReviewStateReadOnlyDb(rootDir) {
  const dbPath = join(rootDir, 'data', 'reviews.db');
  if (!existsSync(dbPath)) {
    return {
      db: null,
      status: { path: dbPath, exists: false, readable: false, error: 'missing' },
    };
  }
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    db.pragma('query_only = 1');
    return {
      db,
      status: { path: dbPath, exists: true, readable: true, error: null },
    };
  } catch (error) {
    return {
      db: null,
      status: {
        path: dbPath,
        exists: true,
        readable: false,
        error: error?.code || error?.message || 'open-failed',
      },
    };
  }
}
