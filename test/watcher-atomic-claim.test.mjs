import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { ensureReviewStateSchema } from '../src/review-state.mjs';

// The atomic-claim SQL lives inline in src/watcher.mjs (it's bound to
// the module's prepared-statement set there). The watcher module has
// import-time side effects (opens reviews.db, registers process
// handlers) that we don't want in unit tests, so we re-derive the same
// SQL here and assert against it. If the watcher's SQL ever drifts
// from this, both copies will fail their respective callers' tests
// long before that drift can ship — keep them in sync.
//
// This is the cross-process layer of the duplicate-spawn guard. The
// in-process layer is the watcher's self-scheduling pollOnce loop.
// Together they close the duplicate-spawn vector at both layers.
const CLAIM_SQL = `UPDATE reviewed_prs
     SET review_status = 'reviewing',
         last_attempted_at = ?,
         reviewer_session_uuid = ?,
         reviewer_started_at = NULL,
         reviewer_head_sha = ?,
         reviewer_timeout_ms = ?,
         reviewer_lease_expires_at = ?,
         reviewer_pgid = NULL,
         failed_at = CASE
           WHEN review_status = 'pending-upstream' THEN failed_at
           ELSE NULL
         END,
         failure_message = CASE
           WHEN review_status = 'pending-upstream' THEN failure_message
           ELSE NULL
         END
   WHERE repo = ?
     AND pr_number = ?
     AND review_status IN ('pending', 'pending-upstream')`;
const RELEASE_TO_PENDING_SQL =
  "UPDATE reviewed_prs SET review_status = 'pending', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1, reviewer_lease_expires_at = NULL WHERE repo = ? AND pr_number = ? AND review_status = 'reviewing'";
const MARK_POSTED_SQL =
  "UPDATE reviewed_prs SET review_status = 'posted', posted_at = ?, failed_at = NULL, failure_message = NULL, review_attempts = review_attempts + 1, reviewer_lease_expires_at = NULL, infra_auto_recover_attempts = 0 WHERE repo = ? AND pr_number = ?";
const INFRA_RECOVERY_CLAIM_SQL = `UPDATE reviewed_prs
     SET review_status = 'reviewing',
         last_attempted_at = ?,
         reviewer_session_uuid = ?,
         reviewer_started_at = NULL,
         reviewer_head_sha = ?,
         reviewer_timeout_ms = ?,
         reviewer_lease_expires_at = ?,
         reviewer_pgid = NULL,
         failed_at = NULL,
         failure_message = NULL,
         infra_auto_recover_attempts = infra_auto_recover_attempts + 1
   WHERE repo = ?
     AND pr_number = ?
     AND review_status = 'failed'
     AND infra_auto_recover_attempts < ?
     AND (
       (? = 'cascade' AND (
         lower(COALESCE(failure_message, '')) LIKE '[cascade]%' OR
         lower(COALESCE(failure_message, '')) LIKE '%litellm/upstream cascade%' OR
         lower(COALESCE(failure_message, '')) LIKE '%watcher backoff engaged%'
       )) OR
       (? = 'reviewer-timeout' AND lower(COALESCE(failure_message, '')) LIKE '[reviewer-timeout]%') OR
       (? = 'launchctl-bootstrap' AND (
         lower(COALESCE(failure_message, '')) LIKE '[launchctl-bootstrap]%' OR
         lower(COALESCE(failure_message, '')) LIKE '%claude launchctl session bootstrap failed%' OR
         lower(COALESCE(failure_message, '')) LIKE '%launchctlsessionerror%'
       )) OR
       (? = 'oauth-broken' AND lower(COALESCE(failure_message, '')) LIKE '%[oauth-broken]%')
     )`;

function runClaim(db, attemptedAt, repo = REPO, prNumber = PR, {
  sessionUuid = 'session-999',
  headSha = 'head-999',
  reviewerTimeoutMs = 20 * 60 * 1000,
} = {}) {
  return db.prepare(CLAIM_SQL).run(
    attemptedAt,
    sessionUuid,
    headSha,
    reviewerTimeoutMs,
    '2026-05-02T18:30:00.000Z',
    repo,
    prNumber
  );
}

function runInfraRecoveryClaim(db, attemptedAt, infraClass = 'oauth-broken', repo = REPO, prNumber = PR, {
  sessionUuid = 'session-999',
  headSha = 'head-999',
  reviewerTimeoutMs = 20 * 60 * 1000,
  cap = 3,
} = {}) {
  return db.prepare(INFRA_RECOVERY_CLAIM_SQL).run(
    attemptedAt,
    sessionUuid,
    headSha,
    reviewerTimeoutMs,
    '2026-05-02T18:30:00.000Z',
    repo,
    prNumber,
    cap,
    infraClass,
    infraClass,
    infraClass,
    infraClass
  );
}

