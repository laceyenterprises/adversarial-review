import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasReviewProbeEvidence,
  reconcileReviewerCommandFailedBeforeRetry,
} from '../src/reviewer-command-failed-recovery.mjs';

const ROW = {
  repo: 'laceyenterprises/adversarial-review',
  pr_number: 407,
  reviewer_session_uuid: 'session-407',
  reviewer_started_at: '2026-06-21T13:00:00.000Z',
};

function makeLog() {
  return {
    lines: [],
    log(message) {
      this.lines.push(String(message));
    },
    warn(message) {
      this.lines.push(String(message));
    },
  };
}

test('reviewer-command-failed recovery requires durable review-probe evidence', async () => {
  assert.equal(hasReviewProbeEvidence({ ...ROW, reviewer_started_at: null }), false);

  let probeCalled = false;
  const log = makeLog();
  const result = await reconcileReviewerCommandFailedBeforeRetry({
    row: { ...ROW, reviewer_started_at: null },
    findPostedReview: async () => {
      probeCalled = true;
      return null;
    },
    markPosted: () => {
      throw new Error('must not mark posted');
    },
    log,
  });

  assert.equal(result.handled, true);
  assert.equal(result.action, 'missing-review-probe-evidence');
  assert.equal(probeCalled, false);
  assert.match(log.lines.join('\n'), /missing reviewer session\/start\/login evidence/);
});

test('reviewer-command-failed recovery requires a resolvable reviewer bot login', async () => {
  assert.equal(
    hasReviewProbeEvidence({ ...ROW, reviewer: 'unknown-reviewer' }, { resolveReviewerLogin: () => null }),
    false,
  );

  const result = await reconcileReviewerCommandFailedBeforeRetry({
    row: { ...ROW, reviewer: 'unknown-reviewer' },
    resolveReviewerLogin: () => null,
    findPostedReview: async () => {
      throw new Error('must not probe without a bot login');
    },
    markPosted: () => {
      throw new Error('must not mark posted');
    },
    log: makeLog(),
  });

  assert.equal(result.handled, true);
  assert.equal(result.action, 'missing-review-probe-evidence');
});

test('reviewer-command-failed recovery marks already-posted reviews posted instead of retrying', async () => {
  const marked = [];
  const settled = [];
  const log = makeLog();

  const result = await reconcileReviewerCommandFailedBeforeRetry({
    row: ROW,
    findPostedReview: async (row, options) => {
      assert.equal(row.reviewer_session_uuid, 'session-407');
      assert.deepEqual(options, { refresh: true });
      return { id: 1234, submitted_at: '2026-06-21T13:02:00.000Z' };
    },
    markPosted: (payload) => marked.push(payload),
    settleRunRecord: (payload) => settled.push(payload),
    resolveReviewerLogin: () => 'codex-reviewer-lacey',
    log,
  });

  assert.equal(result.handled, true);
  assert.equal(result.action, 'marked-posted');
  assert.equal(marked.length, 1);
  assert.equal(marked[0].postedAt, '2026-06-21T13:02:00.000Z');
  assert.equal(settled.length, 1);
  assert.deepEqual(settled[0], {
    sessionUuid: 'session-407',
    state: 'completed',
    settledAt: '2026-06-21T13:02:00.000Z',
    reason: 'posted-review-recovered-before-command-failed-retry',
  });
  assert.match(log.lines.join('\n'), /marked review_status=posted instead of retrying/);
});

test('reviewer-command-failed recovery proceeds to bounded retry only after no posted review is found', async () => {
  const result = await reconcileReviewerCommandFailedBeforeRetry({
    row: ROW,
    findPostedReview: async () => null,
    markPosted: () => {
      throw new Error('must not mark posted');
    },
    log: makeLog(),
  });

  assert.equal(result.handled, false);
  assert.equal(result.action, 'no-posted-review-found');
});

test('reviewer-command-failed recovery skips retry when the GitHub review probe fails', async () => {
  const log = makeLog();
  const result = await reconcileReviewerCommandFailedBeforeRetry({
    row: ROW,
    findPostedReview: async () => {
      throw new Error('reviews unavailable');
    },
    markPosted: () => {
      throw new Error('must not mark posted');
    },
    log,
  });

  assert.equal(result.handled, true);
  assert.equal(result.action, 'review-probe-failed');
  assert.match(log.lines.join('\n'), /reviews unavailable/);
});
