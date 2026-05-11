import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  REVIEW_STATE_SCHEMA_VERSION,
  ensureReviewStateSchema,
  lookupReviewRowDualRead,
  openReviewStateDb,
} from '../src/review-state.mjs';

function makeRootDir() {
  return mkdtempSync(path.join(tmpdir(), 'adversarial-review-identity-'));
}

function columnNames(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name);
}

test('fresh DB includes subject identity columns and schema version 3', () => {
  const rootDir = makeRootDir();
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);

    const columns = columnNames(db, 'reviewed_prs');
    assert.ok(columns.includes('domain_id'));
    assert.ok(columns.includes('subject_external_id'));
    assert.ok(columns.includes('revision_ref'));
    assert.equal(db.pragma('user_version', { simple: true }), REVIEW_STATE_SCHEMA_VERSION);
  } finally {
    db.close();
  }
});

test('migration from v2 adds identity columns and backfills available head SHA', () => {
  const rootDir = makeRootDir();
  const dataDir = path.join(rootDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'reviews.db'));
  try {
    db.exec(`
      CREATE TABLE reviewed_prs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        head_sha TEXT,
        reviewed_at TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        pr_state TEXT NOT NULL DEFAULT 'open',
        review_status TEXT NOT NULL DEFAULT 'posted',
        review_attempts INTEGER NOT NULL DEFAULT 0,
        UNIQUE(repo, pr_number)
      );
      PRAGMA user_version = 2;
    `);
    db.prepare(
      'INSERT INTO reviewed_prs (repo, pr_number, head_sha, reviewed_at, reviewer, review_status, review_attempts) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('laceyenterprises/agent-os', 360, 'sha-360', '2026-05-10T12:00:00.000Z', 'codex', 'posted', 1);
    db.prepare(
      'INSERT INTO reviewed_prs (repo, pr_number, head_sha, reviewed_at, reviewer, review_status, review_attempts) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('laceyenterprises/agent-os', 361, null, '2026-05-10T12:01:00.000Z', 'codex', 'posted', 1);

    ensureReviewStateSchema(db);

    const backfilled = db.prepare(
      'SELECT domain_id, subject_external_id, revision_ref FROM reviewed_prs WHERE pr_number = ?'
    ).get(360);
    assert.deepEqual(backfilled, {
      domain_id: 'code-pr',
      subject_external_id: 'laceyenterprises/agent-os#360',
      revision_ref: 'sha-360',
    });

    const legacyNoSha = db.prepare(
      'SELECT domain_id, subject_external_id, revision_ref FROM reviewed_prs WHERE pr_number = ?'
    ).get(361);
    assert.deepEqual(legacyNoSha, {
      domain_id: 'code-pr',
      subject_external_id: 'laceyenterprises/agent-os#361',
      revision_ref: null,
    });
    assert.equal(db.pragma('user_version', { simple: true }), 3);
  } finally {
    db.close();
  }
});

test('composite identity UNIQUE rejects duplicate round and kind', () => {
  const rootDir = makeRootDir();
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const insert = db.prepare(
      `INSERT INTO reviewed_prs
         (repo, pr_number, domain_id, subject_external_id, revision_ref, reviewed_at, reviewer, review_status, review_attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      'laceyenterprises/agent-os',
      360,
      'code-pr',
      'laceyenterprises/agent-os#360',
      'sha-360',
      '2026-05-10T12:00:00.000Z',
      'codex',
      'posted',
      2
    );

    assert.throws(
      () => insert.run(
        'laceyenterprises/agent-os-copy',
        999,
        'code-pr',
        'laceyenterprises/agent-os#360',
        'sha-360',
        '2026-05-10T12:01:00.000Z',
        'claude',
        'posted',
        2
      ),
      /UNIQUE constraint failed/
    );
  } finally {
    db.close();
  }
});

test('identity lookup uses the covering index for dedupe reads', () => {
  const rootDir = makeRootDir();
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT id
         FROM reviewed_prs
        WHERE domain_id = ?
          AND subject_external_id = ?
          AND revision_ref = ?`
    ).all('code-pr', 'laceyenterprises/agent-os#360', 'sha-360');
    const details = plan.map((row) => row.detail).join('\n');
    assert.match(details, /reviewed_prs_identity_lookup_idx/);
  } finally {
    db.close();
  }
});

test('dual-read helper refuses unproven legacy rows for a new revision', () => {
  const rootDir = makeRootDir();
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    db.prepare(
      `INSERT INTO reviewed_prs
         (repo, pr_number, reviewed_at, reviewer, review_status, review_attempts)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('laceyenterprises/agent-os', 360, '2026-05-10T12:00:00.000Z', 'codex', 'posted', 1);

    const unproven = lookupReviewRowDualRead(db, {
      repo: 'laceyenterprises/agent-os',
      prNumber: 360,
      revisionRef: 'new-sha',
    });
    assert.equal(unproven.found, false);
    assert.equal(unproven.reason, 'legacy-row-unproven-revision');

    const proven = lookupReviewRowDualRead(db, {
      repo: 'laceyenterprises/agent-os',
      prNumber: 360,
      revisionRef: 'new-sha',
      legacyRevisionProven: true,
    });
    assert.equal(proven.found, true);
    assert.equal(proven.source, 'legacy');
  } finally {
    db.close();
  }
});
