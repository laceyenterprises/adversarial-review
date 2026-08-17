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

import { reviewRowInTerminalFailureState } from '../src/pollonce-phases.mjs';

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
  // new commits deserve a new attempt budget.
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
