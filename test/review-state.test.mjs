import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ensureReviewStateSchema,
  openReviewStateDb,
  requestReviewRereview,
} from '../src/review-state.mjs';

function insertReviewRow(rootDir, overrides = {}) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    db.prepare(
      'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, linear_ticket, review_status, review_attempts, last_attempted_at, posted_at, failed_at, failure_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      overrides.repo || 'laceyenterprises/adversarial-review',
      overrides.prNumber || 10,
      overrides.reviewedAt || '2026-04-24T12:00:00.000Z',
      overrides.reviewer || 'claude',
      overrides.prState || 'open',
      overrides.linearTicket || 'LAC-210',
      overrides.reviewStatus || 'posted',
      overrides.reviewAttempts ?? 1,
      overrides.lastAttemptedAt ?? '2026-04-24T12:05:00.000Z',
      overrides.postedAt ?? '2026-04-24T12:06:00.000Z',
      overrides.failedAt ?? null,
      overrides.failureMessage ?? null
    );
  } finally {
    db.close();
  }
}

test('openReviewStateDb applies a busy timeout and shared schema adds rereview columns', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const db = openReviewStateDb(rootDir);

  try {
    ensureReviewStateSchema(db);
    assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);

    const columns = db.prepare('PRAGMA table_info(reviewed_prs)').all().map((column) => column.name);
    assert.ok(columns.includes('rereview_requested_at'));
    assert.ok(columns.includes('rereview_reason'));
  } finally {
    db.close();
  }
});

test('requestReviewRereview preserves attempt history and records rereview metadata separately from failures', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  insertReviewRow(rootDir);

  const result = requestReviewRereview({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 10,
    requestedAt: '2026-04-24T12:10:00.000Z',
    reason: 'Remediation landed and is ready for another adversarial pass.',
  });

  assert.equal(result.triggered, true);
  assert.equal(result.status, 'pending');
  assert.equal(result.reviewRow.review_status, 'pending');
  assert.equal(result.reviewRow.review_attempts, 1);
  assert.equal(result.reviewRow.last_attempted_at, '2026-04-24T12:05:00.000Z');
  assert.equal(result.reviewRow.failure_message, null);
  assert.equal(result.reviewRow.rereview_requested_at, '2026-04-24T12:10:00.000Z');
  assert.equal(result.reviewRow.rereview_reason, 'Remediation landed and is ready for another adversarial pass.');
});
