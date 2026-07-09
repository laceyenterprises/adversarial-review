import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureReviewStateSchema } from '../src/review-state.mjs';
import {
  autoReclaimFailedOrphans,
  failedOrphanAutoReclaimDecision,
  probeReviewerProcessSession,
} from '../src/watcher.mjs';

const REPO = 'laceyenterprises/adversarial-review';
const NOW = new Date('2026-07-09T22:00:00.000Z');

function setupDb() {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'failed-orphan-reclaim-'));
  mkdirSync(path.join(rootDir, 'data'), { recursive: true });
  const db = new Database(path.join(rootDir, 'data', 'reviews.db'));
  ensureReviewStateSchema(db);
  return { rootDir, db };
}

function setupLegacyNullableCounterDb() {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'failed-orphan-reclaim-legacy-'));
  mkdirSync(path.join(rootDir, 'data'), { recursive: true });
  const db = new Database(path.join(rootDir, 'data', 'reviews.db'));
  db.prepare(
    `CREATE TABLE reviewed_prs (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       repo TEXT NOT NULL,
       pr_number INTEGER NOT NULL,
       reviewed_at TEXT,
       reviewer TEXT,
       pr_state TEXT,
       review_status TEXT,
       review_attempts INTEGER,
       last_attempted_at TEXT,
       posted_at TEXT,
       failed_at TEXT,
       failure_message TEXT,
       rereview_requested_at TEXT,
       rereview_reason TEXT,
       reviewer_session_uuid TEXT,
       reviewer_pgid INTEGER,
       reviewer_started_at TEXT,
       reviewer_head_sha TEXT,
       reviewer_timeout_ms INTEGER,
       reviewer_lease_expires_at TEXT,
       quota_reset_at_utc TEXT,
       review_population_retry_attempts INTEGER,
       review_population_retry_last_at TEXT,
       review_population_retry_head_sha TEXT,
       infra_auto_recover_attempts INTEGER
     )`
  ).run();
  return { rootDir, db };
}

