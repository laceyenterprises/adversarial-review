import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HAMMER_WITHDRAWN_RESOLUTION } from './hammer-adjudication.mjs';

// Read-only: missing/legacy/unreadable stores contribute no trusted evidence.
export function readFindingDisputeReservations({ rootDir, repo, prNumber, headSha, logger = console }) {
  if (!rootDir || !repo || !prNumber || !headSha) return [];
  const path = join(rootDir, 'data', 'reviews.db');
  if (!existsSync(path)) return [];
  let db;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    return db.prepare(`SELECT comment_id, comment_author, comment_sha256, head_sha, resolution
      FROM ham_finding_disputes WHERE repo=? AND pr_number=? AND head_sha=?
      AND requests>0 AND comment_id IS NOT NULL AND resolution=?`)
      .all(repo, prNumber, headSha, HAMMER_WITHDRAWN_RESOLUTION);
  } catch (error) {
    logger?.warn?.(`[reviewer] dispute provenance read failed; omitting evidence: ${error?.message || error}`);
    return [];
  } finally { db?.close(); }
}
