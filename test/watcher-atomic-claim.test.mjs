import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { ensureReviewStateSchema } from '../src/review-state.mjs';

// The atomic-claim SQL lives inline in src/watcher.mjs (it's bound to
// the module's prepared-statement set there). The watcher module has
// import-time side effects (opens reviews.db, registers process
// handlers) that we don't want in unit tests, so we re-derive the same
// SQL here and assert against it. If the watcher's SQL ever drifts
// from this, both copies will fail their respective callers' tests
// long before that drift can ship — keep them in sync.
//
// This is the cross-process layer of the duplicate-spawn guard. The
// in-process layer is the watcher's self-scheduling pollOnce loop.
// Together they close the duplicate-spawn vector at both layers.
const CLAIM_SQL = `UPDATE reviewed_prs
     SET review_status = 'reviewing',
         last_attempted_at = ?,
         failed_at = NULL,
         failure_message = NULL
   WHERE repo = ?
     AND pr_number = ?
     AND review_status IN ('pending', 'failed')`;

const REPO = 'laceyenterprises/agent-os';
const PR = 999;

function setupDb() {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  return db;
}

function seedReviewRow(db, { reviewStatus, lastAttemptedAt = null, failureMessage = null }) {
  db.prepare(
    `INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
        review_attempts, last_attempted_at, failure_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    REPO,
    PR,
    '2026-05-02T18:00:00.000Z',
    'claude',
    'open',
    reviewStatus,
    0,
    lastAttemptedAt,
    failureMessage
  );
}

function readRow(db) {
  return db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(REPO, PR);
}

test('atomic claim succeeds for a pending row and flips status to reviewing', () => {
  const db = setupDb();
  seedReviewRow(db, { reviewStatus: 'pending' });

  const claim = db.prepare(CLAIM_SQL).run(
    '2026-05-02T18:10:00.000Z',
    REPO,
    PR
  );

  assert.equal(claim.changes, 1);
  const row = readRow(db);
  assert.equal(row.review_status, 'reviewing');
  assert.equal(row.last_attempted_at, '2026-05-02T18:10:00.000Z');
  assert.equal(row.failed_at, null);
  assert.equal(row.failure_message, null);
});

test('atomic claim succeeds for a failed row (preserves auto-retry contract)', () => {
  // Pre-CAS, the watcher loop treated 'failed' rows as eligible for
  // automatic retry on the next poll. The CAS preserves that contract:
  // 'failed' rows match and are reclaimed.
  const db = setupDb();
  seedReviewRow(db, { reviewStatus: 'failed', failureMessage: 'transient OAuth failure' });

  const claim = db.prepare(CLAIM_SQL).run(
    '2026-05-02T18:10:00.000Z',
    REPO,
    PR
  );

  assert.equal(claim.changes, 1, 'failed rows must remain auto-retryable');
  const row = readRow(db);
  assert.equal(row.review_status, 'reviewing');
  assert.equal(row.failure_message, null, 'previous failure_message is cleared on re-claim');
});

test('atomic claim refuses when status is already reviewing (in-flight claim)', () => {
  const db = setupDb();
  seedReviewRow(db, {
    reviewStatus: 'reviewing',
    lastAttemptedAt: '2026-05-02T18:09:00.000Z',
  });

  const claim = db.prepare(CLAIM_SQL).run(
    '2026-05-02T18:10:00.000Z',
    REPO,
    PR
  );

  assert.equal(claim.changes, 0, 'claim must lose the race against an in-flight reviewer');
  const row = readRow(db);
  assert.equal(row.review_status, 'reviewing');
  assert.equal(row.last_attempted_at, '2026-05-02T18:09:00.000Z', 'last_attempted_at unchanged');
});

test('atomic claim refuses for terminal and orphan-locked statuses', () => {
  // 'posted' / 'malformed' are terminal. 'failed-orphan' is the sticky
  // operator-recovery state set by reconcileOrphanedReviewing — auto-
  // reclaiming it would erase the GitHub-side-verified-or-not signal
  // that a previous reviewer subprocess may already have posted.
  for (const status of ['posted', 'malformed', 'failed-orphan']) {
    const db = setupDb();
    seedReviewRow(db, { reviewStatus: status });

    const claim = db.prepare(CLAIM_SQL).run(
      '2026-05-02T18:10:00.000Z',
      REPO,
      PR
    );

    assert.equal(claim.changes, 0, `claim must refuse status='${status}'`);
    const row = readRow(db);
    assert.equal(row.review_status, status, `status='${status}' unchanged`);
  }
});

test('atomic claim simulates a real two-process race — only one wins', () => {
  // SQLite serializes the two UPDATEs; only one should match the
  // WHERE clause's status='pending' arm. The second sees the row
  // already at 'reviewing' and refuses.
  const db = setupDb();
  seedReviewRow(db, { reviewStatus: 'pending' });

  const claimA = db.prepare(CLAIM_SQL).run(
    '2026-05-02T18:10:00.000Z',
    REPO,
    PR
  );
  const claimB = db.prepare(CLAIM_SQL).run(
    '2026-05-02T18:10:00.001Z',
    REPO,
    PR
  );

  assert.equal(claimA.changes, 1, 'first claim wins');
  assert.equal(claimB.changes, 0, 'second claim loses — status is no longer pending');
  const row = readRow(db);
  assert.equal(row.review_status, 'reviewing');
  assert.equal(row.last_attempted_at, '2026-05-02T18:10:00.000Z', 'winner timestamp persists');
});

test('atomic claim refuses pending row from a different PR — repo/pr scoping is correct', () => {
  const db = setupDb();
  seedReviewRow(db, { reviewStatus: 'pending' });

  const claim = db.prepare(CLAIM_SQL).run(
    '2026-05-02T18:10:00.000Z',
    REPO,
    PR + 1, // different PR number
  );

  assert.equal(claim.changes, 0);
  const row = readRow(db);
  assert.equal(row.review_status, 'pending', 'unrelated row not touched');
});
