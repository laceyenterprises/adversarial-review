// Run with: node --test src/review-state-index.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureReviewStateSchema } from './review-state.mjs';

for (const legacy of [false, true]) {
  test(`readyz failure query uses a bounded index on ${legacy ? 'legacy' : 'fresh'} databases`, (t) => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    if (legacy) {
      // Pre-ended_at schema: convergence must add the column before the index.
      db.exec(`CREATE TABLE reviewer_passes (
        pass_id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
        attempt_number INTEGER NOT NULL, reviewer_class TEXT NOT NULL,
        pass_kind TEXT NOT NULL, started_at TEXT NOT NULL, status TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(repo, pr_number, attempt_number, pass_kind)
      );
      INSERT INTO reviewer_passes
        (repo, pr_number, attempt_number, reviewer_class, pass_kind, started_at, status)
      VALUES ('owner/repo', 1, 1, 'codex', 'first-pass', '2026-11-01', 'failed')`);
    }
    ensureReviewStateSchema(db);
    ensureReviewStateSchema(db);
    if (legacy) {
      assert.equal(db.prepare('SELECT count(*) AS n FROM reviewer_passes').get().n, 1);
    }
    const query = `SELECT metadata_json FROM reviewer_passes
      WHERE status = 'failed' AND ended_at >= ?`;
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all('2026-11-13T00:00:00.000Z');
    assert.ok(plan.some(({ detail }) =>
      /SEARCH reviewer_passes USING INDEX idx_reviewer_passes_status_ended_at \(status=\? AND ended_at>\?\)/.test(detail)
    ), JSON.stringify(plan));
    assert.ok(plan.every(({ detail }) => !/SCAN reviewer_passes/.test(detail)));
  });
}