function insertRow(db, {
  prNumber = 548,
  status = 'failed-orphan',
  prState = 'open',
  infraAttempts = 0,
  leaseExpiresAt = '2026-07-09T21:50:00.000Z',
  pgid = 9001,
  sessionUuid = 'session-orphan',
} = {}) {
  db.prepare(
    `INSERT INTO reviewed_prs (
       repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
       review_attempts, failed_at, failure_message, reviewer_session_uuid,
       reviewer_pgid, reviewer_started_at, reviewer_head_sha, reviewer_timeout_ms,
       reviewer_lease_expires_at, infra_auto_recover_attempts
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    REPO,
    prNumber,
    '2026-07-09T21:00:00.000Z',
    'codex',
    prState,
    status,
    3,
    '2026-07-09T21:10:00.000Z',
    'Watcher restarted while review subprocess was in flight.',
    sessionUuid,
    pgid,
    '2026-07-09T21:00:00.000Z',
    'head-1',
    20 * 60 * 1000,
    leaseExpiresAt,
    infraAttempts
  );
}

function statements(db) {
  return {
    listCandidates: db.prepare(
      `SELECT repo, pr_number, pr_state, review_status, reviewer, review_attempts,
              last_attempted_at, failed_at, failure_message, reviewer_session_uuid,
              reviewer_pgid, reviewer_started_at, reviewer_head_sha, reviewer_timeout_ms,
              reviewer_lease_expires_at, infra_auto_recover_attempts
         FROM reviewed_prs
        WHERE pr_state = 'open'
          AND review_status = 'failed-orphan'
          AND COALESCE(infra_auto_recover_attempts, 0) < ?
        ORDER BY failed_at ASC, last_attempted_at ASC, id ASC
        LIMIT ?`
    ),
    reclaim: db.prepare(
      `UPDATE reviewed_prs
          SET review_status = 'pending',
              review_attempts = 0,
              last_attempted_at = NULL,
              posted_at = NULL,
              failed_at = ?,
              failure_message = ?,
              rereview_requested_at = ?,
              rereview_reason = ?,
              reviewer_session_uuid = NULL,
              reviewer_pgid = NULL,
              reviewer_started_at = NULL,
              reviewer_head_sha = NULL,
              reviewer_timeout_ms = NULL,
              reviewer_lease_expires_at = NULL,
              quota_reset_at_utc = NULL,
              review_population_retry_attempts = 0,
              review_population_retry_last_at = NULL,
              review_population_retry_head_sha = NULL,
              infra_auto_recover_attempts = COALESCE(infra_auto_recover_attempts, 0) + 1
        WHERE repo = ?
          AND pr_number = ?
          AND pr_state = 'open'
          AND review_status = 'failed-orphan'
          AND COALESCE(infra_auto_recover_attempts, 0) < ?
          AND COALESCE(reviewer_session_uuid, '') = COALESCE(?, '')
          AND COALESCE(reviewer_pgid, '') = COALESCE(?, '')
          AND COALESCE(reviewer_lease_expires_at, '') = COALESCE(?, '')`
    ),
    markPosted: db.prepare(
      `UPDATE reviewed_prs
          SET review_status = 'posted',
              posted_at = ?,
              failed_at = NULL,
              failure_message = NULL,
              quota_reset_at_utc = NULL,
              review_attempts = review_attempts + 1,
              reviewer_lease_expires_at = NULL,
              infra_auto_recover_attempts = 0
        WHERE repo = ?
          AND pr_number = ?`
    ),
  };
}

test('failed-orphan with expired lease and no live reviewer is auto-reset to pending', async () => {
  const { rootDir, db } = setupDb();
  try {
    insertRow(db);
    const audit = [];
    const result = await autoReclaimFailedOrphans({
      now: NOW,
      statements: statements(db),
      probeSessionImpl: () => ({ alive: false, matched: false }),
      settleRunRecord: ({ sessionUuid, settledAt }) => audit.push({ sessionUuid, settledAt }),
      log: { log() {}, warn() {} },
    });

    assert.deepEqual(result, { reclaimed: 1, skipped: 0 });
    const row = db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(REPO, 548);
    assert.equal(row.review_status, 'pending');
    assert.equal(row.review_attempts, 0);
    assert.equal(row.reviewer_session_uuid, null);
    assert.equal(row.infra_auto_recover_attempts, 1);
    assert.match(row.failure_message, /^\[failed-orphan-auto-reclaim\]/);
    assert.deepEqual(audit, [{ sessionUuid: 'session-orphan', settledAt: NOW.toISOString() }]);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('failed-orphan is not reclaimed when lease is active or reviewer process is live', async () => {
  assert.equal(
    (await failedOrphanAutoReclaimDecision({
      pr_state: 'open',
      review_status: 'failed-orphan',
      infra_auto_recover_attempts: 0,
      reviewer_lease_expires_at: '2026-07-09T22:05:00.000Z',
      reviewer_timeout_ms: 20 * 60 * 1000,
      reviewer_started_at: '2026-07-09T21:45:00.000Z',
    }, NOW, {
      probeSessionImpl: () => ({ alive: false, matched: false }),
    })).reason,
    'lease-active'
  );

  assert.equal(
    (await failedOrphanAutoReclaimDecision({
      pr_state: 'open',
      review_status: 'failed-orphan',
      infra_auto_recover_attempts: 0,
      reviewer_lease_expires_at: '2026-07-09T21:50:00.000Z',
      reviewer_pgid: 9001,
      reviewer_session_uuid: 'session-orphan',
    }, NOW, {
      probeSessionImpl: () => ({ alive: true, matched: true }),
    })).reason,
    'reviewer-live'
  );
});

test('failed-orphan with recycled reviewer pgid is reclaimed after lease expiry', async () => {
  const result = await failedOrphanAutoReclaimDecision({
    pr_state: 'open',
    review_status: 'failed-orphan',
    infra_auto_recover_attempts: 0,
    reviewer_lease_expires_at: '2026-07-09T21:50:00.000Z',
    reviewer_pgid: 9001,
    reviewer_session_uuid: 'session-orphan',
  }, NOW, {
    probeSessionImpl: () => ({ alive: true, matched: false }),
  });

  assert.deepEqual(result, {
    reclaim: true,
    reason: 'reviewer-session-mismatch',
  });
});

test('failed-orphan is not reclaimed when reviewer liveness probe is unknown', async () => {
  const result = await failedOrphanAutoReclaimDecision({
    pr_state: 'open',
    review_status: 'failed-orphan',
    infra_auto_recover_attempts: 0,
    reviewer_lease_expires_at: '2026-07-09T21:50:00.000Z',
    reviewer_pgid: 9001,
    reviewer_session_uuid: 'session-orphan',
  }, NOW, {
    probeSessionImpl: () => ({ alive: true, matched: 'unknown' }),
  });

  assert.deepEqual(result, {
    reclaim: false,
    reason: 'reviewer-liveness-unknown',
  });
});

test('failed-orphan auto-reclaim handles legacy NULL infra counter rows', async () => {
  const { rootDir, db } = setupLegacyNullableCounterDb();
  try {
    insertRow(db, { infraAttempts: null });

    const result = await autoReclaimFailedOrphans({
      now: NOW,
      statements: statements(db),
      probeSessionImpl: () => ({ alive: false, matched: false }),
      log: { log() {}, warn() {} },
    });

    assert.deepEqual(result, { reclaimed: 1, skipped: 0 });
    const row = db.prepare('SELECT review_status, infra_auto_recover_attempts FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(REPO, 548);
    assert.equal(row.review_status, 'pending');
    assert.equal(row.infra_auto_recover_attempts, 1);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reviewer session probe uses non-blocking ps with unlimited command width', async () => {
  const calls = [];
  const result = await probeReviewerProcessSession({
    pgid: 9001,
    sessionUuid: 'session-width-test',
    probeGroupAliveImpl: () => true,
    execFileImpl: async (bin, argv, options) => {
      calls.push({ bin, argv, options });
      return { stdout: 'prefix session-width-test suffix' };
    },
  });

  assert.deepEqual(result, { alive: true, matched: true });
  assert.equal(calls[0].bin, 'ps');
  assert.deepEqual(calls[0].argv, ['-ww', '-p', '9001', '-o', 'command=']);
  assert.equal(calls[0].options.timeout, 2_000);
});

test('reviewer session probe reports unknown match on transient ps failure', async () => {
  const result = await probeReviewerProcessSession({
    pgid: 9001,
    sessionUuid: 'session-width-test',
    probeGroupAliveImpl: () => true,
    execFileImpl: async () => {
      throw new Error('fork failed');
    },
  });

  assert.deepEqual(result, { alive: true, matched: 'unknown' });
});

test('reviewer session probe reports unknown for live legacy pgid without session uuid', async () => {
  const result = await probeReviewerProcessSession({
    pgid: 4321,
    sessionUuid: null,
    probeGroupAliveImpl: () => true,
    execFileImpl: async () => {
      throw new Error('ps should not run when session uuid is missing');
    },
  });

  assert.deepEqual(result, { alive: true, matched: 'unknown' });
});

test('failed-orphan auto-reclaim is bounded by infra counter', async () => {
  const { rootDir, db } = setupDb();
  try {
    insertRow(db, { infraAttempts: 3 });
    const result = await autoReclaimFailedOrphans({
      now: NOW,
      cap: 3,
      statements: statements(db),
      probeSessionImpl: () => ({ alive: false, matched: false }),
      log: { log() {}, warn() {} },
    });

    assert.deepEqual(result, { reclaimed: 0, skipped: 0 });
    const row = db.prepare('SELECT review_status, infra_auto_recover_attempts FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(REPO, 548);
    assert.equal(row.review_status, 'failed-orphan');
    assert.equal(row.infra_auto_recover_attempts, 3);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('failed-orphan auto-reclaim leaves terminal and non-orphan failed rows untouched', async () => {
  const { rootDir, db } = setupDb();
  try {
    insertRow(db, { prNumber: 1, status: 'posted' });
    insertRow(db, { prNumber: 2, status: 'malformed' });
    insertRow(db, { prNumber: 3, status: 'failed' });

    const result = await autoReclaimFailedOrphans({
      now: NOW,
      statements: statements(db),
      probeSessionImpl: () => ({ alive: false, matched: false }),
      log: { log() {}, warn() {} },
    });

    assert.deepEqual(result, { reclaimed: 0, skipped: 0 });
    const rows = db.prepare('SELECT pr_number, review_status FROM reviewed_prs ORDER BY pr_number').all();
    assert.deepEqual(rows, [
      { pr_number: 1, review_status: 'posted' },
      { pr_number: 2, review_status: 'malformed' },
      { pr_number: 3, review_status: 'failed' },
    ]);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('failed-orphan auto-reclaim marks posted when a late reviewer post is found', async () => {
  const { rootDir, db } = setupDb();
  try {
    insertRow(db);
    const result = await autoReclaimFailedOrphans({
      now: NOW,
      statements: statements(db),
      probeSessionImpl: () => ({ alive: false, matched: false }),
      findPostedReview: async () => ({ submitted_at: '2026-07-09T21:55:00.000Z' }),
      log: { log() {}, warn() {} },
    });

    assert.deepEqual(result, { reclaimed: 0, skipped: 1 });
    const row = db.prepare('SELECT review_status, posted_at, infra_auto_recover_attempts FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(REPO, 548);
    assert.equal(row.review_status, 'posted');
    assert.equal(row.posted_at, '2026-07-09T21:55:00.000Z');
    assert.equal(row.infra_auto_recover_attempts, 0);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
