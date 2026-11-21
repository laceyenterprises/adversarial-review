import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliDirectReviewerRuntimeAdapter } from '../src/adapters/reviewer-runtime/cli-direct/index.mjs';
import { readReviewerRunRecord, recordReviewerCancellation } from '../src/adapters/reviewer-runtime/run-state.mjs';
import { hasReviewerCancellation } from '../src/adapters/reviewer-runtime/run-state.mjs';
import * as reviewerOutcomes from '../src/reviewer-outcomes.mjs';
import { reconcileReviewerSessions, reviewerBotLogin } from '../src/reviewer-reattach.mjs';
import { shouldBackoffReviewerSpawn } from '../src/reviewer-cascade.mjs';
import {
  infraRecoverableFailureClass, reviewPopulationFailureClass, unknownReviewerCommandFailureClass,
} from '../src/reviewer-failure-classification.mjs';
import { settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import {
  prepareMarkAttemptStarted, prepareReleaseReviewerClaim,
} from '../src/review-state-statements.mjs';

const repo = 'fixture/interruption';
const head = 'a'.repeat(40);
const session = 'synthetic-review-session';
const failedAt = '2026-11-21T08:00:00.000Z';
const outcomesUrl = new URL('../src/reviewer-outcomes.mjs', import.meta.url).href;
const interrupted = JSON.stringify({ event: 'result', result: {
  status: 'ERROR', response: '', error: 'interrupted', finished_reason: 'interrupted',
  duration_seconds: 335.768544, usage: { thinking_tokens: 48193 },
} });

function fixture(t, source) {
  const rootDir = mkdtempSync(join(tmpdir(), 'review-interruption-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const reviewerProcessPath = join(rootDir, 'fixture-reviewer.mjs');
  writeFileSync(reviewerProcessPath, source);
  const adapter = createCliDirectReviewerRuntimeAdapter({
    rootDir, reviewerProcessPath, preflightImpl: null, resolveNodeBinImpl: () => process.execPath,
  });
  return { rootDir, adapter, request: {
    model: 'gemini', sessionUuid: session, timeoutMs: 5000,
    subjectContext: { repo, prNumber: 1, reviewerHeadSha: head, builderTag: 'claude-code' },
  } };
}

function claimedRow(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  ensureReviewStateSchema(db);
  db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer,
    review_status, reviewer_session_uuid, reviewer_head_sha, review_attempts, infra_auto_recover_attempts,
    reviewer_started_at, pr_state)
    VALUES (?, 1, ?, 'gemini', 'reviewing', ?, ?, 1, 2, ?, 'open')`).run(repo, failedAt, session, head, failedAt);
  return { db, read: () => db.prepare('SELECT * FROM reviewed_prs').get() };
}

test('local progress stall survives a long agy teardown diagnostic and returns to watcher backoff', async t => {
  const { rootDir, adapter, request } = fixture(t, `
    import { reviewerExecutionFailureExitCode } from ${JSON.stringify(outcomesUrl)};
    const error = Object.assign(new Error('[reviewer-stalled] Command no output for 309411ms'), { reviewerStalled: true });
    const diagnostic = [error.message, 'synthetic diagnostic\\n'.repeat(130), ${JSON.stringify(interrupted)}].join('\\n');
    process.stderr.write(diagnostic, () => process.exit(reviewerExecutionFailureExitCode(error)));
  `);
  const { db, read } = claimedRow(t);
  const result = await adapter.spawnReviewer(request);
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'reviewer-stalled');
  assert.equal(readReviewerRunRecord(rootDir, session).state, 'cancelled');
  settleReviewerAttempt({ rootDir, repoPath: repo, prNumber: 1, result, reviewerModel: 'gemini',
    reviewerSessionUuid: session, reviewerHeadSha: head, failureAt: failedAt,
    statements: { releaseReviewerClaim: prepareReleaseReviewerClaim(db) }, log: { warn() {} },
  });
  assert.equal(read().review_status, 'pending');
  assert.equal(read().reviewer_session_uuid, null);
  assert.equal(read().reviewer, 'gemini');
  assert.equal(read().review_attempts, 1);
  assert.equal(read().infra_auto_recover_attempts, 2);
  const backoff = now => shouldBackoffReviewerSpawn(rootDir, { repo, prNumber: 1, reviewerModel: 'gemini', now });
  assert.equal(backoff(failedAt).shouldBackoff, true);
  const afterBackoff = '2026-11-21T08:01:01.000Z';
  assert.equal(backoff(afterBackoff).shouldBackoff, false);
  const claim = prepareMarkAttemptStarted(db).run(
    afterBackoff, 'next-session', head, head, 5000, '2026-11-21T08:02:01.000Z', head, repo, 1,
  );
  assert.equal(claim.changes, 1);
  assert.equal(read().reviewer_session_uuid, 'next-session');
  assert.equal(read().review_attempts, 1);
  assert.equal(read().infra_auto_recover_attempts, 2);
});

test('agy interruption alone retains the ordinary command-failure path', async t => {
  const { adapter, request } = fixture(t, `
    process.stderr.write(${JSON.stringify(interrupted)}, () => process.exit(1));
  `);
  const result = await adapter.spawnReviewer(request);
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'unknown');
  assert.equal(infraRecoverableFailureClass({ failure_message: `[unknown] ${result.error}` }), 'reviewer-command-failed');
});

test('reviewer wrapper control outcomes have distinct exit codes', () => {
  const codes = Object.entries(reviewerOutcomes).filter(([key]) => key.endsWith('_EXIT_CODE')).map(([, value]) => value);
  assert.equal(new Set(codes).size, codes.length);
});

test('the direct adapter preserves a typed GitHub budget deferral', async t => {
  const receipt = JSON.stringify({ resource: 'core', remaining: 0, resetAt: failedAt, credential: 'fixture' });
  const { adapter, request } = fixture(t, `
    process.stderr.write(${JSON.stringify(`[reviewer-github-budget-deferred] ${receipt}\n[reviewer-stalled] prior diagnostic\n`)},
      () => process.exit(${reviewerOutcomes.REVIEWER_GITHUB_BUDGET_DEFERRED_EXIT_CODE}));
  `);
  const result = await adapter.spawnReviewer(request);
  assert.equal(result.failureClass, 'github-budget-deferred');
});

for (const callback of ['onSpawn', 'onMessage']) test(`runner ${callback} failures do not cancel the claim`, async t => {
  const { adapter, request } = fixture(t, `
    ${callback === 'onMessage' ? "process.send({ type: 'gemini-chunk-plan', plan: {} });" : ''}
    setInterval(() => {}, 1000);
  `);
  if (callback === 'onSpawn') request.onReviewerPgid = () => { throw new Error('fixture spawn callback failed'); };
  const result = await adapter.spawnReviewer(request);
  assert.equal(result.ok, false);
  assert.match(result.error, new RegExp(`${callback} callback failed`));
  assert.notEqual(result.failureClass, 'cancelled');
});

for (const signal of ['SIGTERM', 'SIGKILL']) test(`an unattributed ${signal} is recoverable`, async t => {
  const { adapter, request } = fixture(t, `process.kill(process.pid, ${JSON.stringify(signal)});`);
  const result = await adapter.spawnReviewer(request);
  assert.equal(result.signal, signal);
  assert.equal(result.failureClass, 'daemon-bounce');
});

test('cancellation receipt tolerates an unrecorded PGID and fences known identities', t => {
  const { rootDir } = fixture(t, '');
  const claim = { sessionUuid: session, headSha: head, pgid: 123 };
  recordReviewerCancellation(rootDir, claim);
  assert.equal(hasReviewerCancellation(rootDir, { ...claim, pgid: null }), true);
  assert.equal(hasReviewerCancellation(rootDir, claim), true);
  assert.equal(hasReviewerCancellation(rootDir, { ...claim, pgid: 456 }), false);
  assert.equal(hasReviewerCancellation(rootDir, { ...claim, pgid: null, headSha: 'b'.repeat(40) }), false);
  assert.equal(hasReviewerCancellation(rootDir, { ...claim, pgid: null, sessionUuid: 'replacement' }), false);
});

for (const alreadyPosted of [false, true]) test(`operator cancellation reconciles GitHub before charging (posted=${alreadyPosted})`, async t => {
  const { rootDir, adapter, request } = fixture(t, `
    process.stderr.write(${JSON.stringify(`${interrupted}\nno GitHub review found\n[oauth-broken] prior diagnostics\nCreate review HTTP 503\n`)},
      () => process.kill(process.pid, 'SIGTERM'));
  `);
  const { db, read } = claimedRow(t);
  request.onReviewerPgid = ({ pgid }) => {
    db.prepare("UPDATE reviewed_prs SET reviewer_pgid = ?").run(pgid);
    recordReviewerCancellation(rootDir, { sessionUuid: session, headSha: head, pgid });
  };
  const result = await adapter.spawnReviewer(request);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.failureClass, 'cancelled');
  assert.equal(readReviewerRunRecord(rootDir, session).state, 'cancelled');
  settleReviewerAttempt({ rootDir, repoPath: repo, prNumber: 1, result, reviewerModel: 'gemini',
    reviewerSessionUuid: session, reviewerHeadSha: head, failureAt: failedAt, leaseRecoveryEnabled: true,
    statements: {}, log: { warn() {} },
  });
  assert.equal(read().review_status, 'reviewing');
  assert.equal(read().review_attempts, 1);
  let reviewReads = 0;
  const reconcile = () => reconcileReviewerSessions({
    db, rootDir, now: new Date(failedAt), fetchHeadSha: async () => head, probeAlive: () => false,
    log: { log() {}, warn() {} }, leaseRecoveryEnabled: true, postKillReviewReprobeDelaysMs: [0],
    octokit: { rest: { pulls: { listReviews: async () => {
      reviewReads++;
      const review = { user: { login: reviewerBotLogin('gemini') }, submitted_at: failedAt, state: 'COMMENTED' };
      return { data: [
        { ...review, commit_id: 'b'.repeat(40) },
        ...(alreadyPosted && reviewReads === 2 ? [{ ...review, commit_id: head }] : []),
      ] };
    } } } },
  });
  // An unrelated receipt cannot apply to a different claim.
  db.prepare("UPDATE reviewed_prs SET reviewer_session_uuid = 'replacement'").run();
  const replacement = read();
  settleReviewerAttempt({ rootDir, repoPath: repo, prNumber: 1, result, reviewerModel: 'gemini',
    reviewerSessionUuid: session, reviewerHeadSha: head, failureAt: failedAt,
    statements: {}, log: { warn() {} },
  });
  assert.deepEqual(read(), replacement);
  db.prepare("UPDATE reviewed_prs SET reviewer_session_uuid = ?").run(session);
  await reconcile();
  assert.equal(reviewReads, 2);
  const row = read();
  assert.equal(row.review_status, alreadyPosted ? 'posted' : 'failed');
  assert.equal(row.review_attempts, 2);
  assert.equal(row.infra_auto_recover_attempts, alreadyPosted ? 0 : 2);
  if (alreadyPosted) {
    assert.equal(row.failure_message, null);
    assert.equal(row.posted_at, failedAt);
    return;
  }
  assert.match(row.failure_message, /^\[cancelled\]/);
  assert.equal(infraRecoverableFailureClass(row), null);
  assert.equal(unknownReviewerCommandFailureClass(row), null);
  assert.equal(reviewPopulationFailureClass(row), null);
  const claim = prepareMarkAttemptStarted(db).run(
    failedAt, 'next-session', head, head, 5000, failedAt, head, repo, 1,
  );
  assert.equal(claim.changes, 0);

});
