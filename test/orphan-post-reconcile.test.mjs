import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { reconcilePostedFailedOrphans } from '../src/orphan-post-reconcile.mjs';

function fixture({
  attempts = 4,
  reviewerStartedAt = '2026-09-20T06:20:00Z',
  passStatus = 'running',
} = {}) {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  db.prepare(
    `INSERT INTO reviewed_prs
      (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
       review_attempts,
       last_attempted_at, reviewer_started_at, reviewer_session_uuid,
       reviewer_pgid, reviewer_head_sha, infra_auto_recover_attempts,
       failed_at, failure_message)
     VALUES ('laceyenterprises/adversarial-review', 1078, '2026-09-20T06:20:00Z',
       'claude', 'open', 'failed-orphan', ?, '2026-09-20T06:20:00Z',
       ?, 'session-1078', 98788, 'head-1078', ?,
       '2026-09-20T06:30:00Z', 'Operator must inspect before retrying.')`
  ).run(attempts, reviewerStartedAt, attempts);
  db.prepare(
    `INSERT INTO reviewer_passes
      (repo, pr_number, attempt_number, reviewer_class, reviewer_model,
       pass_kind, started_at, status, metadata_json, head_sha)
     VALUES ('laceyenterprises/adversarial-review', 1078, ?, 'claude-code',
       'claude', 'first-pass', '2026-09-20T06:20:00Z', ?, '{}', 'head-1078')`
  ).run(attempts, passStatus);
  return db;
}

function queueStub(calls = []) {
  return (args) => {
    calls.push(args);
    return { queued: true, jobPath: '/tmp/follow-up-job.json' };
  };
}

const POSTED_REVIEW = {
  id: 551078,
  user: { login: 'lacey-claude-reviewer[bot]' },
  state: 'CHANGES_REQUESTED',
  submitted_at: '2026-09-20T06:29:34Z',
  commit_id: 'head-1078',
  body: '## Verdict\n\nRequest changes',
};

test('dry run reports a posted orphan without mutating either ledger', async () => {
  const db = fixture();
  const result = await reconcilePostedFailedOrphans({
    db,
    listReviews: async () => [POSTED_REVIEW],
  });
  assert.equal(result.wouldReconcile, 1);
  assert.deepEqual(result.firstPassQueue, { before: 1, after: 1 });
  assert.equal(db.prepare('SELECT review_status FROM reviewed_prs').get().review_status, 'failed-orphan');
  assert.equal(db.prepare('SELECT gh_comment_id FROM reviewer_passes').get().gh_comment_id, null);
  db.close();
});

test('apply reconciles a cap-exhausted posted orphan and removes it from first-pass depth', async () => {
  const db = fixture({ attempts: 4 });
  const queueCalls = [];
  const result = await reconcilePostedFailedOrphans({
    db,
    apply: true,
    listReviews: async () => [POSTED_REVIEW],
    queueFollowUpForRecoveredPostedReviewImpl: queueStub(queueCalls),
  });
  assert.equal(result.reconciled, 1);
  assert.equal(result.reconciledRowOnly, 0);
  assert.equal(queueCalls.length, 1);
  assert.equal(queueCalls[0].row.body_md, POSTED_REVIEW.body);
  assert.equal(queueCalls[0].row.head_sha, 'head-1078');
  assert.equal(result.results[0].followUp.queued, true);
  assert.deepEqual(result.firstPassQueue, { before: 1, after: 0 });
  const row = db.prepare(
    'SELECT review_status, posted_at, failure_message, infra_auto_recover_attempts FROM reviewed_prs'
  ).get();
  assert.deepEqual(row, {
    review_status: 'posted',
    posted_at: POSTED_REVIEW.submitted_at,
    failure_message: null,
    infra_auto_recover_attempts: 0,
  });
  const pass = db.prepare(
    'SELECT status, verdict, gh_comment_id, body_md, ended_at FROM reviewer_passes'
  ).get();
  assert.deepEqual(pass, {
    status: 'completed',
    verdict: 'request-changes',
    gh_comment_id: String(POSTED_REVIEW.id),
    body_md: POSTED_REVIEW.body,
    ended_at: POSTED_REVIEW.submitted_at,
  });
  db.close();
});

test('apply reconciles a null-start null-pgid orphan using last_attempted_at', async () => {
  const db = fixture({ attempts: 4, reviewerStartedAt: null });
  db.prepare('UPDATE reviewed_prs SET reviewer_pgid = NULL, failure_message = ?')
    .run('Reviewer session was claimed but its pgid was never persisted.');
  const result = await reconcilePostedFailedOrphans({
    db,
    apply: true,
    listReviews: async () => [POSTED_REVIEW],
    queueFollowUpForRecoveredPostedReviewImpl: queueStub(),
  });
  assert.equal(result.scanned, 1);
  assert.equal(result.reconciled, 1);
  assert.deepEqual(result.firstPassQueue, { before: 1, after: 0 });
  assert.equal(db.prepare('SELECT review_status FROM reviewed_prs').get().review_status, 'posted');
  db.close();
});

test('apply ignores terminal PR rows', async () => {
  const db = fixture();
  db.prepare("UPDATE reviewed_prs SET pr_state = 'closed'").run();
  const result = await reconcilePostedFailedOrphans({
    db,
    apply: true,
    listReviews: async () => [POSTED_REVIEW],
  });
  assert.equal(result.scanned, 0);
  assert.equal(result.reconciled, 0);
  assert.equal(db.prepare('SELECT review_status FROM reviewed_prs').get().review_status, 'failed-orphan');
  db.close();
});

