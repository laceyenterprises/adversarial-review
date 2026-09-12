import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { reconcileEligibleReviewingClaimInline } from '../src/pollonce-phases.mjs';
import { DEFAULT_NULL_PGID_LAUNCH_GRACE_MS } from '../src/reviewer-reattach.mjs';

const REPO = 'laceyenterprises/adversarial-review';
const PR = 1045;
const HEAD = '8e057901eb41825963340a7b8763594d46a53aed';
const LEASE_TIMEOUT_MS = 20 * 60 * 1000;

function setupDb() {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  return db;
}

function seedReviewingNullPgid(db, {
  now,
  lastAttemptedAgeMs,
  sessionUuid = 'inline-null-pgid-session',
} = {}) {
  const lastAttemptedAt = new Date(now.getTime() - lastAttemptedAgeMs).toISOString();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_TIMEOUT_MS).toISOString();
  db.prepare(
    `INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
        review_attempts, last_attempted_at, reviewer_session_uuid,
        reviewer_pgid, reviewer_started_at, reviewer_head_sha, reviewer_timeout_ms,
        reviewer_lease_expires_at, infra_auto_recover_attempts)
     VALUES (?, ?, ?, ?, 'open', 'reviewing', 0, ?, ?, NULL, NULL, ?, ?, ?, 0)`
  ).run(
    REPO,
    PR,
    lastAttemptedAt,
    'gemini',
    lastAttemptedAt,
    sessionUuid,
    HEAD,
    LEASE_TIMEOUT_MS,
    leaseExpiresAt,
  );
}

function readRow(db) {
  return db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(REPO, PR);
}

function makeOctokit() {
  return {
    rest: {
      pulls: {
        get: async () => ({ data: { head: { sha: HEAD } } }),
        listReviews: async () => ({ data: [] }),
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

test('inline reconcile requeues an expired null-pgid claim before same-head spawn suppression', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'inline-reviewer-reconcile-'));
  const db = setupDb();
  const now = new Date('2026-09-12T01:34:00.000Z');
  try {
    seedReviewingNullPgid(db, {
      now,
      lastAttemptedAgeMs: DEFAULT_NULL_PGID_LAUNCH_GRACE_MS + 1_000,
    });
    const settled = [];
    const log = makeLog();

    const result = await reconcileEligibleReviewingClaimInline({
      reviewDb: db,
      octokit: makeOctokit(),
      rootDir,
      repoPath: REPO,
      prNumber: PR,
      row: readRow(db),
      now,
      leaseRecoveryMaxAttempts: 3,
      onTerminalDeadSession: async (event) => settled.push(event),
      log,
    });

    const row = readRow(db);
    assert.equal(result.attempted, true);
    assert.equal(result.reconciled, 1);
    assert.equal(row.review_status, 'pending');
    assert.equal(row.reviewer_session_uuid, null);
    assert.equal(row.reviewer_pgid, null);
    assert.equal(row.reviewer_lease_expires_at, null);
    assert.match(row.failure_message, /no live reviewer process group was found/);
    assert.deepEqual(
      settled.map(({ state, reason }) => ({ state, reason })),
      [{ state: 'cancelled', reason: 'missing-pgid-no-live-reviewer' }],
    );
    assert.match(
      log.lines.join('\n'),
      /inline stale reviewer claim reconcile .* reviewing -> pending before spawn suppression/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    db.close();
  }
});

test('inline reconcile leaves fresh null-pgid launch claims protected by the grace window', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'inline-reviewer-reconcile-fresh-'));
  const db = setupDb();
  const now = new Date('2026-09-12T01:34:00.000Z');
  try {
    seedReviewingNullPgid(db, {
      now,
      lastAttemptedAgeMs: DEFAULT_NULL_PGID_LAUNCH_GRACE_MS - 1_000,
      sessionUuid: 'fresh-inline-null-pgid-session',
    });

    const result = await reconcileEligibleReviewingClaimInline({
      reviewDb: db,
      octokit: makeOctokit(),
      rootDir,
      repoPath: REPO,
      prNumber: PR,
      row: readRow(db),
      now,
    });

    const row = readRow(db);
    assert.equal(result.attempted, false);
    assert.equal(row.review_status, 'reviewing');
    assert.equal(row.reviewer_session_uuid, 'fresh-inline-null-pgid-session');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    db.close();
  }
});
