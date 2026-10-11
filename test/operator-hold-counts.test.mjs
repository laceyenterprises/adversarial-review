import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { OPERATOR_HOLD_LABELS, isOperatorHeld, excludingHeldOpenRows, SQL_COUNT_HELD_OPEN_PRS } from '../src/operator-hold-labels.mjs';
import { SQL_COUNT_OPEN_AWAITING_FIRST_PASS_REVIEW, SQL_COUNT_OPEN_AWAITING_REREVIEW } from '../src/review-state-statements.mjs';
import { evaluateTtmFromDb } from '../src/ttm-tracker.mjs';
import { recoverOrphan } from '../src/ama/orphan-watchdog.mjs';

for (const label of OPERATOR_HOLD_LABELS) {
  test(`${label}: excluded from open, waiting and pressure; reported held`, () => {
    const db = new Database(':memory:');
    try {
      ensureReviewStateSchema(db);
      const insert = db.prepare("INSERT INTO reviewed_prs(repo, pr_number, revision_ref, reviewed_at, reviewer, pr_state, review_status, labels_json) VALUES ('fixture/repo', ?, 'head', '2026-10-01T00:00:00Z', 'fixture', 'open', 'pending', ?)");
      insert.run(1, JSON.stringify([label]));
      insert.run(2, JSON.stringify(['merge-agent-stuck']));
      insert.run(3, JSON.stringify([{ name: label }]));
      assert.equal(db.prepare(SQL_COUNT_HELD_OPEN_PRS).get().n, 2);
      assert.equal(db.prepare(SQL_COUNT_OPEN_AWAITING_FIRST_PASS_REVIEW).get().n, 1);
      assert.equal(db.prepare(excludingHeldOpenRows('SELECT COUNT(*) AS n FROM reviewed_prs WHERE pr_state=\'open\'')).get().n, 1);
      assert.equal(db.prepare(excludingHeldOpenRows('WITH pending AS (SELECT * FROM reviewed_prs) SELECT COUNT(*) AS n FROM pending')).get().n, 1);
      db.prepare("INSERT INTO reviewer_passes(repo, pr_number, attempt_number, pass_kind, reviewer_class, started_at, head_sha, status, gh_comment_id) VALUES ('fixture/repo', ?, 1, 'first-pass', 'fixture', '2026-10-01T00:00:00Z', 'old', 'completed', 'comment')").run(1);
      db.prepare("INSERT INTO reviewer_passes(repo, pr_number, attempt_number, pass_kind, reviewer_class, started_at, head_sha, status, gh_comment_id) VALUES ('fixture/repo', ?, 1, 'first-pass', 'fixture', '2026-10-01T00:00:00Z', 'old', 'completed', 'comment-2')").run(2);
      assert.equal(db.prepare(SQL_COUNT_OPEN_AWAITING_REREVIEW).get().n, 1);
      const ttm = evaluateTtmFromDb(db);
      assert.equal(ttm.budget.openPrCount, 1);
      assert.equal(ttm.budget.held, 2);
    } finally { db.close(); }
  });
  test(`${label}: watchdog never probes, dispatches or pages`, async () => {
    const result = await recoverOrphan({ headSha: 'head', repo: 'fixture/repo', prNumber: 1,
      rootDir: '/fixture/unused', candidate: { prState: 'open', labels: [{ name: label }] },
      result: { amaEnabled: true, reason: 'primary-change-repair-required' },
      fsImpl: { existsSync: () => false, mkdirSync: () => assert.fail('store creation') },
      hasOwnerImpl: () => assert.fail('ownership probe'), pageImpl: () => assert.fail('page'),
      dispatchHammer: () => assert.fail('dispatch') });
    assert.equal(result, null);
  });
}

test('pipeline labels remain countable', () => {
  assert.equal(isOperatorHeld(['merge-agent-stuck', 'adversarial-merge-blocked', 'no-merge', 'no-auto-merge', 'hold']), false);
  assert.equal(isOperatorHeld('invalid json'), false);
});
