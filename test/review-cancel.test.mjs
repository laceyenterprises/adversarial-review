import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cancelActiveReview,
  parseArgs,
  reviewerCancelHandle,
  sendReviewerSignal,
} from '../src/review-cancel.mjs';
import {
  ensureReviewStateSchema,
  openReviewStateDb,
} from '../src/review-state.mjs';

function insertReviewingRow(rootDir, overrides = {}) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    db.prepare(
      `INSERT INTO reviewed_prs (
        repo, pr_number, reviewed_at, reviewer, pr_state, linear_ticket,
        review_status, review_attempts, reviewer_session_uuid, reviewer_pgid,
        reviewer_started_at, reviewer_head_sha
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      overrides.repo || 'laceyenterprises/adversarial-review',
      overrides.prNumber || 149,
      overrides.reviewedAt || '2026-05-24T15:00:00.000Z',
      overrides.reviewer || 'codex',
      overrides.prState || 'open',
      overrides.linearTicket || 'LAC-149',
      overrides.reviewStatus || 'reviewing',
      overrides.reviewAttempts ?? 2,
      overrides.reviewerSessionUuid || 'session-149',
      overrides.reviewerPgid ?? 2468,
      overrides.reviewerStartedAt || '2026-05-24T15:01:00.000Z',
      overrides.reviewerHeadSha || 'abc123'
    );
  } finally {
    db.close();
  }
}

test('cancelActiveReview signals persisted reviewer process group without mutating review row', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  insertReviewingRow(rootDir);
  const db = openReviewStateDb(rootDir);
  let before;
  try {
    ensureReviewStateSchema(db);
    before = db.prepare('SELECT * FROM reviewed_prs WHERE pr_number = 149').get();
  } finally {
    db.close();
  }
  const signals = [];

  const result = cancelActiveReview({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 149,
    requestedAt: '2026-05-24T15:03:00.000Z',
    requestedBy: 'placey',
    reason: 'duplicate reviewer',
    processKill: (pid, signal) => {
      signals.push({ pid, signal });
      return true;
    },
  });

  assert.equal(result.signalled, true);
  assert.deepEqual(result.target, { kind: 'process-group', id: 2468 });
  assert.deepEqual(signals, [{ pid: -2468, signal: 'SIGTERM' }]);
  assert.ok(result.receiptPath.includes('/data/review-cancellations/'));
  assert.ok(existsSync(result.receiptPath));
  const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
  assert.equal(receipt.kind, 'adversarial-review-active-review-cancellation');
  assert.equal(receipt.review.status, 'reviewing');
  assert.equal(receipt.review.reviewerPgid, 2468);

  const afterDb = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(afterDb);
    const after = afterDb.prepare('SELECT * FROM reviewed_prs WHERE pr_number = 149').get();
    assert.deepEqual(after, before);
  } finally {
    afterDb.close();
  }
});

test('cancelActiveReview refuses non-reviewing rows', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  insertReviewingRow(rootDir, { reviewStatus: 'posted' });

  assert.throws(
    () => cancelActiveReview({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 149,
      processKill: () => true,
    }),
    /from status posted/
  );
});

test('sendReviewerSignal reports missing process groups', () => {
  const result = sendReviewerSignal({
    pgid: 1357,
    signal: 'SIGTERM',
    processKill: () => {
      const err = new Error('gone');
      err.code = 'ESRCH';
      throw err;
    },
  });

  assert.equal(result.signalled, false);
  assert.deepEqual(result.target, { kind: 'process-group', id: 1357 });
  assert.equal(result.error, 'process-group-not-found');
});

test('reviewerCancelHandle and parseArgs expose reviewer cancel handle', () => {
  assert.equal(reviewerCancelHandle({ reviewer_pgid: '9753' }), 9753);
  assert.equal(reviewerCancelHandle({ reviewer_pgid: 0 }), null);
  assert.deepEqual(parseArgs([
    '--repo=laceyenterprises/adversarial-review',
    '--pr',
    '149',
    '--signal=SIGKILL',
    'duplicate',
    'review',
  ]), {
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 149,
    signal: 'SIGKILL',
    reason: 'duplicate review',
  });
});