test('apply skips corrupt reviewer start timestamps instead of matching stale reviews', async () => {
  const db = fixture();
  db.prepare("UPDATE reviewed_prs SET reviewer_started_at = 'not-a-date'").run();
  const result = await reconcilePostedFailedOrphans({
    db,
    apply: true,
    listReviews: async () => [POSTED_REVIEW],
  });
  assert.equal(db.prepare('SELECT review_status FROM reviewed_prs').get().review_status, 'failed-orphan');
  assert.equal(result.results[0].reason, 'no-posted-review');
  db.close();
});

test('apply skips reviews posted for a different head', async () => {
  const db = fixture();
  const result = await reconcilePostedFailedOrphans({
    db,
    apply: true,
    listReviews: async () => [{ ...POSTED_REVIEW, commit_id: 'stale-head' }],
  });
  assert.equal(result.results[0].reason, 'no-posted-review');
  assert.equal(db.prepare('SELECT review_status FROM reviewed_prs').get().review_status, 'failed-orphan');
  db.close();
});

test('apply leaves an orphan unchanged when GitHub has no matching reviewer post', async () => {
  const db = fixture();
  const result = await reconcilePostedFailedOrphans({
    db,
    apply: true,
    listReviews: async () => [],
    queueFollowUpForRecoveredPostedReviewImpl: queueStub(),
  });
  assert.equal(result.reconciled, 0);
  assert.equal(result.results[0].reason, 'no-posted-review');
  assert.equal(db.prepare('SELECT review_status FROM reviewed_prs').get().review_status, 'failed-orphan');
  db.close();
});

test('apply links a reaped failed pass and removes it from first-pass depth', async () => {
  const db = fixture();
  db.prepare("UPDATE reviewer_passes SET status = 'failed', ended_at = '2026-09-20T06:25:00Z'").run();
  const queueCalls = [];
  const result = await reconcilePostedFailedOrphans({
    db,
    apply: true,
    listReviews: async () => [POSTED_REVIEW],
    queueFollowUpForRecoveredPostedReviewImpl: queueStub(queueCalls),
  });
  assert.equal(result.reconciled, 1);
  assert.equal(result.reconciledRowOnly, 0);
  assert.equal(result.results[0].action, 'reconciled');
  assert.equal(queueCalls.length, 1);
  assert.equal(db.prepare('SELECT review_status FROM reviewed_prs').get().review_status, 'posted');
  const pass = db.prepare('SELECT status, ended_at, gh_comment_id, body_md FROM reviewer_passes').get();
  assert.deepEqual(pass, {
    status: 'completed',
    ended_at: POSTED_REVIEW.submitted_at,
    gh_comment_id: String(POSTED_REVIEW.id),
    body_md: POSTED_REVIEW.body,
  });
  assert.deepEqual(result.firstPassQueue, { before: 1, after: 0 });
  db.close();
});

test('apply accepts a review artifact already linked to another pass for the same PR', async () => {
  const db = fixture();
  db.prepare(
    `UPDATE reviewer_passes SET gh_comment_id = ?, status = 'completed'
      WHERE repo = ? AND pr_number = ?`
  ).run(String(POSTED_REVIEW.id), 'laceyenterprises/adversarial-review', 1078);
  const result = await reconcilePostedFailedOrphans({
    db,
    apply: true,
    listReviews: async () => [POSTED_REVIEW],
    queueFollowUpForRecoveredPostedReviewImpl: queueStub(),
  });
  assert.equal(result.reconciled, 1);
  assert.equal(db.prepare('SELECT review_status FROM reviewed_prs').get().review_status, 'posted');
  db.close();
});

test('apply completes a reaped failed pass and queues follow-up recovery', async () => {
  const db = fixture({ attempts: 4, passStatus: 'failed' });
  const queueCalls = [];
  const result = await reconcilePostedFailedOrphans({
    db,
    apply: true,
    listReviews: async () => [POSTED_REVIEW],
    queueFollowUpForRecoveredPostedReviewImpl: queueStub(queueCalls),
  });
  assert.equal(result.reconciled, 1);
  assert.equal(result.reconciledRowOnly, 0);
  assert.equal(result.results[0].action, 'reconciled');
  assert.equal(queueCalls.length, 1);
  assert.equal(result.results[0].followUp.queued, true);
  const pass = db.prepare(
    'SELECT status, verdict, gh_comment_id, body_md FROM reviewer_passes'
  ).get();
  assert.deepEqual(pass, {
    status: 'completed',
    verdict: 'request-changes',
    gh_comment_id: String(POSTED_REVIEW.id),
    body_md: POSTED_REVIEW.body,
  });
  assert.deepEqual(result.firstPassQueue, { before: 1, after: 0 });
  db.close();
});

test('apply reports posted-no-artifact when no reviewer pass identity exists', async () => {
  const db = fixture({ attempts: 4 });
  db.prepare('DELETE FROM reviewer_passes').run();
  const result = await reconcilePostedFailedOrphans({
    db,
    apply: true,
    listReviews: async () => [POSTED_REVIEW],
    queueFollowUpForRecoveredPostedReviewImpl: queueStub(),
  });
  assert.equal(result.reconciled, 0);
  assert.equal(result.reconciledRowOnly, 0);
  assert.equal(result.results[0].action, 'posted-no-artifact');
  assert.equal(db.prepare('SELECT review_status FROM reviewed_prs').get().review_status, 'posted');
  db.close();
});
