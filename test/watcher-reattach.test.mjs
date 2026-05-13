import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { ensureReviewStateSchema } from '../src/review-state.mjs';
import {
  LEGACY_ORPHAN_FAILURE_MESSAGE,
  NULL_PGID_FAILURE_MESSAGE,
  reconcileReviewerSessions,
} from '../src/reviewer-reattach.mjs';

const REPO = 'laceyenterprises/adversarial-review';
const PR = 70;
const STARTED_AT = '2026-05-11T05:10:00.000Z';
const FAILURE_AT = '2026-05-11T05:20:00.000Z';
const HEAD_SHA = 'abc123';

function setupDb() {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  return db;
}

function seedReviewing(db, overrides = {}) {
  db.prepare(
    `INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
        review_attempts, last_attempted_at, reviewer_session_uuid,
        reviewer_pgid, reviewer_started_at, reviewer_head_sha)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    overrides.repo || REPO,
    overrides.prNumber || PR,
    '2026-05-11T05:09:00.000Z',
    overrides.reviewer || 'codex',
    'open',
    'reviewing',
    overrides.reviewAttempts ?? 2,
    overrides.lastAttemptedAt || STARTED_AT,
    Object.prototype.hasOwnProperty.call(overrides, 'sessionUuid')
      ? overrides.sessionUuid
      : 'session-70',
    Object.prototype.hasOwnProperty.call(overrides, 'pgid') ? overrides.pgid : 9001,
    overrides.startedAt || STARTED_AT,
    Object.prototype.hasOwnProperty.call(overrides, 'headSha') ? overrides.headSha : HEAD_SHA
  );
}

function readRow(db, repo = REPO, prNumber = PR) {
  return db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(repo, prNumber);
}

function makeOctokit(reviews = []) {
  const calls = [];
  return {
    calls,
    rest: {
      pulls: {
        listReviews: async (params) => {
          calls.push(params);
          return { data: reviews };
        },
      },
    },
  };
}

function makeLog() {
  const lines = [];
  return {
    lines,
    log(message) { lines.push(String(message)); },
    warn(message) { lines.push(String(message)); },
  };
}

test('reattaches when pgid is alive, head sha is unchanged, and no review is posted', async () => {
  const db = setupDb();
  seedReviewing(db);
  const log = makeLog();

  await reconcileReviewerSessions({
    db,
    octokit: makeOctokit([]),
    now: new Date(FAILURE_AT),
    log,
    probeSession: () => ({ alive: true, matched: true }),
    fetchHeadSha: async () => HEAD_SHA,
  });

  const row = readRow(db);
  assert.equal(row.review_status, 'reviewing');
  assert.equal(row.review_attempts, 2, 'reattach must not burn an attempt');
  assert.match(log.lines.join('\n'), /reviewer_reattach_alive/);
  assert.match(log.lines.join('\n'), /session=session-70 pgid=9001/);
});

<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
>>>>>>> c5a3ac535212096835e70aa72c2c8d0f137a577b
test('selective stale probing recovers only overdue reviewing rows during steady-state polls', async () => {
  const db = setupDb();
  seedReviewing(db, { prNumber: 70, startedAt: '2026-05-11T04:30:00.000Z', lastAttemptedAt: '2026-05-11T04:30:00.000Z' });
  seedReviewing(db, { prNumber: 71, sessionUuid: 'session-71', pgid: 9002, startedAt: '2026-05-11T05:18:00.000Z', lastAttemptedAt: '2026-05-11T05:18:00.000Z' });
  const log = makeLog();

  await reconcileReviewerSessions({
    db,
    octokit: makeOctokit([
      { user: { login: 'codex-reviewer-lacey' }, submitted_at: '2026-05-11T05:13:09.000Z' },
    ]),
    now: new Date(FAILURE_AT),
    log,
    shouldReconcileRow: (row, now) => Date.parse(row.reviewer_started_at) <= (now.getTime() - (20 * 60 * 1000)),
    probeAlive: () => false,
    fetchHeadSha: async () => HEAD_SHA,
  });

  const staleRow = readRow(db, REPO, 70);
  const freshRow = readRow(db, REPO, 71);
  assert.equal(staleRow.review_status, 'posted');
  assert.equal(freshRow.review_status, 'reviewing');
  assert.match(log.lines.join('\n'), /reviewer_reattach_recovered/);
});

<<<<<<< HEAD
=======
>>>>>>> 300a5a9bfeca7a20c52f1f012bc469f95d3ba7c1
>>>>>>> c5a3ac535212096835e70aa72c2c8d0f137a577b
test('invalidates an alive reviewer when the PR head sha changed', async () => {
  const db = setupDb();
  seedReviewing(db);
  const killed = [];
  const log = makeLog();

  await reconcileReviewerSessions({
    db,
    octokit: makeOctokit([]),
    now: new Date(FAILURE_AT),
    log,
    probeSession: () => ({ alive: true, matched: true }),
    killProcessGroup: (pgid, signal) => killed.push({ pgid, signal }),
    fetchHeadSha: async () => 'def456',
  });

  const row = readRow(db);
  assert.equal(row.review_status, 'failed');
  assert.notEqual(row.review_status, 'failed-orphan');
  assert.equal(row.review_attempts, 3);
  assert.deepEqual(killed, [{ pgid: 9001, signal: 'SIGKILL' }]);
  assert.match(row.failure_message, /PR head changed/);
  assert.match(log.lines.join('\n'), /reviewer_reattach_invalidated/);
});

test('recovers a dead reviewer when GitHub has a posted review from this bot since start', async () => {
  const db = setupDb();
  seedReviewing(db, { reviewer: 'codex' });
  const postedAt = '2026-05-11T05:13:09.000Z';
  const octokit = makeOctokit([
    { user: { login: 'human-reviewer' }, submitted_at: postedAt },
    { user: { login: 'codex-reviewer-lacey' }, submitted_at: '2026-05-11T05:09:59.000Z' },
    { user: { login: 'codex-reviewer-lacey' }, submitted_at: postedAt },
  ]);
  const log = makeLog();

  await reconcileReviewerSessions({
    db,
    octokit,
    now: new Date(FAILURE_AT),
    log,
    probeAlive: () => false,
    fetchHeadSha: async () => HEAD_SHA,
  });

  const row = readRow(db);
  assert.equal(row.review_status, 'posted');
  assert.equal(row.posted_at, postedAt);
  assert.equal(row.review_attempts, 3);
  assert.equal(octokit.calls.length, 1, 'review probe is cached for this startup pass');
  assert.match(log.lines.join('\n'), /reviewer_reattach_recovered/);
});

<<<<<<< HEAD
=======
test('dead reviewer with posted review is not recovered when PR head changed', async () => {
  const db = setupDb();
  seedReviewing(db, { reviewer: 'codex' });
  const octokit = makeOctokit([
    { user: { login: 'codex-reviewer-lacey' }, submitted_at: '2026-05-11T05:13:09.000Z' },
  ]);
  const log = makeLog();

  await reconcileReviewerSessions({
    db,
    octokit,
    now: new Date(FAILURE_AT),
    log,
    probeAlive: () => false,
    fetchHeadSha: async () => 'def456',
  });

  const row = readRow(db);
  assert.equal(row.review_status, 'failed');
  assert.equal(row.posted_at, null);
  assert.equal(octokit.calls.length, 0, 'head mismatch must fail before review-list probing');
  assert.match(row.failure_message, /PR head changed from abc123 to def456/);
  assert.match(log.lines.join('\n'), /reviewer_reattach_invalidated/);
});

test('full first review page without paginate becomes sticky probe failure', async () => {
  const db = setupDb();
  seedReviewing(db, { reviewer: 'codex' });
  const octokit = makeOctokit(Array.from({ length: 100 }, (_, index) => ({
    user: { login: index === 99 ? 'codex-reviewer-lacey' : 'human-reviewer' },
    submitted_at: '2026-05-11T05:13:09.000Z',
  })));
  const log = makeLog();

  await reconcileReviewerSessions({
    db,
    octokit,
    now: new Date(FAILURE_AT),
    log,
    probeAlive: () => false,
    fetchHeadSha: async () => HEAD_SHA,
  });

  const row = readRow(db);
  assert.equal(row.review_status, 'failed-orphan');
  assert.equal(row.posted_at, null);
  assert.match(row.failure_message, /review probe failed: review probe truncated/);
  assert.match(log.lines.join('\n'), /reviewer_reattach_review_probe_failed/);
});

test('reattach reconciliation can cap stale rows per poll', async () => {
  const db = setupDb();
  seedReviewing(db, { prNumber: 70, sessionUuid: 'session-70', pgid: 9001 });
  seedReviewing(db, { prNumber: 71, sessionUuid: 'session-71', pgid: 9002 });
  const log = makeLog();

  const result = await reconcileReviewerSessions({
    db,
    octokit: makeOctokit([]),
    now: new Date(FAILURE_AT),
    log,
    maxRows: 1,
    shouldReconcileRow: () => true,
    probeAlive: () => false,
    fetchHeadSha: async () => HEAD_SHA,
  });

  assert.deepEqual(result, { reconciled: 1, skipped: 1 });
  assert.equal(readRow(db, REPO, 70).review_status, 'failed');
  assert.equal(readRow(db, REPO, 71).review_status, 'reviewing');
});

>>>>>>> 300a5a9bfeca7a20c52f1f012bc469f95d3ba7c1
test('marks a dead reviewer without a GitHub review as retryable failed', async () => {
  const db = setupDb();
  seedReviewing(db, { reviewer: 'claude' });
  const log = makeLog();

  await reconcileReviewerSessions({
    db,
    octokit: makeOctokit([]),
    now: new Date(FAILURE_AT),
    log,
    probeAlive: () => false,
    fetchHeadSha: async () => HEAD_SHA,
  });

  const row = readRow(db);
  assert.equal(row.review_status, 'failed');
  assert.notEqual(row.review_status, 'failed-orphan');
  assert.equal(row.review_attempts, 3);
  assert.match(row.failure_message, /no GitHub review was found from claude-reviewer-lacey/);
  assert.match(log.lines.join('\n'), /reviewer_reattach_dead/);
});

test('pre-existing reviewing rows without reviewer_session_uuid use legacy failed-orphan marking', async () => {
  const db = setupDb();
  seedReviewing(db, { sessionUuid: null, pgid: null });
  const log = makeLog();

  await reconcileReviewerSessions({
    db,
    octokit: makeOctokit([]),
    now: new Date(FAILURE_AT),
    log,
    probeAlive: () => {
      throw new Error('legacy rows should not probe pgid');
    },
  });

  const row = readRow(db);
  assert.equal(row.review_status, 'failed-orphan');
  assert.equal(row.review_attempts, 3);
  assert.equal(row.failure_message, LEGACY_ORPHAN_FAILURE_MESSAGE);
  assert.match(log.lines.join('\n'), /Orphan reviewer detected/);
});

test('alive matching-head reviewer with an already posted review remains a sticky anomaly', async () => {
  const db = setupDb();
  seedReviewing(db, { reviewer: 'codex' });
  const log = makeLog();

  await reconcileReviewerSessions({
    db,
    octokit: makeOctokit([
      { user: { login: 'codex-reviewer-lacey' }, submitted_at: '2026-05-11T05:13:09.000Z' },
    ]),
    now: new Date(FAILURE_AT),
    log,
    probeSession: () => ({ alive: true, matched: true }),
    fetchHeadSha: async () => HEAD_SHA,
  });

  const row = readRow(db);
  assert.equal(row.review_status, 'failed-orphan');
  assert.equal(row.review_attempts, 3);
  assert.match(row.failure_message, /posted a GitHub review/);
  assert.match(log.lines.join('\n'), /reviewer_reattach_orphan/);
});

test('claimed rows with null pgid become sticky failed-orphan', async () => {
  const db = setupDb();
  seedReviewing(db, { pgid: null });
  const log = makeLog();

  await reconcileReviewerSessions({
    db,
    octokit: makeOctokit([]),
    now: new Date(FAILURE_AT),
    log,
    probeAlive: () => {
      throw new Error('null pgid rows should not probe liveness');
    },
  });

  const row = readRow(db);
  assert.equal(row.review_status, 'failed-orphan');
  assert.equal(row.review_attempts, 3);
  assert.equal(row.failure_message, NULL_PGID_FAILURE_MESSAGE);
  assert.match(log.lines.join('\n'), /reviewer_reattach_missing_pgid/);
});

test('alive pgid that does not match the reviewer session becomes sticky failed-orphan', async () => {
  const db = setupDb();
  seedReviewing(db);
  const log = makeLog();

  await reconcileReviewerSessions({
    db,
    octokit: makeOctokit([]),
    now: new Date(FAILURE_AT),
    log,
    probeSession: () => ({ alive: true, matched: false }),
    fetchHeadSha: async () => HEAD_SHA,
  });

  const row = readRow(db);
  assert.equal(row.review_status, 'failed-orphan');
  assert.equal(row.review_attempts, 3);
  assert.match(row.failure_message, /does not match the recorded reviewer session/);
  assert.match(log.lines.join('\n'), /reviewer_reattach_identity_mismatch/);
});

test('unknown reviewer values become sticky failed-orphan', async () => {
  const db = setupDb();
  seedReviewing(db, { reviewer: 'claude-code' });
  const log = makeLog();

  await reconcileReviewerSessions({
    db,
    octokit: makeOctokit([]),
    now: new Date(FAILURE_AT),
    log,
  });

  const row = readRow(db);
  assert.equal(row.review_status, 'failed-orphan');
  assert.equal(row.review_attempts, 3);
  assert.match(row.failure_message, /unknown reviewer value/);
  assert.match(log.lines.join('\n'), /reviewer_reattach_unknown_reviewer/);
});

test('corrupt reviewer_started_at becomes sticky failed-orphan', async () => {
  const db = setupDb();
  seedReviewing(db, { startedAt: 'not-a-date' });
  const log = makeLog();

  await reconcileReviewerSessions({
    db,
    octokit: makeOctokit([]),
    now: new Date(FAILURE_AT),
    log,
  });

  const row = readRow(db);
  assert.equal(row.review_status, 'failed-orphan');
  assert.equal(row.review_attempts, 3);
  assert.match(row.failure_message, /metadata is corrupt/);
  assert.match(log.lines.join('\n'), /reviewer_reattach_corrupt_started_at/);
});

test('fetchHeadSha failures become sticky failed-orphan', async () => {
  const db = setupDb();
  seedReviewing(db);
  const log = makeLog();

  await reconcileReviewerSessions({
    db,
    octokit: makeOctokit([]),
    now: new Date(FAILURE_AT),
    log,
    fetchHeadSha: async () => {
      throw new Error('github down');
    },
  });

  const row = readRow(db);
  assert.equal(row.review_status, 'failed-orphan');
  assert.equal(row.review_attempts, 3);
  assert.match(row.failure_message, /head probe failed: github down/);
  assert.match(log.lines.join('\n'), /reviewer_reattach_probe_failed/);
});

test('findPostedReview failures become sticky failed-orphan', async () => {
  const db = setupDb();
  seedReviewing(db);
  const log = makeLog();

  await reconcileReviewerSessions({
    db,
    octokit: makeOctokit([]),
    now: new Date(FAILURE_AT),
    log,
    fetchHeadSha: async () => HEAD_SHA,
    findPostedReview: async () => {
      throw new Error('reviews unavailable');
    },
  });

  const row = readRow(db);
  assert.equal(row.review_status, 'failed-orphan');
  assert.equal(row.review_attempts, 3);
  assert.match(row.failure_message, /review probe failed: reviews unavailable/);
  assert.match(log.lines.join('\n'), /reviewer_reattach_probe_failed/);
});
