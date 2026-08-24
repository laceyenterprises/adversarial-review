import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ensureReviewStateSchema,
  openReviewStateDb,
} from '../src/review-state.mjs';

function makeRootDir() {
  return mkdtempSync(path.join(tmpdir(), 'adversarial-review-backfill-probe-'));
}

// Record every SQL string the schema path prepares, so we can assert on whether
// the backfill WRITE was issued — not merely whether rows changed.
function recordPreparedSql(db) {
  const seen = [];
  const original = db.prepare.bind(db);
  db.prepare = (sql) => {
    seen.push(String(sql));
    return original(sql);
  };
  return seen;
}


function insertRow(db, { prNumber, domainId }) {
  db.prepare(
    `INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, domain_id, subject_external_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'laceyenterprises/agent-os',
    prNumber,
    '2026-08-24T03:00:00.000Z',
    'codex',
    domainId,
    domainId ? `laceyenterprises/agent-os#${prNumber}` : null,
  );
}

const isBackfillWrite = (sql) => /UPDATE\s+reviewed_prs/i.test(sql) && /domain_id\s+IS\s+NULL/i.test(sql);

test('the backfill write is skipped once there is nothing left to backfill', () => {
  const rootDir = makeRootDir();
  const db = openReviewStateDb(rootDir);
  try {
    // First init creates the schema. A fresh DB has no rows at all, so there is
    // nothing to backfill even on the very first pass.
    ensureReviewStateSchema(db);

    insertRow(db, { prNumber: 5786, domainId: 'code-pr' });

    // Re-run schema init the way every DB open does.
    const seen = recordPreparedSql(db);
    ensureReviewStateSchema(db);

    assert.equal(
      seen.filter(isBackfillWrite).length,
      0,
      'schema init must not issue the backfill UPDATE when no row needs it — that '
        + 'write takes a SQLite lock on a non-WAL DB and blocks readers for nothing',
    );
  } finally {
    db.close();
  }
});

test('the backfill still runs and still fills identity when a row needs it', () => {
  const rootDir = makeRootDir();
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);

    // A legacy row: identity columns present but unpopulated.
    insertRow(db, { prNumber: 4242, domainId: null });

    const seen = recordPreparedSql(db);
    ensureReviewStateSchema(db);

    assert.equal(
      seen.filter(isBackfillWrite).length,
      1,
      'the backfill write must still be issued when a row genuinely needs it',
    );

    const row = db.prepare(
      'SELECT domain_id, subject_external_id FROM reviewed_prs WHERE pr_number = ?',
    ).get(4242);
    assert.equal(row.domain_id, 'code-pr');
    assert.equal(row.subject_external_id, 'laceyenterprises/agent-os#4242');
  } finally {
    db.close();
  }
});

test('a second init after a completed backfill stops issuing the write', () => {
  const rootDir = makeRootDir();
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    insertRow(db, { prNumber: 777, domainId: null });

    ensureReviewStateSchema(db); // performs the backfill

    // Steady state from here on — this is the case that was costing the watcher
    // a write lock on every single DB open.
    const seen = recordPreparedSql(db);
    ensureReviewStateSchema(db);
    assert.equal(seen.filter(isBackfillWrite).length, 0);
  } finally {
    db.close();
  }
});
