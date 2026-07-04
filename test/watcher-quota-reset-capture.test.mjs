// watcher-quota-reset-capture.test.mjs — proves the review-lane HRR
// quota-exhaustion capture/hold/recovery path end to end:
//
//   1. On a quota-exhausted reviewer failure the watcher parses the provider
//      reset time from the FULL output (stdout/stderr, before failure_message
//      truncation can drop the "try again at" line) and stores it durably in
//      reviewed_prs.quota_reset_at_utc.
//   2. The outage settlement is non-terminal and does not consume review_attempts.
//   3. Once the reset has passed, the pending-upstream row is re-claimed for a
//      real attempt.
//   4. A quota failure with NO parseable reset falls back to the default window
//      and logs loudly, with quota_reset_at_utc left NULL.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { settleReviewerAttempt } from '../src/watcher.mjs';
import {
  QUOTA_EXHAUSTED_FAILURE_CLASS,
} from '../src/quota-exhaustion.mjs';

const REPO = 'laceyenterprises/agent-os';
const PR = 2429;

function setupFixture({ reviewer = 'codex' } = {}) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-quota-'));
  mkdirSync(path.join(rootDir, 'data'), { recursive: true });
  const db = new Database(path.join(rootDir, 'data', 'reviews.db'));
  ensureReviewStateSchema(db);
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts, infra_auto_recover_attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(REPO, PR, '2026-06-17T17:00:00.000Z', reviewer, 'open', 'reviewing', 0, 0);
  return { rootDir, db };
}

// Quota-aware statements over the fixture db (mirrors the real watcher
// statements, including the quota_reset_at_utc capture columns).
function quotaStatements(db) {
  return {
    markPosted: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'posted', posted_at = ?, failed_at = NULL, failure_message = NULL, quota_reset_at_utc = NULL, review_attempts = review_attempts + 1, infra_auto_recover_attempts = 0 WHERE repo = ? AND pr_number = ?"
    ),
    markFailed: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, quota_reset_at_utc = NULL, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
    ),
    releaseReviewLease: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'pending', failed_at = ?, failure_message = ?, quota_reset_at_utc = NULL, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ? AND review_status = 'reviewing'"
    ),
    markFailedQuota: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, quota_reset_at_utc = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
    ),
    releaseReviewLeaseQuota: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'pending', failed_at = ?, failure_message = ?, quota_reset_at_utc = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ? AND review_status = 'reviewing'"
    ),
    markOutageTransient: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'pending-upstream', failed_at = ?, failure_message = ?, quota_reset_at_utc = ? WHERE repo = ? AND pr_number = ?"
    ),
    markCascadeFailed: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ? WHERE repo = ? AND pr_number = ?"
    ),
    markPendingUpstream: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'pending-upstream', failed_at = ?, failure_message = ? WHERE repo = ? AND pr_number = ?"
    ),
    getReviewRow: db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?'),
  };
}

function getRow(db) {
  return db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(REPO, PR);
}

// The codex usage-cap output: the reset line is buried amid stdout JSON noise,
// exactly the shape that gets truncated out of the terse failure_message.
const CODEX_QUOTA_OUTPUT = [
  'Command failed with code 1',
  'stdout tail:',
  '{"type":"event_msg","payload":{"type":"token_count"}}',
  'You have hit your usage limit. Try again at Jun 17th, 2026 5:39 PM or purchase more credits.',
  'stderr tail:',
  'reviewer subprocess exited non-zero',
].join('\n');

const CLAUDE_WEEKLY_QUOTA_OUTPUT = [
  'Command failed with code 1',
  'stdout tail:',
  "You've hit your weekly limit · resets Jun 27 at 3am (America/Los_Angeles)",
  'stderr tail:',
  '[reviewer] ERROR STACK: Error: Command failed with code 1',
].join('\n');

