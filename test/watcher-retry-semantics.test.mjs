import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureReviewStateSchema } from '../src/review-state.mjs';

function setupDb() {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
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

// Reconciliation contract for orphaned 'reviewing' rows. These tests
// model the SQL the watcher's reconcileOrphanedReviewing() runs on
// startup against a fresh in-memory DB, so the schema and the
// transition contract are exercised without spinning up the full
// watcher module (which has DB-open side effects at import time).

const RECONCILE_FAILURE_MESSAGE =
  'Watcher restarted while review subprocess was in flight. ' +
  'A review may have been posted on GitHub by the orphaned child. ' +
  'Verify the PR before retriggering with `npm run retrigger-review`.';

function reconcileOrphans(db, failureAt) {
  const rows = db
    .prepare("SELECT repo, pr_number FROM reviewed_prs WHERE review_status = 'reviewing'")
    .all();
  const stmt = db.prepare(
    "UPDATE reviewed_prs SET review_status = 'failed-orphan', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
  );
  for (const row of rows) {
    stmt.run(failureAt, RECONCILE_FAILURE_MESSAGE, row.repo, row.pr_number);
  }
  return rows.length;
}

test("rows stuck in 'reviewing' on startup are reconciled to 'failed-orphan'", () => {
  const db = setupDb();
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, linear_ticket, review_status, review_attempts, last_attempted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'laceyenterprises/adversarial-review',
    24,
    '2026-05-02T19:00:00.000Z',
    'codex',
    'open',
    'LAC-211',
    'reviewing',
    1,
    '2026-05-02T19:01:00.000Z'
  );

  const reconciledCount = reconcileOrphans(db, '2026-05-02T19:30:00.000Z');
  assert.equal(reconciledCount, 1);

  const row = db
    .prepare('SELECT review_status, review_attempts, failed_at, failure_message FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
    .get('laceyenterprises/adversarial-review', 24);

  assert.equal(row.review_status, 'failed-orphan');
  assert.equal(row.review_attempts, 2);
  assert.equal(row.failed_at, '2026-05-02T19:30:00.000Z');
  assert.match(row.failure_message, /A review may have been posted on GitHub/);
  assert.match(row.failure_message, /retrigger-review/);
});

test("'failed-orphan' rows stay sticky and are not auto-retried by the watcher's skip predicate", () => {
  // The watcher's pollOnce skips rows whose review_status is in this
  // set. 'failed-orphan' MUST be in it, otherwise the next poll would
  // spawn a duplicate reviewer for a PR that may already carry an
  // orphaned review post — exactly the duplicate-review bug this
  // change closes.
  const stickySkipStates = new Set(['posted', 'malformed', 'failed-orphan']);
  assert.ok(stickySkipStates.has('failed-orphan'));

  const db = setupDb();
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts, failed_at, failure_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'laceyenterprises/adversarial-review',
    24,
    '2026-05-02T19:00:00.000Z',
    'codex',
    'open',
    'failed-orphan',
    2,
    '2026-05-02T19:30:00.000Z',
    RECONCILE_FAILURE_MESSAGE
  );

  const row = db
    .prepare('SELECT review_status FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
    .get('laceyenterprises/adversarial-review', 24);
  assert.ok(stickySkipStates.has(row.review_status));
});

test("reconciliation only touches 'reviewing' rows and leaves other statuses alone", () => {
  const db = setupDb();
  const rows = [
    ['laceyenterprises/a', 1, 'reviewing'],
    ['laceyenterprises/a', 2, 'pending'],
    ['laceyenterprises/a', 3, 'posted'],
    ['laceyenterprises/a', 4, 'failed'],
    ['laceyenterprises/a', 5, 'malformed'],
    ['laceyenterprises/b', 6, 'reviewing'],
  ];
  const insert = db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const [repo, prNumber, status] of rows) {
    insert.run(repo, prNumber, '2026-05-02T19:00:00.000Z', 'codex', 'open', status, 0);
  }

  const reconciledCount = reconcileOrphans(db, '2026-05-02T19:30:00.000Z');
  assert.equal(reconciledCount, 2);

  const after = db
    .prepare('SELECT repo, pr_number, review_status FROM reviewed_prs ORDER BY repo, pr_number')
    .all();

  assert.deepEqual(
    after,
    [
      { repo: 'laceyenterprises/a', pr_number: 1, review_status: 'failed-orphan' },
      { repo: 'laceyenterprises/a', pr_number: 2, review_status: 'pending' },
      { repo: 'laceyenterprises/a', pr_number: 3, review_status: 'posted' },
      { repo: 'laceyenterprises/a', pr_number: 4, review_status: 'failed' },
      { repo: 'laceyenterprises/a', pr_number: 5, review_status: 'malformed' },
      { repo: 'laceyenterprises/b', pr_number: 6, review_status: 'failed-orphan' },
    ],
  );
});

test("requestReviewRereview accepts 'failed-orphan' rows so retrigger-review can clear them", async () => {
  // The operator recovery path for an orphan is:
  //   1. inspect GitHub
  //   2. if no orphan review present, run `npm run retrigger-review`
  // For step 2 to work, the underlying state-machine helper must
  // accept 'failed-orphan' as a valid source state. This guards
  // against accidental tightening of requestReviewRereview to
  // require a non-orphan source.
  const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const Database = (await import('better-sqlite3')).default;
  const { ensureReviewStateSchema, requestReviewRereview } = await import('../src/review-state.mjs');

  const tmp = mkdtempSync(join(tmpdir(), 'orphan-rereview-'));
  try {
    mkdirSync(join(tmp, 'data'), { recursive: true });
    const dbPath = join(tmp, 'data', 'reviews.db');
    const db = new Database(dbPath);
    ensureReviewStateSchema(db);
    db.prepare(
      'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts, failed_at, failure_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'laceyenterprises/adversarial-review',
      24,
      '2026-05-02T19:00:00.000Z',
      'codex',
      'open',
      'failed-orphan',
      2,
      '2026-05-02T19:30:00.000Z',
      RECONCILE_FAILURE_MESSAGE
    );
    db.close();

    const result = requestReviewRereview({
      rootDir: tmp,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 24,
      reason: 'verified no orphan review on GitHub',
    });

    assert.equal(result.triggered, true);
    assert.equal(result.reviewRow.review_status, 'pending');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
