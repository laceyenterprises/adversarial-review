import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { ensureReviewStateSchema } from '../src/review-state.mjs';
import {
  LEGACY_ORPHAN_FAILURE_MESSAGE,
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
    probeAlive: () => true,
    fetchHeadSha: async () => HEAD_SHA,
  });

  const row = readRow(db);
  assert.equal(row.review_status, 'reviewing');
  assert.equal(row.review_attempts, 2, 'reattach must not burn an attempt');
  assert.match(log.lines.join('\n'), /reviewer_reattach_alive/);
  assert.match(log.lines.join('\n'), /session=session-70 pgid=9001/);
});

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
    probeAlive: () => true,
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
    probeAlive: () => true,
    fetchHeadSha: async () => HEAD_SHA,
  });

  const row = readRow(db);
  assert.equal(row.review_status, 'failed-orphan');
  assert.equal(row.review_attempts, 3);
  assert.match(row.failure_message, /posted a GitHub review/);
  assert.match(log.lines.join('\n'), /reviewer_reattach_orphan/);
});