test('quota-exhausted outage failure preserves attempt budget and requeues after reset', () => {
  const { rootDir, db } = setupFixture();
  try {
    settleReviewerAttempt({
      rootDir,
      repoPath: REPO,
      prNumber: PR,
      result: {
        ok: false,
        failureClass: QUOTA_EXHAUSTED_FAILURE_CLASS,
        error: CODEX_QUOTA_OUTPUT,
        stdout: CODEX_QUOTA_OUTPUT,
        stderr: '',
      },
      failureAt: '2026-06-17T17:30:00.000Z',
      maxRemediationRounds: 2,
      leaseRecoveryEnabled: false,
      statements: quotaStatements(db),
    });

    const row = getRow(db);
    assert.equal(row.review_status, 'pending-upstream');
    assert.equal(row.review_attempts, 0);
    assert.equal(row.quota_reset_at_utc, '2026-06-18T00:39:00.000Z');
    assert.match(row.failure_message, /^\[outage-transient:quota-outage\] \[quota-exhausted\]/);
    // The full output is preserved in failure_message so the reset is also
    // re-derivable as a fallback.
    assert.match(row.failure_message, /try again at Jun 17th, 2026 5:39 PM/i);
    const state = JSON.parse(readFileSync(
      path.join(rootDir, 'data', 'cascade-state', `${encodeURIComponent(REPO)}__${PR}.json`),
      'utf8'
    ));
    assert.equal(state.lastFailureClass, QUOTA_EXHAUSTED_FAILURE_CLASS);
    assert.equal(state.nextRetryAfter, '2026-06-18T00:39:00.000Z');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('quota-exhausted failure captures Claude weekly reset from stdout', () => {
  const { rootDir, db } = setupFixture();
  try {
    settleReviewerAttempt({
      rootDir,
      repoPath: REPO,
      prNumber: PR,
      result: {
        ok: false,
        failureClass: QUOTA_EXHAUSTED_FAILURE_CLASS,
        error: 'Command failed with code 1',
        stdout: CLAUDE_WEEKLY_QUOTA_OUTPUT,
        stderr: '[reviewer] ERROR STACK: Error: Command failed with code 1',
      },
      failureAt: '2026-06-23T00:39:39.000Z',
      maxRemediationRounds: 2,
      leaseRecoveryEnabled: false,
      statements: quotaStatements(db),
    });

    const row = getRow(db);
    assert.equal(row.review_status, 'pending-upstream');
    assert.equal(row.review_attempts, 0);
    assert.equal(row.quota_reset_at_utc, '2026-06-27T10:00:00.000Z');
    assert.match(row.failure_message, /^\[outage-transient:quota-outage\] \[quota-exhausted\]/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('quota-exhausted lease-recovery settlement stays non-terminal for hold-until-reset', () => {
  const { rootDir, db } = setupFixture();
  try {
    settleReviewerAttempt({
      rootDir,
      repoPath: REPO,
      prNumber: PR,
      result: {
        ok: false,
        failureClass: QUOTA_EXHAUSTED_FAILURE_CLASS,
        error: CODEX_QUOTA_OUTPUT,
        stdout: CODEX_QUOTA_OUTPUT,
      },
      failureAt: '2026-06-17T17:30:00.000Z',
      maxRemediationRounds: 2,
      leaseRecoveryEnabled: true,
      statements: quotaStatements(db),
    });

    const row = getRow(db);
    assert.equal(row.review_status, 'pending-upstream');
    assert.equal(row.review_attempts, 0);
    assert.equal(row.quota_reset_at_utc, '2026-06-18T00:39:00.000Z');
    assert.match(row.failure_message, /^\[outage-transient:quota-outage\]/);

    const pendingClaim = db.prepare(
      `UPDATE reviewed_prs
          SET review_status = 'reviewing',
              failed_at = NULL,
              failure_message = NULL,
              quota_reset_at_utc = NULL
        WHERE repo = ?
          AND pr_number = ?
          AND review_status IN ('pending', 'pending-upstream')`
    ).run(REPO, PR);
    assert.equal(pendingClaim.changes, 1, 'pending-upstream row is the non-terminal requeue state');
    assert.equal(getRow(db).review_status, 'reviewing');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('hold-until-reset honors the stored reset and does NOT burn a review attempt', () => {
  const { rootDir, db } = setupFixture();
  try {
    settleReviewerAttempt({
      rootDir,
      repoPath: REPO,
      prNumber: PR,
      result: {
        ok: false,
        failureClass: QUOTA_EXHAUSTED_FAILURE_CLASS,
        error: CODEX_QUOTA_OUTPUT,
        stdout: CODEX_QUOTA_OUTPUT,
      },
      failureAt: '2026-06-17T17:30:00.000Z',
      maxRemediationRounds: 2,
      leaseRecoveryEnabled: false,
      statements: quotaStatements(db),
    });
    const row = getRow(db);
    assert.equal(row.infra_auto_recover_attempts, 0);
    assert.equal(row.review_attempts, 0);
    const state = JSON.parse(readFileSync(
      path.join(rootDir, 'data', 'cascade-state', `${encodeURIComponent(REPO)}__${PR}.json`),
      'utf8'
    ));
    assert.equal(state.nextRetryAfter, '2026-06-18T00:39:00.000Z');
    assert.equal(getRow(db).infra_auto_recover_attempts, 0);
    assert.equal(getRow(db).review_attempts, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a qualifying quota row IS re-claimed once the reset has passed without prior budget charge', () => {
  const { rootDir, db } = setupFixture();
  try {
    settleReviewerAttempt({
      rootDir,
      repoPath: REPO,
      prNumber: PR,
      result: {
        ok: false,
        failureClass: QUOTA_EXHAUSTED_FAILURE_CLASS,
        error: CODEX_QUOTA_OUTPUT,
        stdout: CODEX_QUOTA_OUTPUT,
      },
      failureAt: '2026-06-17T17:30:00.000Z',
      maxRemediationRounds: 2,
      leaseRecoveryEnabled: false,
      statements: quotaStatements(db),
    });
    const outageRow = getRow(db);
    assert.equal(outageRow.review_status, 'pending-upstream');
    assert.equal(outageRow.review_attempts, 0);

    const claim = db.prepare(
      `UPDATE reviewed_prs
          SET review_status = 'reviewing',
              failed_at = NULL,
              failure_message = NULL,
              quota_reset_at_utc = NULL,
              last_attempted_at = ?
        WHERE repo = ? AND pr_number = ?
          AND review_status = 'pending-upstream'`
    ).run('2026-06-18T01:00:00.000Z', REPO, PR);
    assert.equal(claim.changes, 1, 'the quota row must be requeued for recovery');

    const reclaimed = getRow(db);
    assert.equal(reclaimed.review_status, 'reviewing');
    assert.equal(reclaimed.review_attempts, 0);
    assert.equal(reclaimed.quota_reset_at_utc, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('quota failure with NO parseable reset leaves quota_reset_at_utc NULL (falls back to default window)', () => {
  const { rootDir, db } = setupFixture();
  try {
    const terse = 'Command failed with code 1\nstdout tail:...';
    settleReviewerAttempt({
      rootDir,
      repoPath: REPO,
      prNumber: PR,
      result: {
        ok: false,
        failureClass: QUOTA_EXHAUSTED_FAILURE_CLASS,
        error: terse,
        stdout: terse,
      },
      failureAt: '2026-06-17T17:30:00.000Z',
      maxRemediationRounds: 2,
      leaseRecoveryEnabled: false,
      statements: quotaStatements(db),
    });
    const row = getRow(db);
    assert.equal(row.review_status, 'pending-upstream');
    assert.equal(row.review_attempts, 0);
    assert.equal(row.quota_reset_at_utc, null);
    assert.match(row.failure_message, /^\[outage-transient:quota-outage\]/);
    const state = JSON.parse(readFileSync(
      path.join(rootDir, 'data', 'cascade-state', `${encodeURIComponent(REPO)}__${PR}.json`),
      'utf8'
    ));
    assert.equal(state.nextRetryAfter, '2026-06-17T17:45:00.000Z');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('broker outage failure is requeued without charging review attempts', () => {
  const { rootDir, db } = setupFixture();
  try {
    settleReviewerAttempt({
      rootDir,
      repoPath: REPO,
      prNumber: PR,
      result: {
        ok: false,
        failureClass: 'unknown',
        error: 'OAuth broker fetch failed: ECONNREFUSED 127.0.0.1:4099',
        stderr: 'broker unavailable',
      },
      failureAt: '2026-06-17T17:30:00.000Z',
      maxRemediationRounds: 2,
      leaseRecoveryEnabled: false,
      statements: quotaStatements(db),
    });

    const row = getRow(db);
    assert.equal(row.review_status, 'pending-upstream');
    assert.equal(row.review_attempts, 0);
    assert.match(row.failure_message, /^\[outage-transient:broker-unavailable\] \[unknown\]/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('main-catchup freezeClass deploy outage is requeued without charging review attempts', () => {
  const { rootDir, db } = setupFixture();
  const oldHqRoot = process.env.HQ_ROOT;
  const hqRoot = path.join(rootDir, 'hq');
  try {
    mkdirSync(path.join(hqRoot, 'main-catchup'), { recursive: true });
    writeFileSync(
      path.join(hqRoot, 'main-catchup', '.state.json'),
      `${JSON.stringify({ currentState: 'frozen', freezeClass: 'privileged-bounce-failed' })}\n`
    );
    process.env.HQ_ROOT = hqRoot;

    settleReviewerAttempt({
      rootDir,
      repoPath: REPO,
      prNumber: PR,
      result: {
        ok: false,
        failureClass: 'unknown',
        error: 'reviewer exited while deploy freeze was active',
      },
      failureAt: '2026-06-17T17:30:00.000Z',
      maxRemediationRounds: 2,
      leaseRecoveryEnabled: false,
      statements: quotaStatements(db),
    });

    const row = getRow(db);
    assert.equal(row.review_status, 'pending-upstream');
    assert.equal(row.review_attempts, 0);
    assert.match(row.failure_message, /^\[outage-transient:deploy-wedge\] \[unknown\]/);
  } finally {
    if (oldHqRoot === undefined) {
      delete process.env.HQ_ROOT;
    } else {
      process.env.HQ_ROOT = oldHqRoot;
    }
    rmSync(rootDir, { recursive: true, force: true });
  }
});
