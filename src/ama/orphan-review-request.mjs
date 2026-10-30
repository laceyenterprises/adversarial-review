import { withRepositoryStateCycle } from '../repository-state-lock.mjs';
import { canonicalRepositoryArguments } from '../repository-names.mjs';
import Database from 'better-sqlite3';
import fsExt from 'fs-ext';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Share REMORPHAN-01's durable guard and lock. Reserve before the external
// local queue request so concurrent observers or interrupted processes cannot
// spend it twice. A proven local queue failure refunds the reservation.
async function requestBoundedOrphanReviewWithinRepositoryState({ rootDir, repo, prNumber, headSha,
  reviewStateRow, requestRereviewImpl, logger, db = null, decisionReasons = null }) {
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
    let request;
    try {
      request = await requestRereviewImpl({ rootDir, repo, prNumber, targetRevisionRef: headSha,
        reason: `system-orphan-head-review:${headSha}`,
        ...(decisionReasons ? { ownerlessRecovery: true } : {}), logger });
    } catch (error) {
      // This collaborator queues local durable intent; a failed queue operation
      // must not permanently spend the once-per-head request.
      db.prepare('UPDATE heads SET rereview=0 WHERE head=?').run(headSha);
      throw error;
    }
    if (request?.triggered !== true) {
      db.prepare('UPDATE heads SET rereview=0 WHERE head=?').run(headSha);
    } else if (decisionReasons) {
      // Evidence/log failures after a successful queue must not refund it.
      const evidence = { action: 'review', reason: 'rereview-exact-head', reasons: decisionReasons };
      db.prepare('UPDATE heads SET evidence=? WHERE head=?').run(JSON.stringify(evidence), headSha);
      logger?.log?.(`[watcher] requested exact-head re-review for ${repo}#${prNumber}@${headSha}: ${decisionReasons.join(', ')}`);
    }
    return request;
  } finally {
    try { ownedDb?.close(); } finally { if (fd !== undefined) closeSync(fd); }
  }
}

export async function requestBoundedOrphanReview(args = {}, ...rest) {
  return withRepositoryStateCycle(args.rootDir, () =>
    requestBoundedOrphanReviewWithinRepositoryState(canonicalRepositoryArguments(args.rootDir, args), ...rest));
}
