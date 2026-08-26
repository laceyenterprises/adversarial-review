/** ASR-04 backfill — the rows that were already dropped.
 *
 * A fix that only helps future PRs leaves the current strandings exactly as
 * stuck. `adversarial-review#909` and `#910` are the live examples: terminated
 * `unroutable-bot-author`, unreviewed for 14 hours, invisible to every queue and
 * pager in the pipeline because the pipeline had recorded them as finished.
 *
 * The recovery is a vocabulary migration and nothing more. It makes the row live
 * again; the watcher enqueues the review against the PR's LIVE head on the next
 * tick. It deliberately does not fabricate a queue job of its own, because the
 * head it has stored may be weeks stale and a job keyed on a stale head binds a
 * security review to a tree nobody is merging.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { backfillUnroutableBotAuthorRows } from '../src/argus-backfill.mjs';
// The PRODUCTION strings, not re-typed copies: a test bound to its own SQL
// proves only that its own SQL works, and this pipeline has already paid for
// that lesson once on the merged-PR claim CAS.
import {
  BACKFILL_UNROUTABLE_BOT_TO_ARGUS_QUEUED_SQL as UPDATE_SQL,
  SELECT_OPEN_UNROUTABLE_BOT_ROWS_SQL as SELECT_SQL,
} from '../src/review-state-statements.mjs';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE reviewed_prs (
      repo TEXT, pr_number INTEGER, pr_state TEXT, reviewer TEXT,
      review_status TEXT, revision_ref TEXT, reviewed_at TEXT,
      failed_at TEXT, failure_message TEXT, argus_classified_head_sha TEXT
    );
  `);
  return db;
}

function addRow(db, { pr, state = 'open', status = 'unroutable-bot-author', head = null }) {
  db.prepare(
    `INSERT INTO reviewed_prs
       (repo, pr_number, pr_state, reviewer, review_status, revision_ref, reviewed_at,
        failed_at, failure_message, argus_classified_head_sha)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    'laceyenterprises/adversarial-review', pr, state, status,
    status, 'deadbeef'.repeat(5), '2026-08-24T05:00:00.000Z',
    '2026-08-24T05:00:00.000Z', 'Unroutable bot-authored PR (no worker prefix is possible): chore(deps): bump x',
    head,
  );
}

function run(db, opts = {}) {
  return backfillUnroutableBotAuthorRows({
    selectStatement: db.prepare(SELECT_SQL),
    updateStatement: db.prepare(UPDATE_SQL),
    ...opts,
  });
}

function rowFor(db, pr) {
  return db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = ?').get(pr);
}

test('#909 and #910 are recovered out of terminal state', () => {
  const db = freshDb();
  addRow(db, { pr: 909 });
  addRow(db, { pr: 910 });

  const summary = run(db);

  assert.equal(summary.scanned, 2);
  assert.equal(summary.recovered, 2);
  for (const pr of [909, 910]) {
    const row = rowFor(db, pr);
    assert.equal(row.review_status, 'argus-security-queued');
    assert.equal(row.reviewer, 'argus-security');
    assert.equal(row.failed_at, null, 'nothing failed; the lane could not route it');
    assert.match(row.failure_message, /ASR-04 backfill/);
  }
});

test('the recovered row asks the watcher to enqueue against the LIVE head', () => {
  // Clearing the memo is the handoff: it is exactly the state the live route
  // reads as "classify and enqueue this on the next tick".
  const db = freshDb();
  addRow(db, { pr: 909, head: 'c'.repeat(40) });

  run(db);

  assert.equal(rowFor(db, 909).argus_classified_head_sha, null);
});

test('merged and closed rows are left as history, not rewritten', () => {
  // A terminal PR carrying the old status is not a stranding, and this pipeline
  // has been burned before by daemons acting on already-terminal PRs.
  const db = freshDb();
  addRow(db, { pr: 900, state: 'merged' });
  addRow(db, { pr: 901, state: 'closed' });
  addRow(db, { pr: 909 });

  const summary = run(db);

  assert.equal(summary.scanned, 1);
  assert.deepEqual(summary.rows.map((row) => row.prNumber), [909]);
  assert.equal(rowFor(db, 900).review_status, 'unroutable-bot-author');
  assert.equal(rowFor(db, 901).review_status, 'unroutable-bot-author');
});

test('rows in other statuses are untouched', () => {
  const db = freshDb();
  addRow(db, { pr: 800, status: 'malformed' });
  addRow(db, { pr: 801, status: 'pending' });
  addRow(db, { pr: 802, status: 'argus-security-queued' });

  const summary = run(db);

  assert.equal(summary.scanned, 0);
  assert.equal(rowFor(db, 800).review_status, 'malformed', 'a malformed human PR stays malformed');
  assert.equal(rowFor(db, 801).review_status, 'pending');
});

test('a re-run is a no-op', () => {
  const db = freshDb();
  addRow(db, { pr: 909 });

  run(db);
  const second = run(db);

  assert.equal(second.scanned, 0);
  assert.equal(second.recovered, 0);
});

test('a row a live watcher tick already recovered is reported skipped, not overwritten', () => {
  // The guarded UPDATE re-asserts the old status, so the watcher's write wins.
  const db = freshDb();
  addRow(db, { pr: 909 });

  // Freeze the SELECT result, then let the watcher win the row before the
  // UPDATE runs -- exactly the interleaving a live tick produces.
  const staleRows = db.prepare(SELECT_SQL).all();
  db.prepare("UPDATE reviewed_prs SET review_status = 'argus-security-queued' WHERE pr_number = 909").run();

  const summary = backfillUnroutableBotAuthorRows({
    selectStatement: { all: () => staleRows },
    updateStatement: db.prepare(UPDATE_SQL),
  });

  assert.equal(summary.scanned, 1);
  assert.equal(summary.recovered, 0);
  assert.equal(summary.skipped, 1);
});

test('--dry-run writes nothing', () => {
  const db = freshDb();
  addRow(db, { pr: 909 });

  const summary = run(db, { dryRun: true });

  assert.equal(summary.scanned, 1);
  assert.equal(summary.recovered, 0);
  assert.equal(summary.rows[0].to, 'argus-security-queued');
  assert.equal(rowFor(db, 909).review_status, 'unroutable-bot-author');
});
