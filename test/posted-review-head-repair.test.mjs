import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { requeuePostedReviewWithoutHead } from '../src/posted-review-head-repair.mjs';

const repo = 'example/review-head';
const head = 'a'.repeat(40);

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T01:00:00.000Z') });
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  t.after(() => db.close());
  db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer,
    review_status, revision_ref, review_attempts, infra_auto_recover_attempts,
    review_population_retry_attempts, last_attempted_at, posted_at, rereview_reason)
    VALUES (?, 1, '2026-01-01T00:00:00.000Z', 'claude', 'posted', ?, 4, 2, 1,
      '2026-01-01T00:01:00.000Z', '2026-01-01T00:06:00.000Z', ?)`)
    .run(repo, head, `system-orphan-head-review:${head}`);
  const logs = [];
  return { db, logs,
    row: () => db.prepare('SELECT * FROM reviewed_prs').get(),
    repair: (headSha = head) => requeuePostedReviewWithoutHead({ db, repo, prNumber: 1,
      headSha, logger: { warn: message => logs.push(message) } }),
  };
}

for (const empty of [null, '', ' ']) {
  test(`REVIEWHEAD-01: legacy posted head ${JSON.stringify(empty)} requeues once without budget changes`, t => {
    const { db, row, logs, repair } = fixture(t);
    db.prepare('UPDATE reviewed_prs SET reviewer_head_sha = ?').run(empty);
    const before = row();
    assert.equal(repair(), true);
    const after = row();
    assert.equal(after.review_status, 'pending');
    assert.equal(after.revision_ref, head);
    assert.equal(after.reviewer_head_sha, null);
    assert.equal(after.posted_at, null);
    assert.equal(after.rereview_requested_at, new Date().toISOString());
    assert.equal(after.rereview_reason, `system-missing-reviewed-head:${head}`);
    for (const field of ['review_attempts', 'infra_auto_recover_attempts',
      'review_population_retry_attempts', 'review_population_retry_last_at',
      'review_population_retry_head_sha', 'last_attempted_at', 'reviewed_at']) {
      assert.equal(after[field], before[field], field);
    }
    t.mock.timers.tick(60_000);
    assert.equal(repair(), false);
    assert.deepEqual(row(), after);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /posted-review-missing-head-requeued/);
  });
}

for (const kind of ['normal-posted', 'moved-head', 'missing-live-head', 'reviewing', 'merged', 'closed']) {
  test(`REVIEWHEAD-01: repair leaves ${kind} rows intact`, t => {
    const { db, row, logs, repair } = fixture(t);
    if (kind === 'normal-posted') db.prepare('UPDATE reviewed_prs SET reviewer_head_sha = ?').run(head);
    if (kind === 'reviewing') db.prepare("UPDATE reviewed_prs SET review_status = 'reviewing'").run();
    if (['merged', 'closed'].includes(kind)) db.prepare('UPDATE reviewed_prs SET pr_state = ?').run(kind);
    const before = row();
    assert.equal(repair(kind === 'moved-head' ? 'b'.repeat(40) : kind === 'missing-live-head' ? null : head), false);
    assert.deepEqual(row(), before);
    assert.deepEqual(logs, []);
  });
}
