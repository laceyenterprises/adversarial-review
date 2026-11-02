import { withRepositoryStateCycle } from '../repository-state-lock.mjs';
import { canonicalRepositoryArguments } from '../repository-names.mjs';
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
export async function observeClosureWait(args = {}) {
  return withRepositoryStateCycle(args.rootDir, () => observeClosureWaitWithinRepositoryCycle(canonicalRepositoryArguments(args.rootDir, args)));
}

async function observeClosureWaitWithinRepositoryCycle({ rootDir, repo, prNumber, headSha, reason,
  now = Date.now(), env = process.env, pageImpl = page, immediate = false, waitClass = null, startedAt = null, progress = false,
  launchWait = null, launchAlive = false, anchorOnly = false, repeatAfterMs = null }) {
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
    db.transaction(() => {
      if (!db.prepare('PRAGMA table_info(waits_by_class)').all().some(column => column.name === 'last_paged')) {
        db.exec('ALTER TABLE waits_by_class ADD COLUMN last_paged INTEGER');
      }
    }).immediate();
    const result = db.transaction(() => {
      if (['final-round', 'closure-lifetime-exhausted'].includes(reasonClass)) {
        // One receipt per PR: a new head is progress, not a new page budget.
        const previous = db.prepare('SELECT head FROM waits_by_class WHERE class=? ORDER BY started DESC LIMIT 1').get(reasonClass);
        if (previous && previous.head !== headSha) {
          const paged = db.prepare('SELECT MAX(paged) AS paged FROM waits_by_class WHERE class=?').get(reasonClass).paged;
          db.prepare('DELETE FROM waits_by_class WHERE class=?').run(reasonClass);
          db.prepare('INSERT INTO waits_by_class(head,class,started,reason,paged) VALUES (?,?,?,?,?)')
            .run(headSha, reasonClass, now, reason, paged);
        }
      }
      const firstObserved = db.prepare('INSERT OR IGNORE INTO waits_by_class(head, class, started, reason) VALUES (?, ?, ?, ?)')
        .run(headSha, reasonClass, Number.isFinite(startedAt) ? Math.min(now, startedAt) : now, reason).changes === 1;
      db.prepare('UPDATE waits_by_class SET reason=? WHERE head=? AND class=?').run(reason, headSha, reasonClass);
      // Retained launches carry durable progress timestamps. Apply them to an
      // existing final-round wait too. Ignore future timestamps here so clock
      // skew cannot turn each poll into fresh progress.
      if (['final-round', 'closure-lifetime-exhausted'].includes(reasonClass) && Number.isFinite(startedAt) && startedAt <= now) {
        db.prepare('UPDATE waits_by_class SET started=MAX(started, ?) WHERE head=? AND class=?')
          .run(startedAt, headSha, reasonClass);
      }
      const row = db.prepare('SELECT * FROM waits_by_class WHERE head=? AND class=?').get(headSha, reasonClass);
      if (progress) db.prepare('UPDATE waits_by_class SET started=? WHERE head=? AND class=?').run(now, headSha, reasonClass);
      // A running background launch borrows its own execution window without
      // erasing the original wait debt. Refusal or restart removes this credit.
      const launching = ['final-round', 'closure-lifetime-exhausted'].includes(reasonClass) && Number.isFinite(launchWait?.startedAt)
        && launchWait.startedAt <= now && Number.isFinite(launchWait.boundMs) && launchWait.boundMs > 0;
      const exhausted = immediate || (launching
        ? now - launchWait.startedAt >= launchWait.boundMs
        : !progress && now - row.started >= boundMs);
      const repeating = Number.isFinite(repeatAfterMs) && repeatAfterMs > 0;
      const pageDue = !row.paged || (repeating && (row.last_paged === null || now - row.last_paged >= repeatAfterMs));
      const notify = !anchorOnly && exhausted && pageDue;
      if (notify) db.prepare('UPDATE waits_by_class SET paged=1, last_paged=? WHERE head=? AND class=?')
        .run(now, headSha, reasonClass);
      return { exhausted, notify, firstObserved, startedAt: launching ? launchWait.startedAt : progress ? now : row.started,
        previousPaged: row.paged, previousLastPaged: row.last_paged,
        lastPagedAt: notify ? now : row.last_paged,
        boundedMs: launching ? launchWait.boundMs : boundMs };
    }).immediate();
    if (result.notify) {
      try {
        const notice = launchAlive && !immediate
          ? `closure still running after ${Math.floor((now - result.startedAt) / 60_000)} minutes`
          : 'closure wait exhausted';
        await pageImpl(`HAMCLOSE-01 ${notice}: ${repo} PR ${prNumber}@${headSha}: ${reason}`, {
          source: 'hamclose-closure-wait', severity: 'SEV1', dedupKey: `hamclose:${repo}:${prNumber}:${headSha}:${reasonClass}`
            + (Number.isFinite(repeatAfterMs) && repeatAfterMs > 0 ? `:${now}` : ''),
        });
      } catch (error) {
        if (['final-round', 'closure-lifetime-exhausted'].includes(reasonClass)) db.prepare('UPDATE waits_by_class SET paged=0 WHERE class=?').run(reasonClass);
        else db.prepare('UPDATE waits_by_class SET paged=?, last_paged=? WHERE head=? AND class=? AND last_paged=?')
          .run(result.previousPaged, result.previousLastPaged, headSha, reasonClass, now);
        throw error;
      }
    }
    const publicResult = { ...result };
    delete publicResult.previousPaged;
    delete publicResult.previousLastPaged;
    return { ...publicResult, retryAfterMs: CLOSURE_WAIT_RETRY_MS, reason };
  } finally { db.close(); }
}
