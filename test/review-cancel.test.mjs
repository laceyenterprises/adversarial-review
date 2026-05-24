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

test('cancelActiveReview signals persisted reviewer process group without mutating review row', async () => {
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

  const result = await cancelActiveReview({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 149,
    requestedAt: '2026-05-24T15:03:00.000Z',
    requestedBy: 'placey',
    reason: 'duplicate reviewer',
    execFileImpl: async () => ({ stdout: `${new Date('2026-05-24T15:01:00.000Z').toString()}\n` }),
    processKill: (pid, signal) => {
      signals.push({ pid, signal });
      return true;
    },
  });

  assert.equal(result.signalled, true);
  assert.deepEqual(result.target, { kind: 'process-group', id: 2468 });
  assert.deepEqual(signals, [
    { pid: -2468, signal: 0 },
    { pid: -2468, signal: 'SIGTERM' },
  ]);
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

test('cancelActiveReview refuses non-reviewing rows', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  insertReviewingRow(rootDir, { reviewStatus: 'posted' });

  await assert.rejects(
    cancelActiveReview({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 149,
      processKill: () => true,
    }),
    /from status posted/
  );
});

test('sendReviewerSignal reports missing process groups', async () => {
  const result = await sendReviewerSignal({
    pgid: 1357,
    startedAt: '2026-05-24T15:01:00.000Z',
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

test('sendReviewerSignal refuses recycled process groups when identity is unconfirmed', async () => {
  const result = await sendReviewerSignal({
    pgid: 2468,
    startedAt: '2026-05-24T15:01:00.000Z',
    signal: 'SIGKILL',
    processKill: (pid, signal) => {
      if (signal === 0 && pid === -2468) return true;
      throw new Error(`unexpected signal ${signal} ${pid}`);
    },
    execFileImpl: async () => ({ stdout: 'Sat May 24 15:11:00 2026\n' }),
  });

  assert.equal(result.signalled, false);
  assert.deepEqual(result.target, { kind: 'process-group', id: 2468 });
  assert.equal(result.error, 'identity-unconfirmed');
  assert.match(result.identity.reason, /start-time drift/);
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
