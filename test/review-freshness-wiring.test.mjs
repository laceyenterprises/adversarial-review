// Wiring for the review-freshness liveness pager (watcher.mjs tick-end): the DB
// reads that feed maybeFireReviewStalledAlert. RCA: reviewer dispatch can
// succeed while no review lands, so the watcher must page off the REAL
// MAX(posted_at) and a genuinely-open awaiting-review count — never a maskable
// per-PR status.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import {
  parsePostedAtMs,
  latestPostedReviewAtMs,
  countOpenPrsAwaitingFirstPassReview,
} from '../src/review-state-db.mjs';

function withTempDb(fn) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'review-freshness-wiring-'));
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    return fn(db);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

let prSeq = 1;
function seed(db, { prState, reviewStatus, postedAt = null }) {
  db.prepare(
    `INSERT INTO reviewed_prs (
       repo, pr_number, reviewed_at, reviewer, pr_state, review_status, posted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'laceyenterprises/agent-os',
    prSeq++,
    '2026-07-27T00:00:00.000Z',
    'gemini',
    prState,
    reviewStatus,
    postedAt
  );
}

test('parsePostedAtMs pins a space-separated tz-less SQLite time to UTC', () => {
  // SQLite CURRENT_TIMESTAMP shape — must NOT be read as local time.
  assert.equal(parsePostedAtMs('2026-07-27 04:00:00'), Date.parse('2026-07-27T04:00:00Z'));
  // ISO with explicit Z is unchanged.
  assert.equal(parsePostedAtMs('2026-07-27T04:00:00.500Z'), Date.parse('2026-07-27T04:00:00.500Z'));
  // Empty / non-string / garbage -> null (never NaN leaking into freshness math).
  assert.equal(parsePostedAtMs(''), null);
  assert.equal(parsePostedAtMs(null), null);
  assert.equal(parsePostedAtMs('not-a-date'), null);
});

test('latestPostedReviewAtMs returns the freshest posted_at, ignoring never-posted rows', () => {
  withTempDb((db) => {
    assert.equal(latestPostedReviewAtMs(db), null, 'no posted rows -> null (detector seeds baseline)');
    seed(db, { prState: 'open', reviewStatus: 'pending', postedAt: null }); // awaiting, never posted
    seed(db, { prState: 'merged', reviewStatus: 'posted', postedAt: '2026-07-27T03:00:00.000Z' });
    seed(db, { prState: 'open', reviewStatus: 'posted', postedAt: '2026-07-27 04:30:00' }); // freshest
    seed(db, { prState: 'open', reviewStatus: 'failed', postedAt: null }); // failed pre-post: no posted_at
    assert.equal(latestPostedReviewAtMs(db), Date.parse('2026-07-27T04:30:00Z'));
  });
});

test('countOpenPrsAwaitingFirstPassReview counts only genuinely-open, not-yet-posted PRs', () => {
  withTempDb((db) => {
    assert.equal(countOpenPrsAwaitingFirstPassReview(db), 0);
    seed(db, { prState: 'open', reviewStatus: 'pending' }); // counts
    seed(db, { prState: 'open', reviewStatus: 'reviewing' }); // counts
    seed(db, { prState: 'open', reviewStatus: 'pending-upstream' }); // counts (transient hold)
    seed(db, { prState: 'open', reviewStatus: 'posted', postedAt: '2026-07-27T03:00:00.000Z' }); // done
    seed(db, { prState: 'open', reviewStatus: 'failed' }); // terminal-ambiguous, not counted
    seed(db, { prState: 'closed', reviewStatus: 'pending' }); // stale closed row must NOT cry wolf
    seed(db, { prState: 'merged', reviewStatus: 'reviewing' }); // merged row excluded
    assert.equal(countOpenPrsAwaitingFirstPassReview(db), 3);
  });
});
