import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const CLOSURE_WAIT_BOUND_MS = 30 * 60 * 1000;
export const CLOSURE_WAIT_RETRY_MS = 30_000;

async function page(text, options) {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('offline tests must inject pageImpl');
  const { deliverAlert } = await import('../alert-delivery.mjs');
  return deliverAlert(text, options);
}

// SQLite serializes observations across ticks/processes. Reserve the page before
// sending it, refund on transport refusal, and keep the original wait deadline.
export async function observeClosureWait({ rootDir, repo, prNumber, headSha, reason,
  now = Date.now(), env = process.env, pageImpl = page, immediate = false, waitClass = null, startedAt = null, progress = false }) {
  const reasonClass = waitClass || (immediate ? 'primary-change' : 'bounded-wait');
  const requested = Number(env.AMA_CLOSURE_WAIT_BOUND_MS);
  const boundMs = Number.isFinite(requested) && requested > 0 ? requested : CLOSURE_WAIT_BOUND_MS;
  const dir = join(rootDir, 'data', 'ama-closure-waits');
  mkdirSync(dir, { recursive: true });
  const key = createHash('sha256').update(`${repo}#${prNumber}`).digest('hex');
  const db = new Database(join(dir, `${key}.db`));
  try {
    db.exec('CREATE TABLE IF NOT EXISTS waits_by_class (head TEXT, class TEXT, started INTEGER NOT NULL, reason TEXT, paged INTEGER DEFAULT 0, PRIMARY KEY(head, class))');
    const result = db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO waits_by_class(head, class, started, reason) VALUES (?, ?, ?, ?)').run(headSha, reasonClass, Number.isFinite(startedAt) ? Math.min(now, startedAt) : now, reason);
      db.prepare('UPDATE waits_by_class SET reason=? WHERE head=? AND class=?').run(reason, headSha, reasonClass);
      if (progress) db.prepare('UPDATE waits_by_class SET started=? WHERE head=? AND class=?').run(now, headSha, reasonClass);
      const row = db.prepare('SELECT * FROM waits_by_class WHERE head=? AND class=?').get(headSha, reasonClass);
      const exhausted = immediate || now - row.started >= boundMs;
      const notify = exhausted && db.prepare('UPDATE waits_by_class SET paged=1 WHERE head=? AND class=? AND paged=0').run(headSha, reasonClass).changes === 1;
      return { exhausted, notify, startedAt: row.started, boundedMs: boundMs };
    }).immediate();
    if (result.notify) {
      try {
        await pageImpl(`HAMCLOSE-01 closure wait exhausted: ${repo} PR ${prNumber}@${headSha}: ${reason}`, {
          source: 'hamclose-closure-wait', severity: 'SEV1', dedupKey: `hamclose:${repo}:${prNumber}:${headSha}:${reasonClass}`,
        });
      } catch (error) {
        db.prepare('UPDATE waits_by_class SET paged=0 WHERE head=? AND class=?').run(headSha, reasonClass);
        throw error;
      }
    }
    return { ...result, retryAfterMs: CLOSURE_WAIT_RETRY_MS, reason };
  } finally { db.close(); }
}
