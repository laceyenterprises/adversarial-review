import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ensureReviewStateSchema,
  openReviewStateDb,
  REVIEW_STATE_SCHEMA_VERSION,
  requestReviewRereview,
} from '../src/review-state.mjs';

function insertReviewRow(rootDir, overrides = {}) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    db.prepare(
      'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, linear_ticket, review_status, review_attempts, last_attempted_at, posted_at, failed_at, failure_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      overrides.repo || 'laceyenterprises/adversarial-review',
      overrides.prNumber || 10,
      overrides.reviewedAt || '2026-04-24T12:00:00.000Z',
      overrides.reviewer || 'claude',
      overrides.prState || 'open',
      overrides.linearTicket || 'LAC-210',
      overrides.reviewStatus || 'posted',
      overrides.reviewAttempts ?? 1,
      overrides.lastAttemptedAt ?? '2026-04-24T12:05:00.000Z',
      overrides.postedAt ?? '2026-04-24T12:06:00.000Z',
      overrides.failedAt ?? null,
      overrides.failureMessage ?? null
    );
  } finally {
    db.close();
  }
}

test('openReviewStateDb applies a busy timeout and shared schema adds reviewer handle columns', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const db = openReviewStateDb(rootDir);

  try {
    ensureReviewStateSchema(db);
    assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);

    const columns = db.prepare('PRAGMA table_info(reviewed_prs)').all().map((column) => column.name);
    assert.ok(columns.includes('rereview_requested_at'));
    assert.ok(columns.includes('rereview_reason'));
    assert.ok(columns.includes('reviewer_session_uuid'));
    assert.ok(columns.includes('reviewer_pgid'));
    assert.ok(columns.includes('reviewer_started_at'));
    assert.ok(columns.includes('reviewer_head_sha'));
    assert.equal(db.pragma('user_version', { simple: true }), REVIEW_STATE_SCHEMA_VERSION);
  } finally {
    db.close();
  }
});

test("requestReviewRereview refuses to reset a row in 'reviewing' state (in-flight reviewer subprocess)", () => {
  // 'reviewing' is the watcher's durable in-flight claim set BEFORE
  // spawning the reviewer subprocess. Resetting it back to 'pending'
  // while the subprocess is still running would let the next poll
  // spawn a second reviewer for the same PR and post a duplicate
  // GitHub review — the exact race the in-flight claim was added to
  // prevent. The helper must refuse this reset; recovery is via
  // reconcileOrphanedReviewing on watcher restart, not via direct
  // reset of the in-flight row.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'reviewing',
    postedAt: null,
    failedAt: null,
    failureMessage: null,
  });

  const result = requestReviewRereview({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 10,
    requestedAt: '2026-04-24T12:10:00.000Z',
    reason: 'manual override attempt',
  });

  assert.equal(result.triggered, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'review-in-flight');

  // Confirm DB row was not flipped — the in-flight claim must persist
  // so the running reviewer subprocess's terminal transition is the
  // one that wins the row.
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const row = db.prepare(
      'SELECT review_status, rereview_requested_at FROM reviewed_prs WHERE pr_number = 10'
    ).get();
    assert.equal(row.review_status, 'reviewing', 'review_status untouched');
    assert.equal(row.rereview_requested_at, null, 'rereview metadata not written');
  } finally {
    db.close();
  }
});

test('requestReviewRereview preserves attempt history and records rereview metadata separately from failures', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  insertReviewRow(rootDir);

  const result = requestReviewRereview({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 10,
    requestedAt: '2026-04-24T12:10:00.000Z',
    reason: 'Remediation landed and is ready for another adversarial pass.',
  });

  assert.equal(result.triggered, true);
  assert.equal(result.status, 'pending');
  assert.equal(result.reviewRow.review_status, 'pending');
  assert.equal(result.reviewRow.review_attempts, 1);
  assert.equal(result.reviewRow.last_attempted_at, '2026-04-24T12:05:00.000Z');
  assert.equal(result.reviewRow.failure_message, null);
  assert.equal(result.reviewRow.rereview_requested_at, '2026-04-24T12:10:00.000Z');
  assert.equal(result.reviewRow.rereview_reason, 'Remediation landed and is ready for another adversarial pass.');
});

test("requestReviewRereview is atomic: a concurrent watcher claim cannot be overwritten back to pending", () => {
  // Pre-CAS, this was a SELECT-then-UPDATE: the helper read the row's
  // status, decided it was eligible, then ran an unconditional UPDATE
  // setting status='pending'. A watcher process that flipped the row
  // to 'reviewing' between those two steps would have its claim
  // overwritten. The fix is a single CAS UPDATE with the eligibility
  // predicate baked into the WHERE clause; this test verifies the
  // race is closed by simulating the interleaving directly.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  // Seed at 'failed' so the helper would ordinarily reset it to
  // 'pending' (without the race protection). Then simulate the race
  // by flipping the row to 'reviewing' before the helper runs.
  insertReviewRow(rootDir, {
    reviewStatus: 'failed',
    postedAt: null,
    failedAt: '2026-04-24T12:08:00.000Z',
    failureMessage: 'transient OAuth blip',
  });
  const racingDb = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(racingDb);
    racingDb.prepare(
      "UPDATE reviewed_prs SET review_status = 'reviewing', last_attempted_at = ? WHERE pr_number = 10"
    ).run('2026-04-24T12:09:30.000Z');
  } finally {
    racingDb.close();
  }

  const result = requestReviewRereview({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 10,
    requestedAt: '2026-04-24T12:10:00.000Z',
    reason: 'should be refused — claim is in flight',
  });

  assert.equal(result.triggered, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'review-in-flight');

  // The row must remain 'reviewing' — the helper must NOT have flipped
  // it. Pre-CAS, the unconditional UPDATE would have overwritten this
  // to 'pending'.
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const row = db.prepare(
      'SELECT review_status, rereview_requested_at FROM reviewed_prs WHERE pr_number = 10'
    ).get();
    assert.equal(row.review_status, 'reviewing', 'in-flight claim survived the rereview attempt');
    assert.equal(row.rereview_requested_at, null, 'rereview metadata not written for blocked reset');
  } finally {
    db.close();
  }
});

test('requestReviewRereview returns review-row-missing when no row exists', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  // Open + close to materialize the schema without inserting a row.
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  db.close();

  const result = requestReviewRereview({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 999,
    requestedAt: '2026-04-24T12:10:00.000Z',
    reason: 'no-op',
  });

  assert.equal(result.triggered, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'review-row-missing');
});

test("requestReviewRereview returns malformed-title-terminal for malformed rows", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'malformed',
    reviewer: 'malformed-title',
    postedAt: null,
  });

  const result = requestReviewRereview({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 10,
    requestedAt: '2026-04-24T12:10:00.000Z',
    reason: 'should be refused',
  });

  assert.equal(result.triggered, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'malformed-title-terminal');
});

test("requestReviewRereview returns pr-not-open for closed PRs", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'posted',
    prState: 'closed',
  });

  const result = requestReviewRereview({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 10,
    requestedAt: '2026-04-24T12:10:00.000Z',
    reason: 'should be refused',
  });

  assert.equal(result.triggered, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'pr-not-open');
});

test("requestReviewRereview returns already-pending when row is already 'pending'", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  insertReviewRow(rootDir, {
    reviewStatus: 'pending',
    postedAt: null,
  });

  const result = requestReviewRereview({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 10,
    requestedAt: '2026-04-24T12:10:00.000Z',
    reason: 'no-op',
  });

  assert.equal(result.triggered, false);
  assert.equal(result.status, 'already-pending');
});