const REPO = 'laceyenterprises/agent-os';
const PR = 999;

function setupDb() {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  return db;
}

function seedReviewRow(db, {
  reviewStatus,
  lastAttemptedAt = null,
  failedAt = null,
  failureMessage = null,
  infraAutoRecoverAttempts = 0,
}) {
  db.prepare(
    `INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
        review_attempts, last_attempted_at, failed_at, failure_message, infra_auto_recover_attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    REPO,
    PR,
    '2026-05-02T18:00:00.000Z',
    'claude',
    'open',
    reviewStatus,
    0,
    lastAttemptedAt,
    failedAt,
    failureMessage,
    infraAutoRecoverAttempts
  );
}

function readRow(db) {
  return db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(REPO, PR);
}

test('atomic claim succeeds for a pending row and flips status to reviewing', () => {
  const db = setupDb();
  seedReviewRow(db, { reviewStatus: 'pending' });

  const claim = runClaim(db, '2026-05-02T18:10:00.000Z');

  assert.equal(claim.changes, 1);
  const row = readRow(db);
  assert.equal(row.review_status, 'reviewing');
  assert.equal(row.last_attempted_at, '2026-05-02T18:10:00.000Z');
  assert.equal(row.reviewer_session_uuid, 'session-999');
  assert.equal(row.reviewer_started_at, null);
  assert.equal(row.reviewer_head_sha, 'head-999');
  assert.equal(row.reviewer_timeout_ms, 20 * 60 * 1000);
  assert.equal(row.reviewer_lease_expires_at, '2026-05-02T18:30:00.000Z');
  assert.equal(row.reviewer_pgid, null);
  assert.equal(row.failed_at, null);
  assert.equal(row.failure_message, null);
});

test('atomic claim refuses generic failed rows so failure evidence stays terminal', () => {
  const db = setupDb();
  seedReviewRow(db, { reviewStatus: 'failed', failureMessage: '[forbidden-fallback] API key fallback blocked' });

  const claim = runClaim(db, '2026-05-02T18:10:00.000Z');

  assert.equal(claim.changes, 0, 'generic claim must not retry failed rows');
  const row = readRow(db);
  assert.equal(row.review_status, 'failed');
  assert.equal(row.failure_message, '[forbidden-fallback] API key fallback blocked');
});

test('infra auto-recovery claim atomically promotes and increments the failed row', () => {
  const db = setupDb();
  seedReviewRow(db, { reviewStatus: 'failed', failureMessage: '[oauth-broken] reviewer spawn failed' });

  const claim = runInfraRecoveryClaim(db, '2026-05-02T18:10:00.000Z');
  assert.equal(claim.changes, 1);
  const row = readRow(db);
  assert.equal(row.review_status, 'reviewing');
  assert.equal(row.reviewer_session_uuid, 'session-999');
  assert.equal(row.failed_at, null);
  assert.equal(row.failure_message, null);
  assert.equal(row.infra_auto_recover_attempts, 1);
});

test('stale infra auto-recovery observation cannot increment a row that is no longer failed', () => {
  const db = setupDb();
  seedReviewRow(db, { reviewStatus: 'failed', failureMessage: '[oauth-broken] reviewer spawn failed' });
  db.prepare(
    "UPDATE reviewed_prs SET review_status = 'pending', failure_message = NULL WHERE repo = ? AND pr_number = ?"
  ).run(REPO, PR);

  const claim = runInfraRecoveryClaim(db, '2026-05-02T18:10:00.000Z');

  assert.equal(claim.changes, 0);
  const row = readRow(db);
  assert.equal(row.review_status, 'pending');
  assert.equal(row.infra_auto_recover_attempts, 0);
});

test('infra auto-recovery claim refuses a changed failure class', () => {
  const db = setupDb();
  seedReviewRow(db, { reviewStatus: 'failed', failureMessage: '[cascade] LiteLLM upstream cascade' });

  const claim = runInfraRecoveryClaim(db, '2026-05-02T18:10:00.000Z', 'oauth-broken');

  assert.equal(claim.changes, 0);
  const row = readRow(db);
  assert.equal(row.review_status, 'failed');
  assert.equal(row.failure_message, '[cascade] LiteLLM upstream cascade');
  assert.equal(row.infra_auto_recover_attempts, 0);
});

test('successful post resets infra auto-recovery budget for later incidents', () => {
  const db = setupDb();
  seedReviewRow(db, {
    reviewStatus: 'reviewing',
    failedAt: '2026-05-02T18:00:00.000Z',
    failureMessage: '[oauth-broken] reviewer spawn failed',
    infraAutoRecoverAttempts: 3,
  });

  const posted = db.prepare(MARK_POSTED_SQL).run('2026-05-02T18:20:00.000Z', REPO, PR);

  assert.equal(posted.changes, 1);
  const row = readRow(db);
  assert.equal(row.review_status, 'posted');
  assert.equal(row.infra_auto_recover_attempts, 0);
});

test('atomic claim succeeds for a pending-upstream row once backoff has expired', () => {
  const db = setupDb();
  seedReviewRow(db, { reviewStatus: 'pending-upstream', failureMessage: 'LiteLLM upstream cascade' });

  const claim = runClaim(db, '2026-05-02T18:10:00.000Z');

  assert.equal(claim.changes, 1, 'pending-upstream rows must be reclaimable after the watcher backoff gate opens');
  const row = readRow(db);
  assert.equal(row.review_status, 'reviewing');
  assert.equal(row.failure_message, 'LiteLLM upstream cascade', 'cascade audit trail must survive pending-upstream reclaim');
});

test('atomic claim refuses when status is already reviewing (in-flight claim)', () => {
  const db = setupDb();
  seedReviewRow(db, {
    reviewStatus: 'reviewing',
    lastAttemptedAt: '2026-05-02T18:09:00.000Z',
  });

  const claim = runClaim(db, '2026-05-02T18:10:00.000Z');

  assert.equal(claim.changes, 0, 'claim must lose the race against an in-flight reviewer');
  const row = readRow(db);
  assert.equal(row.review_status, 'reviewing');
  assert.equal(row.last_attempted_at, '2026-05-02T18:09:00.000Z', 'last_attempted_at unchanged');
});

test('atomic claim refuses for terminal and orphan-locked statuses', () => {
  // 'posted' / 'malformed' are terminal. 'failed-orphan' is the sticky
  // operator-recovery state set by reconcileOrphanedReviewing — auto-
  // reclaiming it would erase the GitHub-side-verified-or-not signal
  // that a previous reviewer subprocess may already have posted.
  for (const status of ['posted', 'malformed', 'failed-orphan']) {
    const db = setupDb();
    seedReviewRow(db, { reviewStatus: status });

    const claim = runClaim(db, '2026-05-02T18:10:00.000Z');

    assert.equal(claim.changes, 0, `claim must refuse status='${status}'`);
    const row = readRow(db);
    assert.equal(row.review_status, status, `status='${status}' unchanged`);
  }
});

test('atomic claim simulates a real two-process race — only one wins', () => {
  // SQLite serializes the two UPDATEs; only one should match the
  // WHERE clause's status='pending' arm. The second sees the row
  // already at 'reviewing' and refuses.
  const db = setupDb();
  seedReviewRow(db, { reviewStatus: 'pending' });

  const claimA = runClaim(db, '2026-05-02T18:10:00.000Z', REPO, PR, {
    sessionUuid: 'session-a',
  });
  const claimB = runClaim(db, '2026-05-02T18:10:00.001Z', REPO, PR, {
    sessionUuid: 'session-b',
  });

  assert.equal(claimA.changes, 1, 'first claim wins');
  assert.equal(claimB.changes, 0, 'second claim loses — status is no longer pending');
  const row = readRow(db);
  assert.equal(row.review_status, 'reviewing');
  assert.equal(row.last_attempted_at, '2026-05-02T18:10:00.000Z', 'winner timestamp persists');
  assert.equal(row.reviewer_session_uuid, 'session-a', 'winner session persists');
});

test('lease recovery release and a fresh tick still admit only one replacement reviewer', () => {
  const db = setupDb();
  seedReviewRow(db, { reviewStatus: 'reviewing' });

  const release = db.prepare(RELEASE_TO_PENDING_SQL).run(
    '2026-05-02T18:09:30.000Z',
    '[daemon-bounce] reviewer bounced',
    REPO,
    PR
  );
  assert.equal(release.changes, 1, 'expired reviewer lease is released back to pending once');

  const claimA = runClaim(db, '2026-05-02T18:10:00.000Z', REPO, PR, {
    sessionUuid: 'session-recovered-a',
  });
  const claimB = runClaim(db, '2026-05-02T18:10:00.001Z', REPO, PR, {
    sessionUuid: 'session-recovered-b',
  });

  assert.equal(claimA.changes, 1);
  assert.equal(claimB.changes, 0);
  const row = readRow(db);
  assert.equal(row.review_status, 'reviewing');
  assert.equal(row.review_attempts, 1, 'release consumes one failed attempt before the next spawn');
  assert.equal(row.reviewer_session_uuid, 'session-recovered-a');
});

test('atomic claim refuses pending row from a different PR — repo/pr scoping is correct', () => {
  const db = setupDb();
  seedReviewRow(db, { reviewStatus: 'pending' });

  const claim = runClaim(db, '2026-05-02T18:10:00.000Z', REPO, PR + 1);

  assert.equal(claim.changes, 0);
  const row = readRow(db);
  assert.equal(row.review_status, 'pending', 'unrelated row not touched');
});
