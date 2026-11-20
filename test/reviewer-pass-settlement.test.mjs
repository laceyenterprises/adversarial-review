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
import { activeReviewerSpawns, inFlightReviewerSessions } from '../src/reviewer-session-registry.mjs';
import { loadSpawnRecords } from '../src/reviewer-fence.mjs';

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

for (const reviewerHeadSha of [undefined, null, '']) {
  test(`absent reviewer head (${String(reviewerHeadSha)}) does not fence an existing pass head`, async t => {
    const { rootDir, db } = fixture(t);
    let earlySettlementChecked = false;
    await spawnReviewer({
      rootDir, repo, prNumber: 1, reviewerModel: 'gemini', reviewerSessionUuid: 'primary',
      reviewerHeadSha, reviewAttemptNumber: 1, reviewDbAttemptNumber: 1, passKind: 'first-pass',
      reviewerRuntimeAdapterOverride: { async spawnReviewer() {
        db.prepare('UPDATE reviewer_passes SET head_sha = ?').run(head);
        return { ok: false, failureClass: 'cli-resolution-transient' };
      } },
      onPostOperationSettled() {
        const pass = db.prepare('SELECT * FROM reviewer_passes').get();
        assert.equal(pass.status, 'failed');
        assert.ok(pass.ended_at);
        assert.equal(pass.head_sha, head);
        earlySettlementChecked = true;
      },
      readBestReviewerEvidenceTokenUsageImpl() {
        assert.equal(earlySettlementChecked, true, 'outcome must settle before accounting');
        return null;
      },
      ledgerLookupSleepImpl: async () => {},
    });
    assert.equal(earlySettlementChecked, true);
  });
}

for (const recoveryStatus of ['failed', 'completed']) {
  test(`posted recovery removes persisted failure metadata from a ${recoveryStatus} pass`, t => {
    const { rootDir, db } = fixture(t);
    const key = { repo, prNumber: 1, attemptNumber: 1, passKind: 'first-pass' };
    const failures = { failureClass: 'old-class', failureReason: 'old-reason',
      failureMessage: 'old-message', failureDetail: 'old-detail', error: 'old-error' };
    beginReviewerPass(rootDir, { ...key, reviewerClass: 'gemini', headSha: head,
      metadata: { reviewerSessionUuid: 'primary', launchRequestId: 'launch', ...failures } });
    db.prepare('UPDATE reviewer_passes SET status = ?, gh_comment_id = ?').run(recoveryStatus, 'posted-review');
    const pass = completeReviewerPass(rootDir, { ...key, status: 'failed',
      metadata: { reviewerSessionUuid: 'primary', ...failures } });
    assert.equal(pass.status, 'completed');
    const metadata = JSON.parse(pass.metadata_json);
    assert.equal(metadata.launchRequestId, 'launch');
    assert.equal(metadata.reviewerSessionUuid, 'primary');
    for (const field of Object.keys(failures)) assert.equal(Object.hasOwn(metadata, field), false, field);
  });
}

for (const status of ['failed', 'cancelled']) {
  test(`late success accounting retains ${status} outcome and its failure evidence without a posted artifact`, t => {
    const { rootDir } = fixture(t);
    const key = { repo, prNumber: 1, attemptNumber: 1, passKind: 'first-pass' };
    beginReviewerPass(rootDir, { ...key, reviewerClass: 'gemini', headSha: head });
    const original = completeReviewerPass(rootDir, { ...key, status,
      metadata: { failureClass: 'original-failure', failureDetail: 'original-detail' } });
    const late = completeReviewerPass(rootDir, { ...key, status: 'completed',
      tokenUsage: { input: 9 }, metadata: { failureClass: null, failureDetail: null } });
    assert.equal(late.status, status);
    assert.equal(late.ended_at, original.ended_at);
    assert.equal(late.token_input, 9);
    assert.equal(JSON.parse(late.metadata_json).failureClass, 'original-failure');
    assert.equal(JSON.parse(late.metadata_json).failureDetail, 'original-detail');
  });
}

test('timeout settlement preserves attribution updated after the reaper scan', t => {
  const { rootDir, db } = fixture(t);
  const key = { repo, prNumber: 1, attemptNumber: 1, passKind: 'first-pass' };
  beginReviewerPass(rootDir, { ...key, reviewerClass: 'gemini', headSha: head,
    startedAt: '2026-11-17T18:00:00Z',
    metadata: { reviewerSessionUuid: 'primary', launchRequestId: 'launch',
      workerRunAttribution: { state: 'pending' } } });
  let interleaved = false;
  const result = reapRunningPassTimeouts({ db, rootDir, log: quiet, isReviewerAlive: () => false, now() {
    if (!interleaved) {
      interleaved = true;
      const row = db.prepare('SELECT metadata_json FROM reviewer_passes').get();
      db.prepare('UPDATE reviewer_passes SET metadata_json = ?').run(JSON.stringify({
        ...JSON.parse(row.metadata_json), accountingEvidence: 'concurrent',
        workerRunAttribution: { state: 'resolved', workerRunId: 'worker' },
      }));
    }
    return new Date('2026-11-17T20:00:00Z');
  } });
  assert.equal(result.reaped, 1);
  const pass = db.prepare('SELECT * FROM reviewer_passes').get();
  assert.equal(pass.status, 'failed');
  const metadata = JSON.parse(pass.metadata_json);
  assert.equal(metadata.reviewerSessionUuid, 'primary');
  assert.equal(metadata.launchRequestId, 'launch');
  assert.equal(metadata.accountingEvidence, 'concurrent');
  assert.deepEqual(metadata.workerRunAttribution, { state: 'resolved', workerRunId: 'worker' });
  assert.equal(metadata.failureClass, 'reviewer-timeout');
  assert.equal(metadata.failureReason, 'reviewer-dead');
  assert.equal(metadata.timeoutThresholdSeconds, 3600);
  assert.equal(db.prepare('SELECT infra_auto_recover_attempts FROM reviewed_prs').get().infra_auto_recover_attempts, 3,
    'timeout settlement cannot increment recovery attempts beyond the existing cap');
});

