import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureReviewStateSchema, requestReviewRereview } from '../src/review-state.mjs';
import { reviewRowInTerminalFailureState } from '../src/pollonce-phases.mjs';
import { reviewerPostFailureExitCode } from '../src/reviewer-outcomes.mjs';
import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';
import { settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';
import { parkExhaustedReview } from '../src/review-retry-exhaustion.mjs';
import { readNoProgressLane } from '../src/watcher-no-progress-lane.mjs';
import { createCliDirectReviewerRuntimeAdapter } from '../src/adapters/reviewer-runtime/cli-direct/index.mjs';
import { prepareMarkAttemptStarted, prepareReleaseReviewerClaim, prepareReleaseLegacyStaleReviewerClaim } from '../src/review-state-statements.mjs';

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

test('real cli-direct stale subprocess result releases the dispatch claim without charging attempts', async (t) => {
  const { db, rootDir, row } = fixture(t);
  assert.equal(reviewerPostFailureExitCode({ failureClass: 'stale-review-head' }), 75);
  assert.equal(reviewerPostFailureExitCode(new Error('GitHub unavailable')), 1);
  assert.equal(classifyReviewerFailure('', 75), 'unknown');
  assert.equal(classifyReviewerFailure('OAuth token expired', 75), 'oauth-broken');
  assert.equal(classifyReviewerFailure('LiteLLM all upstream attempts failed', 75), 'cascade');
  assert.equal(classifyReviewerFailure('[reviewer] GitHub post failed fixture#7576: [stale-review-head] refusing post', 75), 'stale-review-head');
  assert.equal(classifyReviewerFailure('Review body quotes [stale-review-head]', 1), 'unknown');
  db.prepare("UPDATE reviewed_prs SET review_status = 'reviewing', reviewer_session_uuid = 'session'").run();
  const adapter = createCliDirectReviewerRuntimeAdapter({
    rootDir, preflightImpl: null, resolveNodeBinImpl: () => '/fixture/node',
    spawnCapturedImpl: async () => {
      throw Object.assign(new Error('Command failed with code 75'), {
        exitCode: 75, stderr: '[stale-review-head] refusing GitHub review post',
      });
    },
  });
  const result = await adapter.spawnReviewer({
    model: 'claude', sessionUuid: 'session', timeoutMs: 1000,
    subjectContext: { repo, prNumber: 7576, reviewerHeadSha: 'head-A' },
  });
  assert.equal(result.exitCode, 75);
  assert.equal(result.failureClass, 'stale-review-head');
  assert.equal(result.reviewerSessionUuid, undefined);
  settleReviewerAttempt({
    repoPath: repo, prNumber: 7576,
    reviewerSessionUuid: 'session', reviewerHeadSha: 'head-A', result,
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

for (const [session, head, expected] of [
  [null, 'head-A', 'pending'],
  [null, 'head-B', 'reviewing'],
  ['replacement', 'head-A', 'reviewing'],
  ['replacement', 'head-B', 'reviewing'],
]) {
  test(`stale fallback protects replacement claim session=${session} head=${head}`, (t) => {
    const { db, row } = fixture(t);
    db.prepare(`UPDATE reviewed_prs SET review_status = 'reviewing',
      reviewer_session_uuid = ?, reviewer_head_sha = ?, reviewer_pgid = 123,
      reviewer_lease_expires_at = '2026-10-04'`).run(session, head);
    const before = row();
    settleReviewerAttempt({
      repoPath: repo, prNumber: 7576, reviewerSessionUuid: 'old-session', reviewerHeadSha: 'head-A',
      result: { ok: false, failureClass: 'stale-review-head' },
      statements: {
        releaseReviewerClaim: prepareReleaseReviewerClaim(db),
        releaseLegacyStaleReviewerClaim: prepareReleaseLegacyStaleReviewerClaim(db),
      }, log: { warn() {} },
    });
    assert.equal(row().review_status, expected);
    assert.equal(row().review_attempts, 3);
    if (expected === 'reviewing') assert.deepEqual(row(), before);
    else {
      assert.equal(row().reviewer_pgid, null);
      assert.equal(row().reviewer_lease_expires_at, null);
    }
  });
}

test('schema setup creates an indexed archive before re-arm and bounds retained snapshots', (t) => {
  const { db, rootDir } = fixture(t);
  ensureReviewStateSchema(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_failure_archive').get().n, 0);
  const indexes = db.prepare("PRAGMA index_list('review_failure_archive')").all().map(row => row.name);
  assert.ok(indexes.includes('idx_review_failure_archive_pr'));
  assert.ok(indexes.includes('idx_review_failure_archive_age'));
  const insert = db.prepare(`INSERT INTO review_failure_archive
    (repo, pr_number, archived_at, reason, row_json) VALUES (?, ?, ?, 'fixture', '{}')`);
  for (let i = 0; i < 105; i++) insert.run(repo, 7576, '2026-10-02T00:00:00.000Z');
  insert.run('other/repo', 1, '2026-01-01T00:00:00.000Z');
  insert.run('other/repo', 2, '2026-10-02T00:00:00.000Z');
  const result = requestReviewRereview({
    db, rootDir, repo, prNumber: 7576, expectedFailedHead: 'head-A',
    targetRevisionRef: 'head-B', requestedAt: '2026-10-03T00:00:00.000Z',
  });
  assert.equal(result.triggered, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_failure_archive WHERE repo = ?').get(repo).n, 100);
  assert.equal(db.prepare('SELECT MIN(id) AS id FROM review_failure_archive WHERE repo = ?').get(repo).id, 7);
  assert.deepEqual(db.prepare('SELECT pr_number FROM review_failure_archive WHERE repo = ?').all('other/repo'), [{ pr_number: 2 }]);
});

test('exhaustion lane write failure is logged and contained', async (t) => {
  const { rootDir } = fixture(t);
  const invalidRoot = join(rootDir, 'file');
  writeFileSync(invalidRoot, 'not a directory');
  const logs = [];
  assert.equal(await parkExhaustedReview({
    rootDir: invalidRoot, repo, prNumber: 7576, headSha: 'head-A',
    deliverAlertFn: async () => assert.fail('no alert after failed lane write'),
    logger: { warn: message => logs.push(message) },
  }), false);
  assert.ok(logs.some(message => /Review exhaustion park failed/.test(message)));
});

test('settlement does not turn unmarked EX_TEMPFAIL into an uncharged stale-head retry', (t) => {
  const { db, rootDir, row } = fixture(t);
  db.prepare("UPDATE reviewed_prs SET review_status = 'reviewing', reviewer_session_uuid = 'session'").run();
  const result = { ok: false, exitCode: 75, error: 'temporary CLI failure',
    failureClass: classifyReviewerFailure('temporary CLI failure', 75) };
  settleReviewerAttempt({
    rootDir, repoPath: repo, prNumber: 7576, result,
    reviewerSessionUuid: 'session', reviewerHeadSha: 'head-A', leaseRecoveryEnabled: false,
    statements: {
      markFailed: db.prepare(`UPDATE reviewed_prs SET review_status = 'failed',
        failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1
        WHERE repo = ? AND pr_number = ?`),
      getReviewRow: { get: row },
      releaseReviewerClaim: { run() { assert.fail('unmarked EX_TEMPFAIL must retain its failure budget'); } },
    }, log: { warn() {} },
  });
  assert.equal(row().review_status, 'failed');
  assert.equal(row().review_attempts, 4);
});
