import './helpers/load-aware-timeout-fixture.mjs';
import './helpers/dispatch-files-preload.mjs';
import './helpers/worker-observation-fixture.mjs';
import { spawnReviewer } from './helpers/reviewer-quota-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { beginReviewerPass, completeReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { reapRunningPassTimeouts } from '../src/reviewer-pass-reaper.mjs';
import { transferReviewerFallbackSession } from '../src/reviewer-fallback-session.mjs';
import { reconcileReviewerSessions } from '../src/reviewer-reattach.mjs';

const repo = 'fixture/settlement';
const head = 'a'.repeat(40);
const quiet = { log() {}, warn() {}, error() {} };
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'pass-settlement-'));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, review_status,
    reviewer_session_uuid, reviewer_head_sha, review_attempts, infra_auto_recover_attempts)
    VALUES (?, 1, '2026-11-17', 'gemini', 'reviewing', 'primary', ?, 2, 3)`).run(repo, head);
  return { rootDir, db };
}

for (const ok of [true, false]) test(`outcome is durable before interrupted ${ok ? 'post' : 'primary failure'} accounting`, async t => {
  const { rootDir, db } = fixture(t);
  let finishAccounting, reachedAccounting;
  const accounting = new Promise(resolve => { finishAccounting = resolve; });
  const reached = new Promise(resolve => { reachedAccounting = resolve; });
  const running = spawnReviewer({
    rootDir, repo, prNumber: 1, reviewerModel: 'gemini', reviewerSessionUuid: 'primary',
    reviewerHeadSha: head, reviewAttemptNumber: 1, reviewDbAttemptNumber: 1,
    passKind: 'first-pass',
    reviewerRuntimeAdapterOverride: { async spawnReviewer() {
      if (ok) db.prepare(`UPDATE reviewer_passes SET gh_comment_id='posted-review', body_md='final evidence',
        body_captured_at='2026-11-17T19:57:57Z', verdict='comment-only' WHERE pr_number=1`).run();
      return { ok, reviewBodyDelivery: 'adapter', failureClass: ok ? null : 'cli-resolution-transient',
        tokenUsage: { input: 8, output: 13, total: 21, source: 'adapter' } };
    } },
    readDurablePostedAtImpl: () => ok ? '2026-11-17T19:57:57Z' : null,
    onPostOperationSettled() {
      const pass = db.prepare('SELECT * FROM reviewer_passes').get();
      assert.equal(pass.status, ok ? 'completed' : 'failed');
      assert.ok(pass.ended_at);
      assert.equal(pass.token_input, 8, 'runtime counters survive interruption before ledger enrichment');
    },
    readBestReviewerEvidenceTokenUsageImpl() { reachedAccounting(); return accounting; },
    ledgerLookupSleepImpl: async () => {},
  });
  try {
    await reached;
    assert.equal(reapRunningPassTimeouts({ db, rootDir, log: quiet }).reaped, 0);
    if (!ok) {
      // A subsequent fallback gets its own ledger attempt, retaining logical round 1.
      beginReviewerPass(rootDir, { repo, prNumber: 1, attemptNumber: 2, passKind: 'first-pass',
        reviewerClass: 'codex', headSha: head, metadata: { reviewerSessionUuid: 'fallback', reviewAttemptNumber: 1 } });
      db.prepare(`UPDATE reviewer_passes SET gh_comment_id='codex-review', body_md='codex evidence'
        WHERE attempt_number=2`).run();
      completeReviewerPass(rootDir, { repo, prNumber: 1, attemptNumber: 2, passKind: 'first-pass', status: 'completed' });
      const primary = db.prepare('SELECT * FROM reviewer_passes WHERE attempt_number=1').get();
      assert.equal(primary.reviewer_class, 'gemini');
      assert.equal(primary.gh_comment_id, null);
      assert.equal(primary.status, 'failed');
    }
  } finally { finishAccounting(null); await running; }
  const pass = db.prepare('SELECT * FROM reviewer_passes WHERE attempt_number=1').get();
  assert.equal(pass.status, ok ? 'completed' : 'failed');
  assert.equal(pass.token_input, 8);
  assert.equal(pass.token_output, 13);
  assert.equal(pass.gh_comment_id, ok ? 'posted-review' : null);
  assert.deepEqual(db.prepare('SELECT review_attempts, infra_auto_recover_attempts FROM reviewed_prs').get(),
    { review_attempts: 2, infra_auto_recover_attempts: 3 });
});

test('replayed and interleaved posted recovery charges delivery once and retains later token evidence', t => {
  const { rootDir, db } = fixture(t);
  const key = { repo, prNumber: 1, attemptNumber: 1, passKind: 'first-pass' };
  beginReviewerPass(rootDir, { ...key, reviewerClass: 'gemini', headSha: head,
    metadata: { reviewerSessionUuid: 'primary' } });
  db.prepare(`UPDATE reviewer_passes SET gh_comment_id='review-id', body_md='final evidence',
    verdict='comment-only', body_captured_at='2026-11-17T19:57:57Z'`).run();
  const options = { db, rootDir, log: quiet, queueFollowUpForRecoveredPostedReviewImpl: () => ({ queued: false }) };
  let nested = false;
  const outer = reapRunningPassTimeouts({ ...options, now() {
    if (!nested) {
      nested = true;
      assert.equal(reapRunningPassTimeouts(options).postedReviewArtifactsRecovered, 1);
      completeReviewerPass(rootDir, { ...key, status: 'completed', tokenUsage: { input: 20, output: 5 },
        metadata: { reviewerSessionUuid: 'primary', accountingEvidence: 'retained' } });
    }
    return new Date('2026-11-17T20:00:00Z');
  } });
  assert.equal(outer.reaped, 0);
  assert.equal(reapRunningPassTimeouts(options).reaped, 0);
  const pass = completeReviewerPass(rootDir, { ...key, status: 'failed',
    metadata: { reviewerSessionUuid: 'primary', failureClass: 'late-error', failureDetail: 'late-detail' } });
  assert.equal(pass.status, 'completed');
  assert.equal(pass.token_input, 20);
  assert.equal(pass.body_md, 'final evidence');
  assert.equal(JSON.parse(pass.metadata_json).accountingEvidence, 'retained');
  assert.notEqual(JSON.parse(pass.metadata_json).failureClass, 'late-error');
  assert.notEqual(JSON.parse(pass.metadata_json).failureDetail, 'late-detail');
  assert.equal(db.prepare('SELECT review_attempts FROM reviewed_prs').get().review_attempts, 3);
  const unchanged = completeReviewerPass(rootDir, { ...key, status: 'failed', tokenUsage: { input: 999 },
    metadata: { reviewerSessionUuid: 'different-owner' } });
  assert.equal(unchanged.token_input, 20);
  const wrongHead = completeReviewerPass(rootDir, { ...key, status: 'completed', expectedHeadSha: 'b'.repeat(40),
    tokenUsage: { input: 999 }, metadata: { reviewerSessionUuid: 'primary' } });
  assert.equal(wrongHead.token_input, 20);
  const usage = { input: 20, output: 5, rateLimits: [
    { limitId: 'fixture-limit', model: 'gemini', windowKind: 'primary', usedPercent: 10 },
  ] };
  for (const endedAt of ['2026-11-17T20:00:00Z', '2026-11-17T20:01:00Z']) {
    completeReviewerPass(rootDir, { ...key, status: 'completed', endedAt, tokenUsage: usage });
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reviewer_rate_limit_snapshots').get().n, 1,
    'replayed accounting without a provider timestamp uses the stable terminal time');
});

test('a reaper snapshot cannot settle delivery after concurrent outcome completion', t => {
  const { rootDir, db } = fixture(t);
  const key = { repo, prNumber: 1, attemptNumber: 1, passKind: 'first-pass' };
  beginReviewerPass(rootDir, { ...key, reviewerClass: 'gemini', headSha: head,
    metadata: { reviewerSessionUuid: 'primary' } });
  db.prepare(`UPDATE reviewer_passes SET gh_comment_id='review-id', body_md='final evidence',
    body_captured_at='2026-11-17T19:57:57Z'`).run();
  let interleaved = false;
  const result = reapRunningPassTimeouts({ db, rootDir, log: quiet, now() {
    if (!interleaved) {
      interleaved = true;
      completeReviewerPass(rootDir, { ...key, status: 'completed', tokenUsage: { input: 20 },
        metadata: { reviewerSessionUuid: 'primary', accountingEvidence: 'concurrent' } });
    }
    return new Date('2026-11-17T20:00:00Z');
  } });
  assert.equal(result.reaped, 0);
  assert.deepEqual(db.prepare('SELECT review_status, review_attempts, infra_auto_recover_attempts FROM reviewed_prs').get(),
    { review_status: 'reviewing', review_attempts: 2, infra_auto_recover_attempts: 3 });
  const pass = db.prepare('SELECT * FROM reviewer_passes').get();
  assert.equal(JSON.parse(pass.metadata_json).accountingEvidence, 'concurrent');
  assert.equal(pass.token_input, 20);
});

test('a stale reaper snapshot preserves a replacement pass owner', t => {
  const { rootDir, db } = fixture(t);
  beginReviewerPass(rootDir, { repo, prNumber: 1, attemptNumber: 1, passKind: 'first-pass',
    reviewerClass: 'gemini', headSha: head, metadata: { reviewerSessionUuid: 'primary' } });
  db.prepare(`UPDATE reviewer_passes SET gh_comment_id='review-id', body_md='final evidence',
    body_captured_at='2026-11-17T19:57:57Z'`).run();
  let replaced = false;
  const result = reapRunningPassTimeouts({ db, rootDir, log: quiet, now() {
    if (!replaced) {
      replaced = true;
      db.prepare(`UPDATE reviewer_passes SET metadata_json='{"reviewerSessionUuid":"replacement"}'`).run();
      db.prepare(`UPDATE reviewed_prs SET reviewer_session_uuid='replacement'`).run();
    }
    return new Date('2026-11-17T20:00:00Z');
  } });
  assert.equal(result.reaped, 0);
  assert.equal(db.prepare('SELECT status FROM reviewer_passes').get().status, 'running');
  assert.deepEqual(db.prepare('SELECT review_status, review_attempts FROM reviewed_prs').get(),
    { review_status: 'reviewing', review_attempts: 2 });
});

test('immediate fallback retains a failed primary when late accounting completion fails', async t => {
  const { rootDir, db } = fixture(t);
  const result = await spawnReviewer({
    rootDir, repo, prNumber: 1, reviewerModel: 'gemini', reviewerSessionUuid: 'primary',
    reviewerHeadSha: head, reviewAttemptNumber: 1, reviewDbAttemptNumber: 1, passKind: 'first-pass',
    quotaCheckEnv: { AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED: 'false' },
    geminiQuotaFallbackRoute: { reviewerModel: 'claude', botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN' },
    onGeminiQuotaFallback(route) {
      const pass = db.prepare('SELECT * FROM reviewer_passes WHERE attempt_number=1').get();
      assert.equal(pass.status, 'failed');
      assert.equal(pass.gh_comment_id, null);
      transferReviewerFallbackSession(db, { ...route, repo, prNumber: 1, previousSessionUuid: 'primary' });
    },
    reviewerRuntimeAdapterOverride: { async spawnReviewer(request) {
      if (request.model === 'gemini') return { ok: false, failureClass: 'quota-exhausted' };
      db.prepare(`UPDATE reviewer_passes SET gh_comment_id='fallback-review', body_md='fallback evidence'
        WHERE attempt_number=2`).run();
      return { ok: true, reviewBodyDelivery: 'adapter', tokenUsage: { input: 7, output: 3 } };
    } },
    completeReviewerPassImpl(root, payload) {
      if (payload.attemptNumber === 1) throw new Error('synthetic late accounting interruption');
      return completeReviewerPass(root, payload);
    },
    readBestReviewerEvidenceTokenUsageImpl: async () => null,
    ledgerLookupSleepImpl: async () => {},
  });
  assert.equal(result.ok, true);
  const passes = db.prepare('SELECT * FROM reviewer_passes ORDER BY attempt_number').all();
  assert.equal(passes.length, 2);
  assert.equal(passes[0].status, 'failed');
  assert.equal(passes[0].reviewer_class, 'gemini');
  assert.equal(passes[0].gh_comment_id, null);
  assert.equal(passes[1].status, 'completed');
  assert.equal(passes[1].gh_comment_id, 'fallback-review');
  assert.equal(passes[1].token_input, 7);
  assert.equal(JSON.parse(passes[1].metadata_json).reviewAttemptNumber, 1);
  assert.deepEqual(db.prepare('SELECT review_attempts, infra_auto_recover_attempts FROM reviewed_prs').get(),
    { review_attempts: 2, infra_auto_recover_attempts: 3 });
});

test('restart between outcome and delivery settlement recovers only a dead owner and only once', async t => {
  const { rootDir, db } = fixture(t);
  const key = { repo, prNumber: 1, attemptNumber: 1, passKind: 'first-pass' };
  beginReviewerPass(rootDir, { ...key, reviewerClass: 'gemini', headSha: head,
    metadata: { reviewerSessionUuid: 'primary', builderTag: 'claude-code' } });
  db.prepare(`UPDATE reviewer_passes SET gh_comment_id='review-id', body_md='final evidence',
    body_captured_at='2026-11-17T19:57:57Z'`).run();
  completeReviewerPass(rootDir, { ...key, status: 'completed',
    metadata: { reviewerSessionUuid: 'primary' } });
  db.prepare(`UPDATE reviewed_prs SET reviewer_pgid=12345, reviewer_started_at='2026-11-17T19:41:41Z',
    last_attempted_at='2026-11-17T19:41:41Z'`).run();
  const options = {
    db, rootDir, log: quiet, now: new Date('2026-11-17T20:00:00Z'),
    findReviewerProcess: () => ({ found: false }),
    fetchHeadSha: async () => head,
    fetchLivePrState: async () => ({ state: 'open', merged_at: null }),
    findPostedReview: async () => ({ submitted_at: '2026-11-17T19:57:57Z', commit_id: head }),
  };
  await reconcileReviewerSessions({ ...options, probeSession: () => ({ alive: true, matched: true }) });
  assert.equal(db.prepare('SELECT review_status FROM reviewed_prs').get().review_status, 'reviewing');
  await reconcileReviewerSessions({ ...options, probeAlive: () => false, probeSession: () => false });
  await reconcileReviewerSessions({ ...options, probeAlive: () => false, probeSession: () => false });
  assert.deepEqual(db.prepare('SELECT review_status, review_attempts FROM reviewed_prs').get(),
    { review_status: 'posted', review_attempts: 3 });
  assert.equal(db.prepare('SELECT gh_comment_id FROM reviewer_passes').get().gh_comment_id, 'review-id');
});
