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

function tableInfoByName(db, tableName) {
  return Object.fromEntries(
    db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => [column.name, column])
  );
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
    assert.ok(columns.includes('reviewer_timeout_ms'));
    assert.ok(columns.includes('domain_id'));
    assert.ok(columns.includes('subject_external_id'));
    assert.ok(columns.includes('revision_ref'));
    const passColumns = db.prepare('PRAGMA table_info(reviewer_passes)').all().map((column) => column.name);
    assert.ok(passColumns.includes('reviewer_model'));
    assert.ok(passColumns.includes('verdict'));
    assert.ok(passColumns.includes('body_md'));
    assert.ok(passColumns.includes('gh_comment_id'));
    assert.ok(passColumns.includes('body_captured_at'));
    const closeoutColumns = tableInfoByName(db, 'pr_merge_closeouts');
    assert.equal(closeoutColumns.repo.type, 'TEXT');
    assert.equal(closeoutColumns.repo.pk, 1);
    assert.equal(closeoutColumns.pr_number.type, 'INTEGER');
    assert.equal(closeoutColumns.pr_number.pk, 2);
    assert.equal(closeoutColumns.closeout_body_md.type, 'TEXT');
    assert.equal(closeoutColumns.closeout_authors_json.type, 'TEXT');
    assert.equal(closeoutColumns.closeout_posted_at.type, 'TEXT');
    assert.equal(closeoutColumns.body_captured_at.type, 'TEXT');
    assert.equal(closeoutColumns.scrape_last_checked_at.type, 'TEXT');
    assert.equal(closeoutColumns.empty_confirmed_at.type, 'TEXT');
    assert.equal(closeoutColumns.merged_at.type, 'TEXT');
    assert.equal(closeoutColumns.gh_artifact_refs.type, 'TEXT');
    const migration = db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get('20260518_reviewer_passes.sql');
    assert.equal(migration.id, '20260518_reviewer_passes.sql');
    const bodyCaptureMigration = db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(
      '20260529_reviewer_passes_body_capture_and_closeouts.sql'
    );
    assert.equal(bodyCaptureMigration.id, '20260529_reviewer_passes_body_capture_and_closeouts.sql');
    assert.equal(db.pragma('user_version', { simple: true }), REVIEW_STATE_SCHEMA_VERSION);
  } finally {
    db.close();
  }
});

test('review-state migrations upgrade old reviewer_passes schema idempotently', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const db = openReviewStateDb(rootDir);

  try {
    db.exec(`
      CREATE TABLE reviewer_passes (
        pass_id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        attempt_number INTEGER NOT NULL,
        reviewer_class TEXT NOT NULL,
        pass_kind TEXT NOT NULL,
        started_at TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(repo, pr_number, attempt_number, pass_kind)
      );
    `);

    ensureReviewStateSchema(db);
    ensureReviewStateSchema(db);

    const migrationRows = db.prepare(
      'SELECT id FROM schema_migrations WHERE id = ?'
    ).all('20260529_reviewer_passes_body_capture_and_closeouts.sql');
    assert.equal(migrationRows.length, 1);

    const passColumns = tableInfoByName(db, 'reviewer_passes');
    assert.equal(passColumns.verdict.type, 'TEXT');
    assert.equal(passColumns.body_md.type, 'TEXT');
    assert.equal(passColumns.gh_comment_id.type, 'TEXT');
    assert.equal(passColumns.body_captured_at.type, 'TEXT');
    assert.ok(tableInfoByName(db, 'pr_merge_closeouts').repo);
  } finally {
    db.close();
  }
});

