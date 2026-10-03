import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureReviewStateSchema, requestReviewRereview } from '../src/review-state.mjs';
import { reviewRowInTerminalFailureState } from '../src/pollonce-phases.mjs';
import { reviewerPostFailureExitCode } from '../src/reviewer-outcomes.mjs';
import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';
import { settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';
import { parkExhaustedReview } from '../src/review-retry-exhaustion.mjs';
import { readNoProgressLane } from '../src/watcher-no-progress-lane.mjs';
import { prepareMarkAttemptStarted, prepareReleaseReviewerClaim } from '../src/review-state-statements.mjs';

const repo = 'fixture/reviewstall';
function fixture(t) {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewstall-'));
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO reviewed_prs
    (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
     review_attempts, reviewer_head_sha, revision_ref, failed_at, failure_message)
    VALUES (?, 7576, '2026-10-03', 'codex', 'open', 'failed', 3, 'head-A', 'head-A',
            '2026-10-03', 'Command failed with code 1')`).run(repo);
  const row = () => db.prepare('SELECT * FROM reviewed_prs').get();
  return { db, rootDir, row };
}

test('#7576 replay: new head resets failed review and archives all evidence atomically', (t) => {
  const { db, rootDir, row } = fixture(t);
  const before = row();
  assert.equal(reviewRowInTerminalFailureState(before, 'head-B'), false);
  const result = requestReviewRereview({
    db, rootDir, repo, prNumber: 7576, targetRevisionRef: 'head-B',
    expectedFailedHead: 'head-A', reason: 'Failed review superseded by a new PR head.',
  });
  assert.equal(result.triggered, true);
  assert.equal(row().review_status, 'pending');
  assert.equal(row().review_attempts, 0);
  assert.equal(row().revision_ref, 'head-B');
  assert.equal(row().failure_message, null);
  assert.deepEqual(JSON.parse(db.prepare('SELECT row_json FROM review_failure_archive').get().row_json), before);
  const claimed = prepareMarkAttemptStarted(db).run(
    '2026-10-03', 'new-session', 'head-B', 'head-B', 1000,
    '2026-10-04', 'head-B', repo, 7576,
  );
  assert.equal(claimed.changes, 1);
});

test('same-head failed row remains terminal at its cap; a raced reset cannot clobber a claim', (t) => {
  const { db, rootDir, row } = fixture(t);
  assert.equal(reviewRowInTerminalFailureState(row(), 'head-A'), true);
  assert.equal(row().review_attempts, 3);
  db.prepare("UPDATE reviewed_prs SET review_status = 'reviewing'").run();
  const result = requestReviewRereview({
    db, rootDir, repo, prNumber: 7576, targetRevisionRef: 'head-B',
    expectedFailedHead: 'head-A',
  });
  assert.equal(result.triggered, false);
  assert.equal(row().review_status, 'reviewing');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_failure_archive').get().n, 0);
});

test('stale subprocess refusal is machine-readable and releases without charging attempts', (t) => {
  const { db, rootDir, row } = fixture(t);
  assert.equal(reviewerPostFailureExitCode({ failureClass: 'stale-review-head' }), 75);
  assert.equal(reviewerPostFailureExitCode(new Error('GitHub unavailable')), 1);
  assert.equal(classifyReviewerFailure('', 75), 'stale-review-head');
  assert.equal(classifyReviewerFailure('Review body quotes [stale-review-head]', 1), 'unknown');
  db.prepare("UPDATE reviewed_prs SET review_status = 'reviewing', reviewer_session_uuid = 'session'").run();
  settleReviewerAttempt({
    repoPath: repo, prNumber: 7576,
    result: { ok: false, exitCode: 75, error: 'Command failed with code 75',
      stderr: '[stale-review-head] refusing GitHub review post', reviewerSessionUuid: 'session' },
    statements: {
      releaseReviewerClaim: prepareReleaseReviewerClaim(db),
      releaseReviewLease: { run() { assert.fail('stale refusal must not charge the lease failure budget'); } },
      markFailed: { run() { assert.fail('stale refusal must not become an unknown failure'); } },
    },
    log: { warn() {} },
  });
  assert.equal(row().review_status, 'pending');
  assert.equal(row().review_attempts, 3);
  requestReviewRereview({
    db, rootDir, repo, prNumber: 7576, targetRevisionRef: 'head-B',
    reason: 'auto-refresh: pending review queued on stale head',
  });
  assert.equal(row().review_attempts, 0);
  const claim = prepareMarkAttemptStarted(db).run(
    '2026-10-03', 'new-session', 'head-B', 'head-B', 1000,
    '2026-10-04', 'head-B', repo, 7576,
  );
  assert.equal(claim.changes, 1);
  assert.equal(row().review_attempts, 0);
});

test('current-head exhaustion enters operator-blocked lane and pages/logs once across ticks', async (t) => {
  const { rootDir } = fixture(t);
  const pages = [], logs = [];
  const args = { rootDir, repo, prNumber: 7576, headSha: 'head-A', reason: 'attempts=3/3',
    deliverAlertFn: async (...args) => pages.push(args), logger: { warn: (...args) => logs.push(args) } };
  for (let tick = 0; tick < 3; tick++) await parkExhaustedReview({ ...args, reason: `attempts=${3 + tick}/3` });
  assert.equal(pages.length, 1);
  assert.equal(logs.length, 1);
  assert.match(pages[0][0], /Reviewer retries on this head are exhausted/);
  assert.equal(readNoProgressLane(rootDir, { repo, prNumber: 7576 }).lane, 'operator-blocked');
  await parkExhaustedReview({ ...args, headSha: 'head-B' });
  assert.equal(pages.length, 2);
});


test('archive write failure rolls back re-arm and retains the failed row', (t) => {
  const { db, rootDir, row } = fixture(t);
  // Create the archive through the same transition, without resetting a row.
  requestReviewRereview({ db, rootDir, repo, prNumber: 999 });
  db.exec(`CREATE TRIGGER reject_archive BEFORE INSERT ON review_failure_archive
    BEGIN SELECT RAISE(ABORT, 'fixture archive unavailable'); END`);
  const before = row();
  assert.throws(() => requestReviewRereview({
    db, rootDir, repo, prNumber: 7576, targetRevisionRef: 'head-B',
    expectedFailedHead: 'head-A',
  }), /fixture archive unavailable/);
  assert.deepEqual(row(), before);
});

for (const prState of ['merged', 'closed']) {
  test(`new-head reset cannot re-arm a ${prState} PR`, (t) => {
    const { db, rootDir, row } = fixture(t);
    db.prepare('UPDATE reviewed_prs SET pr_state = ?').run(prState);
    assert.equal(requestReviewRereview({
      db, rootDir, repo, prNumber: 7576, targetRevisionRef: 'head-B',
      expectedFailedHead: 'head-A',
    }).triggered, false);
    assert.equal(row().review_status, 'failed');
    assert.equal(row().review_attempts, 3);
  });
}
