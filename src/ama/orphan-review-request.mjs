import Database from 'better-sqlite3';
import fsExt from 'fs-ext';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Share REMORPHAN-01's durable guard and lock. Reserve before the external
// request so a failed request or interrupted process cannot spend it twice.
export async function requestBoundedOrphanReview({ rootDir, repo, prNumber, headSha,
  reviewStateRow, requestRereviewImpl, logger, db = null }) {
  if (reviewStateRow?.review_status === 'failed' && reviewStateRow.reviewer_head_sha === headSha) return null;
  let ownedDb;
  let fd;
  try {
    if (!db) {
      const dir = join(rootDir, 'data', 'follow-up-jobs', 'orphan-watchdog');
      const key = createHash('sha256').update(`${repo}#${prNumber}`).digest('hex');
      mkdirSync(dir, { recursive: true });
      fd = openSync(join(dir, `${key}.lock`), 'a', 0o600);
      try { fsExt.flockSync(fd, 'exnb'); }
      catch (error) { if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) return null; throw error; }
      ownedDb = new Database(join(dir, `${key}.db`));
      db = ownedDb;
      db.exec('CREATE TABLE IF NOT EXISTS heads (head TEXT PRIMARY KEY, ticks INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, paged INTEGER DEFAULT 0, rereview INTEGER DEFAULT 0, evidence TEXT)');
    }
    db.prepare('INSERT OR IGNORE INTO heads(head) VALUES (?)').run(headSha);
    if (!db.prepare('UPDATE heads SET rereview=1 WHERE head=? AND rereview=0').run(headSha).changes) return null;
    return await requestRereviewImpl({ rootDir, repo, prNumber, targetRevisionRef: headSha,
      reason: `system-orphan-head-review:${headSha}`, logger });
  } finally {
    try { ownedDb?.close(); } finally { if (fd !== undefined) closeSync(fd); }
  }
}