test('review-state migrations preserve existing reviewer_passes rows and new fields default to NULL', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const db = openReviewStateDb(rootDir);

  try {
    db.exec(`
      CREATE TABLE reviewer_passes (
        pass_id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        attempt_number INTEGER NOT NULL,
        reviewer_class TEXT NOT NULL,
        pass_kind TEXT NOT NULL,
        started_at TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(repo, pr_number, attempt_number, pass_kind)
      );
    `);
    db.prepare(
      `INSERT INTO reviewer_passes (
         repo, pr_number, attempt_number, reviewer_class, pass_kind, started_at, status, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'laceyenterprises/adversarial-review',
      77,
      1,
      'claude',
      'review',
      '2026-05-29T00:00:00.000Z',
      'completed',
      '{}'
    );

    ensureReviewStateSchema(db);

    const row = db.prepare(
      `SELECT repo, pr_number, verdict, body_md, gh_comment_id, body_captured_at
         FROM reviewer_passes
        WHERE pr_number = 77`
    ).get();
    assert.equal(row.repo, 'laceyenterprises/adversarial-review');
    assert.equal(row.pr_number, 77);
    assert.equal(row.verdict, null);
    assert.equal(row.body_md, null);
    assert.equal(row.gh_comment_id, null);
    assert.equal(row.body_captured_at, null);
  } finally {
    db.close();
  }
});

test('review-state migrations support closeout round-trips and reviewer_pass body updates', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const db = openReviewStateDb(rootDir);

  try {
    ensureReviewStateSchema(db);

    db.prepare(
      `INSERT INTO reviewer_passes (
         repo, pr_number, attempt_number, reviewer_class, reviewer_model, pass_kind, started_at, status, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'laceyenterprises/adversarial-review',
      88,
      1,
      'claude',
      'claude-sonnet',
      'review',
      '2026-05-29T00:00:00.000Z',
      'completed',
      '{}'
    );
    db.prepare(
      'UPDATE reviewer_passes SET verdict = ?, body_md = ? WHERE repo = ? AND pr_number = ? AND attempt_number = ? AND pass_kind = ?'
    ).run(
      'comment-only',
      'hello',
      'laceyenterprises/adversarial-review',
      88,
      1,
      'review'
    );

    db.prepare(
      `INSERT INTO pr_merge_closeouts (
         repo, pr_number, closeout_body_md, closeout_authors_json, closeout_posted_at, body_captured_at,
         scrape_last_checked_at, empty_confirmed_at, merged_at, gh_artifact_refs
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'laceyenterprises/adversarial-review',
      88,
      'Merged after follow-up.',
      '["alice","bob"]',
      '2026-05-29T00:05:00.000Z',
      '2026-05-29T00:06:00.000Z',
      '2026-05-29T00:07:00.000Z',
      '2026-05-29T00:08:00.000Z',
      '2026-05-29T00:04:00.000Z',
      '[{"kind":"comment","id":"IC_kwDO"}]'
    );
    db.prepare(
      `INSERT INTO pr_merge_closeouts (
         repo, pr_number, closeout_body_md, closeout_authors_json, closeout_posted_at, body_captured_at,
         scrape_last_checked_at, empty_confirmed_at, merged_at, gh_artifact_refs
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'laceyenterprises/adversarial-review',
      89,
      null,
      null,
      null,
      null,
      '2026-05-29T00:09:00.000Z',
      null,
      '2026-05-29T00:03:00.000Z',
      null
    );

    const reviewerPass = db.prepare(
      'SELECT verdict, body_md FROM reviewer_passes WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/adversarial-review', 88);
    assert.equal(reviewerPass.verdict, 'comment-only');
    assert.equal(reviewerPass.body_md, 'hello');

    const populated = db.prepare(
      'SELECT * FROM pr_merge_closeouts WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/adversarial-review', 88);
    assert.equal(populated.closeout_body_md, 'Merged after follow-up.');
    assert.equal(populated.closeout_authors_json, '["alice","bob"]');
    assert.equal(populated.closeout_posted_at, '2026-05-29T00:05:00.000Z');
    assert.equal(populated.body_captured_at, '2026-05-29T00:06:00.000Z');
    assert.equal(populated.scrape_last_checked_at, '2026-05-29T00:07:00.000Z');
    assert.equal(populated.empty_confirmed_at, '2026-05-29T00:08:00.000Z');
    assert.equal(populated.merged_at, '2026-05-29T00:04:00.000Z');
    assert.equal(populated.gh_artifact_refs, '[{"kind":"comment","id":"IC_kwDO"}]');

    const sparse = db.prepare(
      'SELECT * FROM pr_merge_closeouts WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/adversarial-review', 89);
    assert.equal(sparse.closeout_body_md, null);
    assert.equal(sparse.closeout_authors_json, null);
    assert.equal(sparse.closeout_posted_at, null);
    assert.equal(sparse.body_captured_at, null);
    assert.equal(sparse.scrape_last_checked_at, '2026-05-29T00:09:00.000Z');
    assert.equal(sparse.empty_confirmed_at, null);
    assert.equal(sparse.merged_at, '2026-05-29T00:03:00.000Z');
    assert.equal(sparse.gh_artifact_refs, null);
  } finally {
    db.close();
  }
});

test('pr_merge_closeouts primary key rejects duplicate repo/pr_number rows', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const db = openReviewStateDb(rootDir);

  try {
    ensureReviewStateSchema(db);
    db.prepare(
      'INSERT INTO pr_merge_closeouts (repo, pr_number) VALUES (?, ?)'
    ).run('laceyenterprises/adversarial-review', 99);

    assert.throws(
      () => db.prepare('INSERT INTO pr_merge_closeouts (repo, pr_number) VALUES (?, ?)').run(
        'laceyenterprises/adversarial-review',
        99
      ),
      /UNIQUE constraint failed: pr_merge_closeouts\.repo, pr_merge_closeouts\.pr_number/
    );
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
