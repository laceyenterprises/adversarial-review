import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Refusals retain the merge hold. The closer owns scoped recovery; this store
// only counts observations and deduplicates its SEV1 page.
export async function recordPrimaryChangeRefusal({ rootDir, repo, prNumber, headSha, reasons }, {
  page, logger = console,
}) {
  if (!rootDir || !repo || !headSha) return;
  mkdirSync(join(rootDir, 'data'), { recursive: true });
  const db = new Database(join(rootDir, 'data', 'ham-primary-change-refusals.db'));
  try {
    db.pragma('busy_timeout = 5000');
    db.exec(`CREATE TABLE IF NOT EXISTS refusals (
      repo TEXT, pr INTEGER, head TEXT, count INTEGER DEFAULT 0, paged INTEGER DEFAULT 0,
      PRIMARY KEY(repo, pr, head))`);
    const key = [repo, prNumber, headSha];
    const shouldPage = db.transaction(() => {
      db.prepare('INSERT INTO refusals(repo, pr, head, count) VALUES (?, ?, ?, 1) ON CONFLICT(repo, pr, head) DO UPDATE SET count=count+1').run(...key);
      return db.prepare('UPDATE refusals SET paged=1 WHERE repo=? AND pr=? AND head=? AND count>=3 AND paged=0').run(...key).changes === 1;
    }).immediate();
    if (shouldPage) {
      const payload = { severity: 'SEV1', repo, prNumber, headSha, reasons };
      logger.error?.(JSON.stringify({ event: 'ama_primary_change_refusal_exhausted', ...payload }));
      await page(`SEV1: repeated primary-change refusal for ${repo}#${prNumber}`, {
        event: 'ama_primary_change_refusal_exhausted', payload,
      });
    }
  } finally { db.close(); }
}
