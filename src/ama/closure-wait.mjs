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
  now = Date.now(), env = process.env, pageImpl = page, immediate = false }) {
  const requested = Number(env.AMA_CLOSURE_WAIT_BOUND_MS);
  const boundMs = Number.isFinite(requested) && requested > 0 ? requested : CLOSURE_WAIT_BOUND_MS;
  const dir = join(rootDir, 'data', 'ama-closure-waits');
  mkdirSync(dir, { recursive: true });
  const key = createHash('sha256').update(`${repo}#${prNumber}`).digest('hex');
  const db = new Database(join(dir, `${key}.db`));
  try {
    db.exec('CREATE TABLE IF NOT EXISTS waits (head TEXT PRIMARY KEY, started INTEGER NOT NULL, reason TEXT, paged INTEGER DEFAULT 0)');
    const result = db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO waits(head, started, reason) VALUES (?, ?, ?)').run(headSha, now, reason);
      db.prepare('UPDATE waits SET reason=? WHERE head=?').run(reason, headSha);
      const row = db.prepare('SELECT * FROM waits WHERE head=?').get(headSha);
      const exhausted = immediate || now - row.started >= boundMs;
      const notify = exhausted && db.prepare('UPDATE waits SET paged=1 WHERE head=? AND paged=0').run(headSha).changes === 1;
      return { exhausted, notify, startedAt: row.started, boundedMs: boundMs };
    }).immediate();
    if (result.notify) {
      try {
        await pageImpl(`HAMCLOSE-01 closure wait exhausted: ${repo} PR ${prNumber}@${headSha}: ${reason}`, {
          source: 'hamclose-closure-wait', severity: 'SEV1', dedupKey: `hamclose:${repo}:${prNumber}:${headSha}`,
        });
      } catch (error) {
        db.prepare('UPDATE waits SET paged=0 WHERE head=?').run(headSha);
        throw error;
      }
    }
    return { ...result, retryAfterMs: CLOSURE_WAIT_RETRY_MS, reason };
  } finally { db.close(); }
}
