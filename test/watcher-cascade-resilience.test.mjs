import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import {
  CASCADE_FAILURE_CAP,
  classifyReviewerFailure,
  clearCascadeState,
  readCascadeState,
  recordCascadeFailure,
  shouldBackoffReviewerSpawn,
} from '../src/reviewer-cascade.mjs';

function setupFixture() {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-cascade-'));
  mkdirSync(path.join(rootDir, 'data'), { recursive: true });
  const db = new Database(path.join(rootDir, 'data', 'reviews.db'));
  ensureReviewStateSchema(db);
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'laceyenterprises/adversarial-review',
    195,
    '2026-05-04T07:00:00.000Z',
    'claude',
    'open',
    'pending',
    0
  );
  return { rootDir, db };
}

const stmtMarkCascadeFailed = (db) => db.prepare(
  "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ? WHERE repo = ? AND pr_number = ?"
);
const stmtMarkPendingUpstream = (db) => db.prepare(
  "UPDATE reviewed_prs SET review_status = 'pending-upstream', failed_at = ?, failure_message = ? WHERE repo = ? AND pr_number = ?"
);
const stmtMarkBugFailed = (db) => db.prepare(
  "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
);

test('cascade simulator backs off and does not increment attempt counter', () => {
  const { rootDir, db } = setupFixture();
  try {
    const failedAt = '2026-05-04T07:10:00.000Z';
    const cascadeState = recordCascadeFailure(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 195,
      failedAt,
    });
    stmtMarkCascadeFailed(db).run(
      failedAt,
      'All upstream attempts failed in LiteLLM reviewer lane.',
      'laceyenterprises/adversarial-review',
      195
    );

    const row = db.prepare(
      'SELECT review_status, review_attempts, failed_at FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/adversarial-review', 195);

    assert.equal(classifyReviewerFailure('All upstream attempts failed', 1), 'cascade');
    assert.equal(row.review_status, 'failed');
    assert.equal(row.review_attempts, 0, 'cascade retries must not burn the normal attempt counter');
    assert.equal(row.failed_at, failedAt);
    assert.equal(cascadeState.consecutiveCascadeFailures, 1);
    assert.equal(cascadeState.backoffMinutes, 1);
    assert.equal(cascadeState.nextRetryAfter, '2026-05-04T07:11:00.000Z');
    assert.equal(
      shouldBackoffReviewerSpawn(rootDir, {
        repo: 'laceyenterprises/adversarial-review',
        prNumber: 195,
        now: '2026-05-04T07:10:30.000Z',
      }).shouldBackoff,
      true
    );
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('bug simulator counts normally and does not create cascade state', () => {
  const { rootDir, db } = setupFixture();
  try {
    const failedAt = '2026-05-04T07:12:00.000Z';
    stmtMarkBugFailed(db).run(
      failedAt,
      'spawn reviewer failed: cannot find reviewer binary',
      'laceyenterprises/adversarial-review',
      195
    );

    const row = db.prepare(
      'SELECT review_status, review_attempts, failed_at, failure_message FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/adversarial-review', 195);

    assert.equal(classifyReviewerFailure('cannot find reviewer binary', 127), 'bug');
    assert.equal(row.review_status, 'failed');
    assert.equal(row.review_attempts, 1);
    assert.equal(row.failed_at, failedAt);
    assert.match(row.failure_message, /cannot find/i);
    assert.equal(readCascadeState(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 195,
    }), null);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('recovery clears cascade state after a successful review', () => {
  const { rootDir, db } = setupFixture();
  try {
    recordCascadeFailure(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 195,
      failedAt: '2026-05-04T07:10:00.000Z',
    });
    clearCascadeState(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 195,
    });

    assert.equal(readCascadeState(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 195,
    }), null);
    assert.equal(
      shouldBackoffReviewerSpawn(rootDir, {
        repo: 'laceyenterprises/adversarial-review',
        prNumber: 195,
        now: '2026-05-04T07:12:00.000Z',
      }).shouldBackoff,
      false
    );
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('pending-upstream engages after five consecutive cascades and further retries stay capped', () => {
  const { rootDir, db } = setupFixture();
  try {
    let state;
    for (let i = 0; i < CASCADE_FAILURE_CAP; i += 1) {
      state = recordCascadeFailure(rootDir, {
        repo: 'laceyenterprises/adversarial-review',
        prNumber: 195,
        failedAt: `2026-05-04T07:1${i}:00.000Z`,
      });
    }

    stmtMarkPendingUpstream(db).run(
      '2026-05-04T07:14:00.000Z',
      'Upstream cascade persisted through five retries.',
      'laceyenterprises/adversarial-review',
      195
    );

    const row = db.prepare(
      'SELECT review_status, review_attempts FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/adversarial-review', 195);

    assert.equal(state.consecutiveCascadeFailures, 5);
    assert.equal(state.backoffMinutes, 15);
    assert.equal(row.review_status, 'pending-upstream');
    assert.equal(row.review_attempts, 0);
    assert.equal(
      shouldBackoffReviewerSpawn(rootDir, {
        repo: 'laceyenterprises/adversarial-review',
        prNumber: 195,
        now: '2026-05-04T07:20:00.000Z',
      }).shouldBackoff,
      true
    );

    const capped = recordCascadeFailure(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 195,
      failedAt: '2026-05-04T07:30:00.000Z',
    });
    assert.equal(capped.consecutiveCascadeFailures, CASCADE_FAILURE_CAP, 'pending-upstream retries stay capped');
    assert.equal(capped.backoffMinutes, 15);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
