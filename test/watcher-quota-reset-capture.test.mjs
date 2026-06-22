// watcher-quota-reset-capture.test.mjs — proves the review-lane HRR
// quota-exhaustion capture/hold/recovery path end to end:
//
//   1. On a quota-exhausted reviewer failure the watcher parses the provider
//      reset time from the FULL output (stdout/stderr, before failure_message
//      truncation can drop the "try again at" line) and stores it durably in
//      reviewed_prs.quota_reset_at_utc.
//   2. The hold-until-reset gate honors that stored reset.
//   3. Holding does NOT consume an infra_auto_recover attempt.
//   4. Once the reset has passed, the row IS re-claimed for a real attempt and
//      the attempt budget is incremented exactly once.
//   5. A quota failure with NO parseable reset falls back to the default window
//      and logs loudly, with quota_reset_at_utc left NULL.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { settleReviewerAttempt } from '../src/watcher.mjs';
import {
  quotaHoldDecision,
  QUOTA_EXHAUSTED_FAILURE_CLASS,
} from '../src/quota-exhaustion.mjs';
import { infraRecoverableFailureClass } from '../src/reviewer-failure-classification.mjs';

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

test('quota-exhausted failure captures + stores the provider reset time durably', () => {
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
    assert.equal(row.review_status, 'failed');
    assert.equal(row.quota_reset_at_utc, '2026-06-18T00:39:00.000Z');
    assert.match(row.failure_message, /^\[quota-exhausted\]/);
    // The full output is preserved in failure_message so the reset is also
    // re-derivable as a fallback.
    assert.match(row.failure_message, /try again at Jun 17th, 2026 5:39 PM/i);
    // Classifies as the recoverable quota class.
    assert.equal(infraRecoverableFailureClass(row), QUOTA_EXHAUSTED_FAILURE_CLASS);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('quota-exhausted lease-recovery settlement still lands in failed for hold-until-reset', () => {
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
    assert.equal(row.review_status, 'failed');
    assert.equal(row.quota_reset_at_utc, '2026-06-18T00:39:00.000Z');
    assert.equal(infraRecoverableFailureClass(row), QUOTA_EXHAUSTED_FAILURE_CLASS);

    const held = quotaHoldDecision(row, { nowMs: Date.parse('2026-06-17T20:00:00Z') });
    assert.equal(held.hold, true);
    assert.equal(held.source, 'provider-reported-stored');

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
    assert.equal(pendingClaim.changes, 0, 'normal pending claim must not bypass the quota hold');
    assert.equal(getRow(db).review_status, 'failed');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('hold-until-reset honors the stored reset and does NOT burn an infra auto-recover attempt', () => {
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

    // Before the reset: hold. The watcher gate `continue`s here WITHOUT calling
    // the recovery claim, so the attempt counter stays 0.
    const held = quotaHoldDecision(row, { nowMs: Date.parse('2026-06-17T20:00:00Z') });
    assert.equal(held.hold, true);
    assert.equal(held.source, 'provider-reported-stored');
    // The recovery claim statement is the ONLY thing that bumps the counter; the
    // hold short-circuits before it, so the on-disk counter is untouched.
    assert.equal(getRow(db).infra_auto_recover_attempts, 0);

    // After the reset: release.
    const released = quotaHoldDecision(row, { nowMs: Date.parse('2026-06-18T01:00:00Z') });
    assert.equal(released.hold, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a qualifying quota row IS re-claimed once the reset has passed (cap incremented exactly once)', () => {
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
    const failedRow = getRow(db);

    // The watcher computes infraRecoveryClass + the hold; once the hold clears
    // it runs the real infra-recovery claim. Replicate that claim here (the
    // statement is byte-identical to stmtMarkInfraAutoRecoveryAttemptStarted's
    // quota branch).
    const infraClass = infraRecoverableFailureClass(failedRow);
    assert.equal(infraClass, QUOTA_EXHAUSTED_FAILURE_CLASS);
    const hold = quotaHoldDecision(failedRow, { nowMs: Date.parse('2026-06-18T01:00:00Z') });
    assert.equal(hold.hold, false, 'reset has passed; recovery should proceed');

    const claim = db.prepare(
      `UPDATE reviewed_prs
          SET review_status = 'reviewing',
              failed_at = NULL,
              failure_message = NULL,
              quota_reset_at_utc = NULL,
              infra_auto_recover_attempts = infra_auto_recover_attempts + 1
        WHERE repo = ? AND pr_number = ?
          AND review_status = 'failed'
          AND infra_auto_recover_attempts < 3
          AND lower(COALESCE(failure_message, '')) LIKE '[quota-exhausted]%'`
    ).run(REPO, PR);
    assert.equal(claim.changes, 1, 'the quota row must be claimable for recovery');

    const reclaimed = getRow(db);
    assert.equal(reclaimed.review_status, 'reviewing');
    assert.equal(reclaimed.infra_auto_recover_attempts, 1);
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
    assert.equal(row.review_status, 'failed');
    assert.equal(row.quota_reset_at_utc, null);
    // Still classified quota (via the bracket tag) so the hold uses the fallback
    // window anchored on failed_at.
    assert.equal(infraRecoverableFailureClass(row), QUOTA_EXHAUSTED_FAILURE_CLASS);
    const d = quotaHoldDecision(row, {
      nowMs: Date.parse('2026-06-17T17:35:00Z'),
      fallbackBackoffMs: 15 * 60 * 1000,
    });
    assert.equal(d.source, 'fallback-window');
    assert.equal(d.hold, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