for (const fallbackSettlementThrows of [false, true]) {
  test(`settlement failure releases spawn records even when error settlement ${fallbackSettlementThrows ? 'throws' : 'succeeds'}`, async t => {
    const { rootDir } = fixture(t);
    const settlementError = new Error('synthetic settlement I/O failure');
    let spawnToken;
    let errorSettlementReached = false;
    await assert.rejects(spawnReviewer({
      rootDir, repo, prNumber: 1, reviewerModel: 'gemini', reviewerSessionUuid: 'primary',
      reviewerHeadSha: head, reviewAttemptNumber: 1, reviewDbAttemptNumber: 1, passKind: 'first-pass',
      reviewerRuntimeAdapterOverride: { async spawnReviewer() {
        return { ok: false, failureClass: 'cli-resolution-transient' };
      } },
      settleReviewerPassOutcomeImpl() {
        const record = [...activeReviewerSpawns.values()].find(row => row.reviewerSessionUuid === 'primary');
        assert.ok(record);
        spawnToken = record.spawnToken;
        assert.ok(loadSpawnRecords(process.env.ADVERSARIAL_REVIEW_STATE_DIR)[spawnToken]);
        throw settlementError;
      },
      completeReviewerPassImpl(root, payload) {
        errorSettlementReached = true;
        if (fallbackSettlementThrows) throw new Error('synthetic error settlement I/O failure');
        return completeReviewerPass(root, payload);
      },
      readBestReviewerEvidenceTokenUsageImpl: async () => assert.fail('accounting cannot run after settlement throws'),
    }), error => error === settlementError);
    assert.equal(errorSettlementReached, true);
    assert.equal(activeReviewerSpawns.has(spawnToken), false);
    assert.equal(inFlightReviewerSessions.has('primary'), false);
    assert.equal(Object.hasOwn(loadSpawnRecords(process.env.ADVERSARIAL_REVIEW_STATE_DIR), spawnToken), false);
  });
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

test('REVIEWSETTLETOKENWAIT-01: late token-only backfill does not regress attribution resolved before deferred replay', t => {
  const { rootDir } = fixture(t);
  const key = { repo, prNumber: 1, attemptNumber: 1, passKind: 'first-pass' };
  beginReviewerPass(rootDir, { ...key, reviewerClass: 'gemini', headSha: head,
    metadata: { reviewerSessionUuid: 'primary', launchRequestId: 'lrq_race_1',
      workerRunAttribution: { state: 'pending', launchRequestId: 'lrq_race_1', workerRunId: null, retryable: true } } });
  // Initial settlement exceeds the bound, leaving attribution pending
  const settled = completeReviewerPass(rootDir, {
    ...key, status: 'completed', tokenUsage: { input: 8, output: 13, total: 21 },
    workerRunId: null,
    metadata: {
      reviewerSessionUuid: 'primary', launchRequestId: 'lrq_race_1',
      workerRunAttribution: { state: 'pending', launchRequestId: 'lrq_race_1', workerRunId: null, lookupAttempts: 1, lastError: 'settle-bound-exceeded', retryable: true },
    },
  });
  assert.equal(settled.worker_run_id, null);
  assert.equal(JSON.parse(settled.metadata_json).workerRunAttribution.state, 'pending');

  // Backfill resolves the worker run while the deferred read is still pending
  const backfilled = completeReviewerPass(rootDir, {
    ...key, status: 'completed',
    workerRunId: 'wr_race_1',
    metadata: {
      reviewerSessionUuid: 'primary', launchRequestId: 'lrq_race_1',
      workerRunAttribution: { state: 'resolved', launchRequestId: 'lrq_race_1', workerRunId: 'wr_race_1', lookupAttempts: 2, lastError: null, retryable: false },
    },
  });
  assert.equal(backfilled.worker_run_id, 'wr_race_1');
  assert.equal(JSON.parse(backfilled.metadata_json).workerRunAttribution.state, 'resolved');

  // Deferred read returns token evidence without a workerRunId
  const late = completeReviewerPass(rootDir, {
    ...key, status: 'completed',
    tokenUsage: { input: 15, output: 25, total: 40, source: 'session-ledger' },
    workerRunId: null,
    metadata: {
      reviewerSessionUuid: 'primary', launchRequestId: 'lrq_race_1',
      workerRunAttribution: { state: 'pending', launchRequestId: 'lrq_race_1', workerRunId: null, lookupAttempts: 1, lastError: null, retryable: true },
    },
  });
  // Token usage is updated from the deferred read
  assert.equal(late.token_input, 15);
  assert.equal(late.token_output, 25);
  assert.equal(late.token_total, 40);
  // worker_run_id and attribution remain resolved and do not regress to pending
  assert.equal(late.worker_run_id, 'wr_race_1');
  const lateMeta = JSON.parse(late.metadata_json);
  assert.deepEqual(lateMeta.workerRunAttribution, {
    state: 'resolved',
    launchRequestId: 'lrq_race_1',
    workerRunId: 'wr_race_1',
    lookupAttempts: 2,
    lastError: null,
    retryable: false,
  });
});
