/** A refused PR is not a stalled reviewer.
 *
 * The "Reviews stalled — restore reviewer dispatch" pager fires when no review
 * has posted for a threshold while `countOpenPrsAwaitingFirstPassReview() > 0`.
 * That count included PRs whose title does not route to a worker class. Those
 * rows are marked `review_status='malformed'`, which is TERMINAL: the dispatch
 * loop hits `existing?.review_status === 'malformed'` and returns, so the PR can
 * never receive a first pass.
 *
 * The effect was a pager that could not be cleared by a healthy reviewer -- it
 * named open PRs "awaiting first pass" that the pipeline had already refused,
 * and stayed above zero for as long as the PR stayed open.
 *
 * Excluding them is not the same as trusting `review_status='posted'`. The
 * count deliberately keys SUCCESS off `reviewer_passes.gh_comment_id` so a stale
 * success claim cannot mask a genuine gap. A malformed row is the opposite: an
 * explicit refusal, which is evidence about that PR rather than about reviewer
 * health.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { countOpenPrsAwaitingFirstPassReview } from '../src/review-state-db.mjs';

// Minimal schema: only the columns the count actually reads.
function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE reviewed_prs (
      repo TEXT, pr_number INTEGER, pr_state TEXT, review_status TEXT
    );
    CREATE TABLE reviewer_passes (
      repo TEXT, pr_number INTEGER, gh_comment_id TEXT
    );
  `);
  return db;
}

function addPr(db, { pr, state = 'open', status = 'pending', commentId = null }) {
  db.prepare('INSERT INTO reviewed_prs (repo, pr_number, pr_state, review_status) VALUES (?,?,?,?)')
    .run('laceyenterprises/agent-os', pr, state, status);
  if (commentId !== null) {
    db.prepare('INSERT INTO reviewer_passes (repo, pr_number, gh_comment_id) VALUES (?,?,?)')
      .run('laceyenterprises/agent-os', pr, commentId);
  }
}

test('a malformed-title PR does not count as awaiting first pass', () => {
  const db = freshDb();
  addPr(db, { pr: 1, status: 'malformed' });
  assert.equal(
    countOpenPrsAwaitingFirstPassReview(db),
    0,
    'a PR the dispatch loop refuses can never clear the pager',
  );
});

test('a genuinely pending PR still counts', () => {
  // The pager must keep working: this is the regression that would matter most.
  const db = freshDb();
  addPr(db, { pr: 1, status: 'pending' });
  assert.equal(countOpenPrsAwaitingFirstPassReview(db), 1);
});

test('a NULL review_status still counts', () => {
  // SQLite's `IS NOT` is null-safe here: it excludes malformed terminal rows
  // without dropping rows that have no status yet -- exactly the rows most
  // likely to be genuinely awaiting a first pass.
  const db = freshDb();
  addPr(db, { pr: 1, status: null });
  assert.equal(countOpenPrsAwaitingFirstPassReview(db), 1);
});

test('mixed set counts only the real ones', () => {
  const db = freshDb();
  addPr(db, { pr: 1, status: 'malformed' });   // refused
  addPr(db, { pr: 2, status: 'pending' });     // awaiting
  addPr(db, { pr: 3, status: null });          // awaiting
  addPr(db, { pr: 4, status: 'pending', commentId: 'IC_1' }); // already reviewed
  addPr(db, { pr: 5, status: 'pending', state: 'closed' });   // not open
  assert.equal(countOpenPrsAwaitingFirstPassReview(db), 2);
});

test('a published review still wins over any status', () => {
  // Unchanged behaviour: success is keyed off gh_comment_id, not review_status,
  // so a stale/mistaken status cannot mask a PR that never got a real review.
  const db = freshDb();
  addPr(db, { pr: 1, status: 'posted' });                      // claims posted, no comment
  addPr(db, { pr: 2, status: 'pending', commentId: 'IC_2' });  // real published review
  assert.equal(
    countOpenPrsAwaitingFirstPassReview(db),
    1,
    'a posted claim with no published comment must still count',
  );
});
