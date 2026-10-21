import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
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
  now = Date.now(), env = process.env, pageImpl = page, immediate = false, waitClass = null, startedAt = null, progress = false,
  launchWait = null, launchAlive = false }) {
  const reasonClass = waitClass || (immediate ? 'primary-change' : 'bounded-wait');
  const requested = Number(env.AMA_CLOSURE_WAIT_BOUND_MS);
  const baseMs = Number.isFinite(requested) && requested > 0 ? requested : CLOSURE_WAIT_BOUND_MS;
  const boundMs = loadAwareTimeoutMs(baseMs, { maxMs: Infinity });
  const dir = join(rootDir, 'data', 'ama-closure-waits');
  mkdirSync(dir, { recursive: true });
  const key = createHash('sha256').update(`${repo}#${prNumber}`).digest('hex');
  const db = new Database(join(dir, `${key}.db`));
  try {
    db.exec('CREATE TABLE IF NOT EXISTS waits_by_class (head TEXT, class TEXT, started INTEGER NOT NULL, reason TEXT, paged INTEGER DEFAULT 0, PRIMARY KEY(head, class))');
    const result = db.transaction(() => {
      if (reasonClass === 'final-round') {
        // One receipt per PR: a new head is progress, not a new page budget.
        const previous = db.prepare('SELECT head FROM waits_by_class WHERE class=? ORDER BY started DESC LIMIT 1').get(reasonClass);
        if (previous && previous.head !== headSha) {
          const paged = db.prepare('SELECT MAX(paged) AS paged FROM waits_by_class WHERE class=?').get(reasonClass).paged;
          db.prepare('DELETE FROM waits_by_class WHERE class=?').run(reasonClass);
          db.prepare('INSERT INTO waits_by_class(head,class,started,reason,paged) VALUES (?,?,?,?,?)')
            .run(headSha, reasonClass, now, reason, paged);
        }
      }
      db.prepare('INSERT OR IGNORE INTO waits_by_class(head, class, started, reason) VALUES (?, ?, ?, ?)').run(headSha, reasonClass, Number.isFinite(startedAt) ? Math.min(now, startedAt) : now, reason);
      db.prepare('UPDATE waits_by_class SET reason=? WHERE head=? AND class=?').run(reason, headSha, reasonClass);
      // Retained launches carry durable progress timestamps. Apply them to an
      // existing final-round wait too. Ignore future timestamps here so clock
      // skew cannot turn each poll into fresh progress.
      if (reasonClass === 'final-round' && Number.isFinite(startedAt) && startedAt <= now) {
        db.prepare('UPDATE waits_by_class SET started=MAX(started, ?) WHERE head=? AND class=?')
          .run(startedAt, headSha, reasonClass);
      }
      const row = db.prepare('SELECT * FROM waits_by_class WHERE head=? AND class=?').get(headSha, reasonClass);
      if (progress) db.prepare('UPDATE waits_by_class SET started=? WHERE head=? AND class=?').run(now, headSha, reasonClass);
      // A running background launch borrows its own execution window without
      // erasing the original wait debt. Refusal or restart removes this credit.
      const launching = reasonClass === 'final-round' && Number.isFinite(launchWait?.startedAt)
        && launchWait.startedAt <= now && Number.isFinite(launchWait.boundMs) && launchWait.boundMs > 0;
      const exhausted = immediate || (launching
        ? now - launchWait.startedAt >= launchWait.boundMs
        : !progress && now - row.started >= boundMs);
      const notify = exhausted && db.prepare('UPDATE waits_by_class SET paged=1 WHERE head=? AND class=? AND paged=0').run(headSha, reasonClass).changes === 1;
      return { exhausted, notify, startedAt: launching ? launchWait.startedAt : progress ? now : row.started,
        boundedMs: launching ? launchWait.boundMs : boundMs };
    }).immediate();
    if (result.notify) {
      try {
        const notice = launchAlive && !immediate
          ? `closure still running after ${Math.floor((now - result.startedAt) / 60_000)} minutes`
          : 'closure wait exhausted';
        await pageImpl(`HAMCLOSE-01 ${notice}: ${repo} PR ${prNumber}@${headSha}: ${reason}`, {
          source: 'hamclose-closure-wait', severity: 'SEV1', dedupKey: `hamclose:${repo}:${prNumber}:${headSha}:${reasonClass}`,
        });
      } catch (error) {
        if (reasonClass === 'final-round') db.prepare('UPDATE waits_by_class SET paged=0 WHERE class=?').run(reasonClass);
        else db.prepare('UPDATE waits_by_class SET paged=0 WHERE head=? AND class=?').run(headSha, reasonClass);
        throw error;
      }
    }
    return { ...result, retryAfterMs: CLOSURE_WAIT_RETRY_MS, reason };
  } finally { db.close(); }
}
