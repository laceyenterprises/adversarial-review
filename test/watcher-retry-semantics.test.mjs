import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

function setupDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE reviewed_prs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      repo              TEXT NOT NULL,
      pr_number         INTEGER NOT NULL,
      reviewed_at       TEXT NOT NULL,
      reviewer          TEXT NOT NULL,
      pr_state          TEXT NOT NULL DEFAULT 'open',
      merged_at         TEXT,
      closed_at         TEXT,
      linear_ticket     TEXT,
      review_status     TEXT NOT NULL DEFAULT 'posted',
      review_attempts   INTEGER NOT NULL DEFAULT 0,
      last_attempted_at TEXT,
      posted_at         TEXT,
      failed_at         TEXT,
      failure_message   TEXT,
      UNIQUE(repo, pr_number)
    )
  `);
  return db;
}

test('posted PRs remain terminal and are skipped', () => {
  const db = setupDb();
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, linear_ticket, review_status, review_attempts, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'laceyenterprises/adversarial-review',
    5,
    '2026-04-22T05:22:42.212Z',
    'claude',
    'open',
    'LAC-207',
    'posted',
    1,
    '2026-04-22T05:24:00.000Z'
  );

  const row = db.prepare('SELECT review_status, review_attempts, posted_at FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(
    'laceyenterprises/adversarial-review',
    5
  );

  assert.equal(row.review_status, 'posted');
  assert.equal(row.review_attempts, 1);
  assert.equal(row.posted_at, '2026-04-22T05:24:00.000Z');
});

test('failed delivery remains visible and retryable', () => {
  const db = setupDb();
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, linear_ticket, review_status, review_attempts, failed_at, failure_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'laceyenterprises/adversarial-review',
    5,
    '2026-04-22T05:22:42.212Z',
    'claude',
    'open',
    'LAC-207',
    'failed',
    1,
    '2026-04-22T05:23:00.000Z',
    'gh config permission denied'
  );

  const row = db.prepare('SELECT review_status, review_attempts, failed_at, failure_message FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(
    'laceyenterprises/adversarial-review',
    5
  );

  assert.equal(row.review_status, 'failed');
  assert.equal(row.review_attempts, 1);
  assert.match(row.failure_message, /permission denied/);
});

test('malformed titles are terminal but explicitly marked malformed', () => {
  const db = setupDb();
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts, failed_at, failure_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'laceyenterprises/adversarial-review',
    9,
    '2026-04-22T06:00:00.000Z',
    'malformed-title',
    'open',
    'malformed',
    1,
    '2026-04-22T06:00:00.000Z',
    'Malformed PR title: fix bug'
  );

  const row = db.prepare('SELECT reviewer, review_status, failure_message FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(
    'laceyenterprises/adversarial-review',
    9
  );

  assert.equal(row.reviewer, 'malformed-title');
  assert.equal(row.review_status, 'malformed');
  assert.match(row.failure_message, /Malformed PR title/);
});
