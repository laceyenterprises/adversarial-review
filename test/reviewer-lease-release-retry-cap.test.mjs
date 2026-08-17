/** A lease-released reviewer failure must still be capped.
 *
 * `settleReviewerFailure` picks between two terminal statements, and they differ
 * in exactly the field every retry cap keys on:
 *
 *   stmtMarkFailed          SET review_status = 'failed' , review_attempts += 1
 *   stmtReleaseReviewLease  SET review_status = 'pending', review_attempts += 1
 *
 * Both set failed_at and failure_message. Only the status differs. Lease recovery
 * (REVIEWER_LEASE_RECOVERY_ENABLED) selects the second one, so with it enabled a
 * terminal failure lands as 'pending' and every gate in pollonce-phases that
 * required review_status === 'failed' silently stopped applying. review_attempts
 * kept incrementing while nothing read it.
 *
 * agent-os#5486 is the worked example: 138 consecutive reviewer spawns, all on
 * the same head dbc9e5b3b1bf, all failure-class=unknown, zero verdicts ever
 * posted, and zero "retry cap exhausted" lines despite REVIEW_UNKNOWN_FAILURE_MAX_RETRIES = 3.
 * A crash loop that could never converge, retried forever.
 *
 * The head check keeps the fix narrow. A lease-released row whose head has MOVED
 * is a legitimate fresh review and must not inherit the previous attempt count —
 * otherwise a genuinely new commit would be refused because an older commit
 * failed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  finalizePendingTerminalFailureState,
  reviewRowInTerminalFailureState,
} from '../src/pollonce-phases.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import {
  prepareFinalizePendingTerminalFailure,
  prepareMarkAttemptStarted,
} from '../src/review-state-statements.mjs';

const HEAD = 'dbc9e5b3b1bf';
const OTHER_HEAD = 'a1b2c3d4e5f6';

function row(overrides = {}) {
  return {
    review_status: 'pending',
    failed_at: '2026-08-17T14:00:00Z',
    failure_message: '[unknown] reviewer died',
    review_attempts: 3,
    reviewer_head_sha: HEAD,
    ...overrides,
  };
}

test('a lease-released failure on the SAME head counts as a terminal failure', () => {
  // The agent-os#5486 shape: status 'pending' because the lease was released,
  // but failed_at set, attempts accrued, head unchanged.
  assert.equal(reviewRowInTerminalFailureState(row(), HEAD), true);
});

test('an explicitly failed row still counts, lease recovery or not', () => {
  assert.equal(reviewRowInTerminalFailureState(row({ review_status: 'failed' }), HEAD), true);
  // markFailed rows are terminal regardless of head bookkeeping.
  assert.equal(
    reviewRowInTerminalFailureState(row({ review_status: 'failed', reviewer_head_sha: null }), HEAD),
    true
  );
});

test('a lease-released row whose head MOVED is a fresh review, not a crash loop', () => {
  // This is the property that keeps the cap from refusing legitimate new work:
  // new commits are claimed through the generic pending CAS, which resets the
  // inherited same-head failure budget when the stored failed head differs.
  assert.equal(reviewRowInTerminalFailureState(row({ reviewer_head_sha: OTHER_HEAD }), HEAD), false);
});

test('a genuinely pending row with no failure history is not a failure state', () => {
  assert.equal(
    reviewRowInTerminalFailureState(row({ failed_at: null, review_attempts: 0 }), HEAD),
    false
  );
});

test('a pending row with failed_at but zero attempts is not a failure state', () => {
  assert.equal(reviewRowInTerminalFailureState(row({ review_attempts: 0 }), HEAD), false);
});

test('missing head information does not manufacture a failure state', () => {
  // Fail OPEN here rather than closed: without a head we cannot prove the row is
  // stuck on the same input, and wrongly capping would strand a reviewable PR.
  assert.equal(reviewRowInTerminalFailureState(row({ reviewer_head_sha: null }), HEAD), false);
  assert.equal(reviewRowInTerminalFailureState(row(), null), false);
});

test('other statuses and nullish rows are not failure states', () => {
  assert.equal(reviewRowInTerminalFailureState(row({ review_status: 'reviewing' }), HEAD), false);
  assert.equal(reviewRowInTerminalFailureState(row({ review_status: 'reviewed' }), HEAD), false);
  assert.equal(reviewRowInTerminalFailureState(null, HEAD), false);
  assert.equal(reviewRowInTerminalFailureState(undefined, HEAD), false);
});

test('cap exhaustion finalizes a lease-released pending failure without burning another attempt', () => {
  const calls = [];
  const markTerminalPendingFailure = {
    run(...args) {
      calls.push(args);
      return { changes: 1 };
    },
  };

  assert.equal(
    finalizePendingTerminalFailureState(row({
      repo: 'laceyenterprises/adversarial-review',
      pr_number: 851,
      review_attempts: 3,
    }), { markTerminalPendingFailure }),
    1
  );
  assert.deepEqual(calls, [[
    'laceyenterprises/adversarial-review',
    851,
    '2026-08-17T14:00:00Z',
    '[unknown] reviewer died',
    HEAD,
  ]]);
});

test('infra cap exhaustion finalizes a lease-released pending failure', () => {
  const calls = [];
  const markTerminalPendingFailure = {
    run(...args) {
      calls.push(args);
      return { changes: 1 };
    },
  };

  assert.equal(
    finalizePendingTerminalFailureState(row({
      repo: 'laceyenterprises/adversarial-review',
      pr_number: 851,
      failure_message: '[oauth-broken] reviewer spawn failed',
      infra_auto_recover_attempts: 3,
    }), { markTerminalPendingFailure }),
    1
  );
  assert.deepEqual(calls, [[
    'laceyenterprises/adversarial-review',
    851,
    '2026-08-17T14:00:00Z',
    '[oauth-broken] reviewer spawn failed',
    HEAD,
  ]]);
});

test('cap exhaustion finalization ignores already-failed and unproven rows', () => {
  const markTerminalPendingFailure = {
    run() {
      assert.fail('finalization statement should not run');
    },
  };

  assert.equal(
    finalizePendingTerminalFailureState(row({
      repo: 'laceyenterprises/adversarial-review',
      pr_number: 851,
      review_status: 'failed',
    }), { markTerminalPendingFailure }),
    0
  );
  assert.equal(
    finalizePendingTerminalFailureState(row({
      repo: 'laceyenterprises/adversarial-review',
      pr_number: 851,
      reviewer_head_sha: null,
    }), { markTerminalPendingFailure }),
    0
  );
  assert.equal(finalizePendingTerminalFailureState(null, { markTerminalPendingFailure }), 0);
});

test('cap exhaustion finalization executes the production SQLite statement', () => {
  const db = new Database(':memory:');
  try {
    ensureReviewStateSchema(db);
    db.prepare(
      `INSERT INTO reviewed_prs (
        repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
        review_attempts, failed_at, failure_message, reviewer_head_sha,
        reviewer_lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'laceyenterprises/adversarial-review',
      851,
      '2026-08-17T14:00:00Z',
      'gemini',
      'open',
      'pending',
      3,
      '2026-08-17T14:00:00Z',
      '[unknown] reviewer died',
      HEAD,
      '2026-08-17T14:20:00Z',
    );

    const changes = finalizePendingTerminalFailureState(row({
      repo: 'laceyenterprises/adversarial-review',
      pr_number: 851,
      review_attempts: 3,
    }), { markTerminalPendingFailure: prepareFinalizePendingTerminalFailure(db) });

    assert.equal(changes, 1);
    assert.deepEqual(
      db.prepare(
        'SELECT review_status, review_attempts, failed_at, failure_message, reviewer_head_sha, reviewer_lease_expires_at FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
      ).get('laceyenterprises/adversarial-review', 851),
      {
        review_status: 'failed',
        review_attempts: 3,
        failed_at: '2026-08-17T14:00:00Z',
        failure_message: '[unknown] reviewer died',
        reviewer_head_sha: HEAD,
        reviewer_lease_expires_at: null,
      },
    );
  } finally {
    db.close();
  }
});

test('fresh-head generic pending claim resets inherited failure attempts', () => {
  const db = new Database(':memory:');
  try {
    ensureReviewStateSchema(db);
    db.prepare(
      `INSERT INTO reviewed_prs (
        repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
        review_attempts, failed_at, failure_message, reviewer_head_sha
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'laceyenterprises/adversarial-review',
      851,
      '2026-08-17T14:00:00Z',
      'gemini',
      'open',
      'pending',
      3,
      '2026-08-17T14:00:00Z',
      '[unknown] reviewer died',
      HEAD,
    );

    assert.equal(prepareMarkAttemptStarted(db).run(
      '2026-08-17T15:00:00Z',
      'session-fresh',
      OTHER_HEAD,
      1200000,
      '2026-08-17T15:20:00Z',
      OTHER_HEAD,
      'laceyenterprises/adversarial-review',
      851,
    ).changes, 1);

    assert.deepEqual(
      db.prepare('SELECT review_status, review_attempts, failed_at, failure_message, reviewer_head_sha FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
        .get('laceyenterprises/adversarial-review', 851),
      {
        review_status: 'reviewing',
        review_attempts: 0,
        failed_at: null,
        failure_message: null,
        reviewer_head_sha: OTHER_HEAD,
      },
    );
  } finally {
    db.close();
  }
});
