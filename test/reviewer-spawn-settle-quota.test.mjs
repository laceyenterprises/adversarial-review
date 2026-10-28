import './helpers/dispatch-files-preload.mjs';
import {spawnReviewer} from './helpers/reviewer-quota-fixture.mjs';
import { readCorporateCodexQuotaCooldown, recordCorporateCodexQuotaCooldown } from '../src/codex-account-routing.mjs';
import { reviewerCredentialKey } from '../src/claude-account-routing.mjs';
import { afhGroundingSnapshotFromStdout } from '../src/afh-reviewer-fallback.mjs';
import { claudeAccountFixture } from './helpers/claude-account-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { transferGeminiFallbackSession } from '../src/gemini-fallback-session.mjs';
import { postedReviewForRow } from '../src/orphan-post-reconcile.mjs';
import { createFixtureStubReviewerRuntimeAdapter } from '../src/adapters/reviewer-runtime/fixture-stub/index.mjs';
import { readReviewerRunRecord } from '../src/adapters/reviewer-runtime/run-state.mjs';
import { beginReviewerPass, completeReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { recordReviewerCredentialFailure, readReviewerCredentialOutage, readCascadeState } from '../src/reviewer-cascade.mjs';
import { readGeminiQuotaCooldown } from '../src/gemini-quota-cooldown.mjs';
import { settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';
import { infraRecoverableFailureClass } from '../src/reviewer-failure-classification.mjs';

async function withStatusFile(state, fn, { invalidJson = false } = {}) {
  const statusDir = await mkdtemp(join(tmpdir(), 'reviewer-quota-'));
  try {
    await writeFile(
      join(statusDir, 'anthropic-oauth.status.json'),
      invalidJson ? '{ invalid json' : `${JSON.stringify({ state, authPath: 'oauth' })}\n`,
      'utf8',
    );
    return await fn(statusDir);
  } finally {
    await rm(statusDir, { recursive: true, force: true });
  }
}

function spawnArgs({ env, capture }) {
  return {
    repo: 'laceyenterprises/demo',
    prNumber: 99,
    reviewerModel: 'claude-code',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    reviewerHeadSha: 'deadbeef',
    reviewerSessionUuid: randomUUID(),
    reviewAttemptNumber: 1,
    reviewDbAttemptNumber: 1,
    maxRemediationRounds: 2,
    quotaCheckEnv: env,
    reviewerRuntimeAdapterOverride: {
      async spawnReviewer() {
        capture.spawnCalls += 1;
        return { ok: true, reviewBody: 'test', reviewBodyDelivery: 'adapter' };
      },
    },
    beginReviewerPassImpl(_rootDir, args) {
      capture.begun.push(args);
    },
    async completeReviewerPassImpl(_rootDir, args) {
      capture.completed.push(args);
    },
    postGitHubReviewWithCaptureImpl: async () => {},
    readBestReviewerEvidenceTokenUsageImpl: async () => null,
    ledgerLookupSleepImpl: async () => {},
  };
}

function newCapture() {
  return { spawnCalls: 0, begun: [], completed: [] };
}

test('known-exhausted reviewer skips spawn and records a terminal quota pass', async () => {
  await withStatusFile('EXHAUSTED', async (statusDir) => {
    const capture = newCapture();
    const result = await spawnReviewer(spawnArgs({
      env: {
        AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED: 'true',
        AGENT_OS_REVIEWER_QUOTA_STATUS_DIR: statusDir,
      },
      capture,
    }));

    assert.equal(capture.spawnCalls, 0);
    assert.equal(capture.begun.length, 1);
    assert.equal(capture.begun[0].reviewerClass, 'claude');
    assert.equal(capture.begun[0].reviewerModel, 'claude-code');
    assert.equal(capture.completed.length, 1);
    assert.equal(capture.completed[0].status, 'skipped');
    assert.equal(capture.completed[0].metadata.failureClass, 'quota-exhausted');
    assert.equal(capture.completed[0].metadata.quotaReason, 'known-exhausted-provider-status');
    assert.equal(capture.completed[0].metadata.quotaState, 'exhausted');
    assert.equal(result.reason, 'primary-reviewer-quota-capped');
    assert.equal(result.failureClass, 'quota-exhausted');
    assert.equal(result.transient, true);
  });
});

test('healthy reviewer status dispatches normally', async () => {
  await withStatusFile('ok', async (statusDir) => {
    const capture = newCapture();
    const result = await spawnReviewer(spawnArgs({
      env: { AGENT_OS_REVIEWER_QUOTA_STATUS_DIR: statusDir },
      capture,
    }));
    assert.equal(capture.spawnCalls, 1);
    assert.equal(result.ok, true);
    assert.equal(capture.begun[0].reviewerClass, 'claude');
    assert.equal(capture.begun[0].reviewerModel, 'claude-code');
    assert.equal(capture.completed[0].status, 'completed');
  });
});

for (const [state, expectedSpawns] of [['ok', 1], ['exhausted', 0]]) {
  test(`Gemini ${state} quota stays independent of a selected corporate Claude account`, async () => {
    await withStatusFile('exhausted', async (statusDir) => {
      await writeFile(join(statusDir, 'google-oauth.status.json'), JSON.stringify({ state, authPath: 'oauth' }));
      const capture = newCapture();
      const args = spawnArgs({ env: { AGENT_OS_REVIEWER_QUOTA_STATUS_DIR: statusDir, ADVERSARIAL_REVIEW_STATE_DIR: statusDir }, capture });
      args.reviewerModel = 'gemini';
      args.botTokenEnv = 'GH_GEMINI_REVIEWER_TOKEN';
      args.claudeAccountSelection = { provider: 'claude-code-corp', hold: false };
      const result = await spawnReviewer(args);
      assert.equal(capture.spawnCalls, expectedSpawns);
      if (!expectedSpawns) {
        assert.equal(result.failureClass, 'quota-exhausted');
        assert.equal(capture.completed[0].metadata.quotaState, 'exhausted');
      } else assert.equal(result.ok, true);
    });
  });
}

test('unreadable reviewer status fails open and dispatches normally', async () => {
  await withStatusFile('unused', async (statusDir) => {
    const capture = newCapture();
    const result = await spawnReviewer(spawnArgs({
      env: { AGENT_OS_REVIEWER_QUOTA_STATUS_DIR: statusDir },
      capture,
    }));
    assert.equal(capture.spawnCalls, 1);
    assert.equal(result.ok, true);
  }, { invalidJson: true });
});

test('unexpected quota probe exception fails open and dispatches normally', async () => {
  const capture = newCapture();
  const args = spawnArgs({ env: {}, capture });
  const result = await spawnReviewer({
    ...args,
    async readReviewerQuotaDecisionImpl() {
      throw new Error('transient probe failure');
    },
  });
  assert.equal(capture.spawnCalls, 1);
  assert.equal(result.ok, true);
});

test('unknown reviewer status fails open and dispatches normally', async () => {
  await withStatusFile('unknown', async (statusDir) => {
    const capture = newCapture();
    const result = await spawnReviewer(spawnArgs({
      env: { AGENT_OS_REVIEWER_QUOTA_STATUS_DIR: statusDir },
      capture,
    }));
    assert.equal(capture.spawnCalls, 1);
    assert.equal(result.ok, true);
  });
});

for (const [name, disabledEnv] of [
  ['canonical kill switch', { AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED: 'false' }],
  ['legacy kill-switch alias', { ADVERSARIAL_REVIEW_QUOTA_CHECK_ENABLED: 'false' }],
]) {
  test(`${name} bypasses an exhausted status`, async () => {
    await withStatusFile('exhausted', async (statusDir) => {
      const capture = newCapture();
      const result = await spawnReviewer(spawnArgs({
        env: { ...disabledEnv, AGENT_OS_REVIEWER_QUOTA_STATUS_DIR: statusDir },
        capture,
      }));
      assert.equal(capture.spawnCalls, 1);
      assert.equal(result.ok, true);
    });
  });
}

for (const [primary, corp, expectedSpawns] of [['exhausted', 'ok', 1], ['ok', 'exhausted', 0]]) {
  test(`CCX-04 corporate reviewer admission isolates ${primary} primary / ${corp} corporate`, async () => {
    const statusDir = await mkdtemp(join(tmpdir(), 'reviewer-corp-quota-'));
    try {
      for (const [authPath, state] of [['oauth', primary], ['oauth-corp', corp]]) {
        await writeFile(join(statusDir, `openai-${authPath}.status.json`), JSON.stringify({ state, authPath }));
      }
      const capture = newCapture();
      const args = spawnArgs({ env: { AGENT_OS_REVIEWER_QUOTA_STATUS_DIR: statusDir, ADVERSARIAL_REVIEW_STATE_DIR: statusDir }, capture });
      args.reviewerModel = 'codex';
      args.codexBrokerProvider = 'codex-corp';
      args.botTokenEnv = 'GH_CODEX_REVIEWER_TOKEN';
      args.reviewerRuntimeAdapterOverride.spawnReviewer = async (request) => {
        capture.spawnCalls += 1;
        assert.equal(request.subjectContext.codexBrokerProvider, 'codex-corp');
        return { ok: true, reviewBody: 'test', reviewBodyDelivery: 'adapter' };
      };
      await spawnReviewer(args);
      assert.equal(capture.spawnCalls, expectedSpawns);
    } finally { await rm(statusDir, { recursive: true, force: true }); }
  });
}

for (const evidence of [
  { lastErrorSignature: 'model_only_exhaustion' },
  { afhGrounding: { grounded: true } },
]) {
  test(`CCX-04 reviewer spawn refuses fresh corporate cap ${JSON.stringify(evidence)}`, async () => {
    const statusDir = await mkdtemp(join(tmpdir(), 'reviewer-corp-cap-'));
    try {
      await writeFile(join(statusDir, 'openai-oauth-corp.status.json'), JSON.stringify({ state: 'unknown', authPath: 'oauth-corp', ...evidence }));
      const capture = newCapture();
      const args = spawnArgs({ env: { AGENT_OS_REVIEWER_QUOTA_STATUS_DIR: statusDir, ADVERSARIAL_REVIEW_STATE_DIR: statusDir }, capture });
      args.reviewerModel = 'codex';
      args.codexBrokerProvider = 'codex-corp';
      args.botTokenEnv = 'GH_CODEX_REVIEWER_TOKEN';
      await spawnReviewer(args);
      assert.equal(capture.spawnCalls, 0);
    } finally { await rm(statusDir, { recursive: true, force: true }); }
  });
}

for (const provider of ['codex', 'codex-corp']) {
  test(`CCX-04 spawn guard never assigns ${provider} reviewer to [codex]`, async () => {
    const capture = newCapture();
    const args = spawnArgs({ env: {}, capture });
    args.reviewerModel = 'codex';
    args.codexBrokerProvider = provider;
    args.builderTag = 'codex';
    const result = await spawnReviewer(args);
    assert.equal(result.ok, false);
    assert.equal(capture.spawnCalls, 0);
    assert.match(result.error, /Codex-family reviewer cannot review/);
  });
}

test('GEMINIQUOTA-01: no-reset checkout failure falls back in the same pass and skips subsequent checkouts', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'gemini-cooldown-'));
  try {
    const capture = newCapture();
    const models = [];
    const settled = [];
    const postedAt = '2026-01-02T03:04:05.000Z';
    const postLookups = [];
    const args = {
      ...spawnArgs({ env: { AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED: 'false', ADVERSARIAL_REVIEW_STATE_DIR: rootDir }, capture }),
      rootDir,
      beginReviewerPassImpl: beginReviewerPass,
      completeReviewerPassImpl: completeReviewerPass,
      reviewerModel: 'gemini',
      builderTag: 'codex',
      geminiQuotaFallbackRoute: { reviewerModel: 'claude-code', botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN' },
      readDurablePostedAtImpl: lookup => {
        postLookups.push(lookup);
        return lookup.reviewerModel === 'claude-code' ? postedAt : null;
      },
      onPostOperationSettled: result => settled.push(result),
      reviewerRuntimeAdapterOverride: {
        async spawnReviewer({ model }) {
          models.push(model);
          return model === 'gemini'
            ? { ok: false, failureClass: 'quota-exhausted', error: 'Gemini credential checkout deferred: quota_exhausted' }
            : { ok: true, reviewBody: 'test', reviewBodyDelivery: 'adapter' };
        },
      },
    };
    assert.equal((await spawnReviewer(args)).ok, true);
    assert.deepEqual(models, ['gemini', 'claude-code']);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].ok, true);
    assert.equal(settled[0].effectiveReviewerModel, 'claude-code');
    assert.equal(settled[0].durablePostedAt, Date.parse(postedAt));
    assert.equal(postLookups[0].reviewerModel, 'claude-code');
    assert.equal(postLookups[0].attemptNumber, 2);
    const db = openReviewStateDb(rootDir);
    try {
      const passes = db.prepare('SELECT attempt_number, reviewer_model, status, metadata_json FROM reviewer_passes ORDER BY attempt_number').all();
      assert.deepEqual(passes.map(({ attempt_number, reviewer_model, status }) => ({ attempt_number, reviewer_model, status })), [
        { attempt_number: 1, reviewer_model: 'gemini', status: 'failed' },
        { attempt_number: 2, reviewer_model: 'claude-code', status: 'completed' },
      ]);
      assert.equal(JSON.parse(passes[1].metadata_json).reviewAttemptNumber, 1);
    } finally { db.close(); }
    // A fresh invocation reads disk, including after a watcher restart.
    assert.equal((await spawnReviewer({ ...args, reviewDbAttemptNumber: 3, reviewerSessionUuid: randomUUID() })).ok, true);
    assert.deepEqual(models, ['gemini', 'claude-code', 'claude-code']);
    await writeFile(join(rootDir, 'gemini-quota-cooldown.json'), JSON.stringify({ resetAt: '2000-01-01T00:00:00Z' }));
    assert.equal((await spawnReviewer({ ...args, reviewDbAttemptNumber: 4, reviewerSessionUuid: randomUUID() })).ok, true);
    assert.deepEqual(models, ['gemini', 'claude-code', 'claude-code', 'gemini', 'claude-code']);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('GEMINIQUOTA-01: quota_exhausted without reset preserves both settlement budgets', async () => {
  const { classifyReviewerFailure } = await import('../src/adapters/reviewer-runtime/cli-direct/classification.mjs');
  const { settleReviewerAttempt } = await import('../src/reviewer-spawn-settle.mjs');
  const rootDir = await mkdtemp(join(tmpdir(), 'gemini-quota-budgets-'));
  try {
    const error = 'Gemini credential checkout deferred: quota_exhausted\nGeminiCredentialPoolNoCreditError';
    const failureClass = classifyReviewerFailure(error, 1);
    assert.equal(failureClass, 'quota-exhausted');
    const row = { review_attempts: 2, infra_auto_recover_attempts: 1 };
    let held = false;
    const charge = () => assert.fail('quota must not enter an attempt-charging statement');
    settleReviewerAttempt({
      rootDir, repoPath: 'example/demo', prNumber: 1, reviewerModel: 'gemini',
      result: { ok: false, failureClass, error },
      statements: {
        markOutageTransient: { run: () => { held = true; } },
        getReviewRow: { get: () => row },
        markFailed: { run: charge },
        releaseReviewLease: { run: charge },
        markPendingUpstream: { run: charge },
      },
      log: { warn() {} },
    });
    assert.equal(held, true);
    assert.deepEqual(row, { review_attempts: 2, infra_auto_recover_attempts: 1 });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

for (const failureClass of ['stale-review-head', 'review-post', 'github-review-create-transient', 'unknown', 'reviewer-timeout', 'reviewer-empty-output', 'reviewer-output']) {
  test(`Gemini ${failureClass} quota-like text settles without provider cooldown or fallback`, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'gemini-non-quota-'));
    try {
      const capture = newCapture();
      const settled = [];
      const args = spawnArgs({ env: { AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED: 'false' }, capture });
      const result = await spawnReviewer({
        ...args, rootDir, reviewerModel: 'gemini',
        geminiQuotaFallbackRoute: { reviewerModel: 'claude-code' },
        onPostOperationSettled: result => settled.push(result),
        reviewerRuntimeAdapterOverride: {
          async spawnReviewer() {
            capture.spawnCalls += 1;
            return { ok: false, failureClass, error: 'API rate limit exceeded for GitHub', stdout: 'Review: status 429; quota exceeded', stderr: 'rate limit exceeded' };
          },
        },
      });
      assert.equal(result.failureClass, failureClass);
      assert.equal(capture.spawnCalls, 1);
      assert.equal(settled.length, 1);
      assert.equal(readGeminiQuotaCooldown({ rootDir, env: {} }), null);
    } finally { await rm(rootDir, { recursive: true, force: true }); }
  });
}

test('Gemini fallback respects the real Claude credential hold before spawning', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'gemini-held-fallback-'));
  try {
    for (const prNumber of [1, 2]) recordReviewerCredentialFailure(rootDir, {
      reviewerModel: 'claude-code', repo: 'example/demo', prNumber,
    });
    const models = [];
    const args = {
      ...spawnArgs({ env: { AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED: 'false' }, capture: newCapture() }),
      rootDir, reviewerModel: 'gemini',
      geminiQuotaFallbackRoute: { reviewerModel: 'claude-code' },
      reviewerRuntimeAdapterOverride: {
        async spawnReviewer({ model }) {
          models.push(model);
          return { ok: false, failureClass: 'quota-exhausted' };
        },
      },
    };
    for (let call = 0; call < 2; call++) {
      const result = await spawnReviewer(args);
      assert.equal(result.failureClass, 'quota-exhausted');
      assert.equal(result.effectiveReviewerModel, 'gemini');
    }
    assert.deepEqual(models, ['gemini']);
    assert.equal(readReviewerCredentialOutage(rootDir, 'claude-code').distinctPrCount, 2);
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test('Gemini fallback passes the corporate broker route to the Codex runtime and quota gate', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'gemini-corp-fallback-'));
  try {
    const requests = [];
    const quotaRequests = [];
    const result = await spawnReviewer({
      ...spawnArgs({ env: {}, capture: newCapture() }),
      rootDir, reviewerModel: 'gemini', builderTag: 'claude-code',
      afhReviewerFallback: { stale: 'gemini-route' },
      geminiQuotaFallbackRoute: { reviewerModel: 'codex', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN', codexBrokerProvider: 'codex-corp' },
      readReviewerQuotaDecisionImpl: async request => { quotaRequests.push(request); return { available: true }; },
      reviewerRuntimeAdapterOverride: {
        async spawnReviewer(request) {
          requests.push(request);
          return request.model === 'gemini' ? { ok: false, failureClass: 'quota-exhausted' } : { ok: true };
        },
      },
    });
    assert.equal(result.effectiveReviewerModel, 'codex');
    assert.equal(quotaRequests[1].codexBrokerProvider, 'codex-corp');
    assert.equal(requests[1].subjectContext.codexBrokerProvider, 'codex-corp');
    assert.equal(requests[1].subjectContext.botTokenEnv, 'GH_CODEX_REVIEWER_TOKEN');
    assert.equal(requests[1].subjectContext.afhReviewerFallback, null);
    assert.equal(requests[1].subjectContext.crossModelReviewWaived, false);
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test('quota preflight skip falls back with a fresh real ledger row and releases an unused credential probe', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'gemini-skipped-fallback-'));
  try {
    const failedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    for (const prNumber of [1, 2]) recordReviewerCredentialFailure(rootDir, {
      reviewerModel: 'claude-code', repo: 'example/demo', prNumber, failedAt,
    });
    const before = readReviewerCredentialOutage(rootDir, 'claude-code');
    const capture = newCapture();
    const result = await spawnReviewer({
      ...spawnArgs({ env: {}, capture }),
      rootDir, reviewerModel: 'gemini',
      geminiQuotaFallbackRoute: { reviewerModel: 'claude-code' },
      beginReviewerPassImpl: beginReviewerPass,
      completeReviewerPassImpl: completeReviewerPass,
      readReviewerQuotaDecisionImpl: async () => ({ available: false, capped: true, state: 'exhausted' }),
    });
    assert.equal(result.effectiveReviewerModel, 'claude-code');
    assert.equal(capture.spawnCalls, 0);
    const after = readReviewerCredentialOutage(rootDir, 'claude-code');
    assert.equal(after.lastProbeAt, null);
    assert.equal(after.nextProbeAt, before.nextProbeAt);
    const db = openReviewStateDb(rootDir);
    try {
      assert.deepEqual(db.prepare('SELECT attempt_number, reviewer_model, status FROM reviewer_passes ORDER BY attempt_number').all(), [
        { attempt_number: 1, reviewer_model: 'gemini', status: 'skipped' },
        { attempt_number: 2, reviewer_model: 'claude-code', status: 'skipped' },
      ]);
    } finally { db.close(); }
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

for (const ok of [true, false]) {
  test(`Claude fallback ${ok ? 'success clears only Claude' : 'OAuth failure records only Claude'} credential state`, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'gemini-effective-model-'));
    try {
      for (const reviewerModel of ['gemini', 'claude-code']) recordReviewerCredentialFailure(rootDir, {
        reviewerModel, repo: 'example/demo', prNumber: 1,
      });
      const settled = [];
      const result = await spawnReviewer({
        ...spawnArgs({ env: { AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED: 'false' }, capture: newCapture() }),
        rootDir, reviewerModel: 'gemini',
        geminiQuotaFallbackRoute: { reviewerModel: 'claude-code' },
        onPostOperationSettled: result => settled.push(result),
        reviewerRuntimeAdapterOverride: {
          async spawnReviewer({ model }) {
            return model === 'gemini' ? { ok: false, failureClass: 'quota-exhausted' } : { ok, failureClass: ok ? null : 'oauth-broken' };
          },
        },
      });
      assert.equal(settled.length, 1);
      assert.equal(settled[0].effectiveReviewerModel, 'claude-code');
      settleReviewerAttempt({
        rootDir, repoPath: 'example/demo', prNumber: 2,
        reviewerModel: 'gemini', reviewerHeadSha: 'deadbeef', result,
        statements: {
          markPosted: { run() { return { changes: 1 }; } },
          markReviewerCredentialOutage: { run() {} },
          getReviewRow: { get: () => null },
        },
        log: { warn() {}, log() {} },
      });
      assert.equal(readReviewerCredentialOutage(rootDir, 'gemini').distinctPrCount, 1);
      const claudeState = readReviewerCredentialOutage(rootDir, 'claude-code');
      if (ok) assert.equal(claudeState, null);
      else {
        assert.equal(claudeState.active, true);
        assert.equal(claudeState.distinctPrCount, 2);
        assert.equal(readCascadeState(rootDir, { repo: 'example/demo', prNumber: 2 }).lastFailureModel, 'claude-code');
      }
    } finally { await rm(rootDir, { recursive: true, force: true }); }
  });
}

// Uses the runtime's real run-record claim and the real SQLite pass ledger.
test('Gemini terminal run fallback transfers claim and survives bounce recovery', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'gemini-terminal-run-'));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  try {
    const capture = newCapture();
    const args = spawnArgs({ env: { AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED: 'false', ADVERSARIAL_REVIEW_STATE_DIR: rootDir }, capture });
    const originalSession = args.reviewerSessionUuid;
    const fixture = createFixtureStubReviewerRuntimeAdapter({ rootDir, reviewerBodies: ['quota', 'fallback'] });
    db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewer, review_status,
      reviewer_session_uuid, reviewer_head_sha, last_attempted_at, reviewed_at)
      VALUES (?, ?, 'gemini', 'reviewing', ?, ?, ?, '2026-10-11T00:00:00Z')`).run(
      args.repo, args.prNumber, originalSession, args.reviewerHeadSha, '2026-10-11T00:00:00Z');
    let effectiveSession = originalSession;
    let effectiveToken;
    const result = await spawnReviewer({ ...args, rootDir, reviewerModel: 'gemini', builderTag: 'codex',
      beginReviewerPassImpl: beginReviewerPass, completeReviewerPassImpl: completeReviewerPass,
      geminiQuotaFallbackRoute: { reviewerModel: 'claude', botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN' },
      onGeminiQuotaFallback: route => {
        transferGeminiFallbackSession(db, { ...route, repo: args.repo, prNumber: args.prNumber,
          previousSessionUuid: effectiveSession });
        effectiveSession = route.reviewerSessionUuid;
      },
      reviewerRuntimeAdapterOverride: {
        async spawnReviewer(req) {
          const runtimeResult = await fixture.spawnReviewer(req);
          if (req.model === 'gemini') return { ...runtimeResult, ok: false, failureClass: 'quota-exhausted' };
          assert.notEqual(req.sessionUuid, originalSession);
          effectiveToken = req.subjectContext.reviewerSpawnToken;
          // A bounce between posting and settlement uses durable model attribution.
          const row = db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(args.repo, args.prNumber);
          const review = { user: { login: 'lacey-claude-reviewer[bot]' }, state: 'APPROVED',
            submitted_at: '2026-10-11T00:01:00Z', commit_id: args.reviewerHeadSha };
          assert.equal(postedReviewForRow(row, [review]), review);
          return { ...runtimeResult, reviewBodyDelivery: 'adapter' };
        },
      },
    });
    assert.equal(result.ok, true);
    assert.ok(effectiveToken);
    assert.equal(readReviewerRunRecord(rootDir, effectiveSession).state, 'completed');
    assert.equal(db.prepare('SELECT reviewer_session_uuid FROM reviewed_prs').get().reviewer_session_uuid, effectiveSession);
    assert.throws(() => transferGeminiFallbackSession(db, { repo: args.repo, prNumber: args.prNumber,
      previousSessionUuid: originalSession, reviewerSessionUuid: randomUUID(), reviewerModel: 'codex' }), /lost session claim/);
  } finally { db.close(); await rm(rootDir, { recursive: true, force: true }); }
});

for (const diagnostic of ['adapter reported model unavailable', 'model Synthetic stale is not recognized as a known model\nAvailable models:\n  Stale alternative']) {
  test(`REVIEWMODEL-02: structured refusal detail takes priority over ${diagnostic}`, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'model-refusal-detail-'));
    try {
      const capture = newCapture();
      const alerts = [];
      const failureDetail = { refusedModel: 'Structured refused model', availableModels: ['Structured offered model'] };
      const result = await spawnReviewer({
        ...spawnArgs({ env: { AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED: 'false' }, capture }),
        rootDir, reviewerModel: 'gemini',
        deliverAlertImpl: async (message, options) => alerts.push({ message, options }),
        reviewerRuntimeAdapterOverride: {
          async spawnReviewer() {
            return { ok: false, failureClass: 'reviewer-model-unavailable', error: diagnostic, failureDetail };
          },
        },
      });
      assert.equal(result.ok, false);
      assert.equal(alerts.length, 1);
      assert.deepEqual(alerts[0].options.payload, failureDetail);
      assert.match(alerts[0].message, /Structured refused model/);
      assert.match(alerts[0].message, /Structured offered model/);
      assert.deepEqual(capture.completed[0].metadata.failureDetail, failureDetail);
    } finally { await rm(rootDir, { recursive: true, force: true }); }
  });
}

for (const ok of [true, false]) {
  for (const field of ['error', 'stderr', 'stderrTail']) {
    test(`REVIEWMODEL-02: ${ok ? 'successful' : 'failed'} pass ${field} failure-message attribution`, async () => {
      const rootDir = await mkdtemp(join(tmpdir(), 'reviewer-message-'));
      try {
        const result = await spawnReviewer({
          ...spawnArgs({ env: { AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED: 'false' }, capture: newCapture() }),
          rootDir,
          beginReviewerPassImpl: beginReviewerPass,
          completeReviewerPassImpl: completeReviewerPass,
          reviewerRuntimeAdapterOverride: {
            async spawnReviewer() {
              return { ok, [field]: 'Synthetic runtime notice', reviewBody: 'synthetic review', reviewBodyDelivery: 'adapter' };
            },
          },
        });
        assert.equal(result.ok, ok);
        const db = openReviewStateDb(rootDir);
        try {
          const pass = db.prepare('SELECT status, metadata_json FROM reviewer_passes').get();
          assert.equal(pass.status, ok ? 'completed' : 'failed');
          assert.equal(JSON.parse(pass.metadata_json).failureMessage, ok ? null : 'Synthetic runtime notice');
        } finally { db.close(); }
      } finally { await rm(rootDir, { recursive: true, force: true }); }
    });
  }
}

test('REVIEWMODEL-02: first model refusal falls back immediately with the logical budget intact', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'model-refusal-'));
  try {
    const { readFile } = await import('node:fs/promises');
    const stderr = await readFile(new URL('./fixtures/reviewer-model-unavailable.txt', import.meta.url), 'utf8');
    const models = [];
    const settled = [];
    const alerts = [];
    let transferred = false;
    const args = {
      ...spawnArgs({ env: { AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED: 'false' }, capture: newCapture() }),
      rootDir, repo: 'example/synthetic', reviewerModel: 'gemini', builderTag: 'codex',
      env: { ALERT_TO: 'synthetic-operator', ALERT_URL: 'http://example.invalid/alert' },
      beginReviewerPassImpl: beginReviewerPass, completeReviewerPassImpl: completeReviewerPass,
      geminiQuotaFallbackRoute: { reviewerModel: 'claude-code' },
      onGeminiQuotaFallback: route => {
        const db = openReviewStateDb(rootDir);
        try {
          transferGeminiFallbackSession(db, { ...route, repo: 'example/synthetic', prNumber: 99,
            previousSessionUuid: args.reviewerSessionUuid });
        } finally { db.close(); }
        transferred = true;
      },
      onPostOperationSettled: result => settled.push(result),
      deliverAlertImpl: async (message, options) => alerts.push({ message, options }),
      reviewerRuntimeAdapterOverride: {
        async spawnReviewer({ model }) {
          models.push(model);
          if (model === 'gemini') return { ok: false, failureClass: 'reviewer-model-unavailable', error: stderr.split('\n')[0], stderr };
          assert.equal(transferred, true);
          return { ok: true, reviewBody: 'synthetic review', reviewBodyDelivery: 'adapter' };
        },
      },
    };
    const claimDb = openReviewStateDb(rootDir);
    try {
      ensureReviewStateSchema(claimDb);
      claimDb.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewer, review_status,
        reviewer_session_uuid, review_attempts, infra_auto_recover_attempts, reviewed_at)
        VALUES ('example/synthetic', 99, 'gemini', 'reviewing', ?, 2, 1, '2026-10-12T00:00:00Z')`).run(args.reviewerSessionUuid);
    } finally { claimDb.close(); }
    assert.equal((await spawnReviewer(args)).ok, true);
    assert.deepEqual(models, ['gemini', 'claude-code']);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].ok, true);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].options.payload.availableModels.length, 10);
    assert.equal(alerts[0].options.env, args.env);
    assert.equal(readGeminiQuotaCooldown({ rootDir, env: {} }), null);
    const db = openReviewStateDb(rootDir);
    try {
      const claim = db.prepare("SELECT reviewer, review_attempts, infra_auto_recover_attempts FROM reviewed_prs WHERE repo = 'example/synthetic' AND pr_number = 99").get();
      assert.deepEqual(claim, { reviewer: 'claude-code', review_attempts: 2, infra_auto_recover_attempts: 1 });
      const passes = db.prepare('SELECT metadata_json FROM reviewer_passes ORDER BY attempt_number').all();
      assert.equal(JSON.parse(passes[1].metadata_json).reviewAttemptNumber, 1);
      const failure = JSON.parse(passes[0].metadata_json);
      assert.equal(failure.failureDetail.availableModels.length, 10);
      assert.ok(failure.failureMessage.includes(stderr.split('\n')[0]));
    } finally { db.close(); }
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

for (const [name, fallback] of [
  ['unset fallback', undefined],
  ['quota-blocked fallback', { reviewerModel: 'claude-code', quotaBlocked: true }],
  ['same-model fallback', { reviewerModel: 'gemini' }],
  ['credential-held fallback', { reviewerModel: 'claude-code' }],
]) {
  test(`REVIEWMODEL-02: model refusal with ${name} settles terminal and cannot auto-retry`, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'model-refusal-terminal-'));
    try {
      if (name === 'credential-held fallback') {
        for (const prNumber of [1, 2]) {
          recordReviewerCredentialFailure(rootDir, { reviewerModel: 'claude-code', repo: 'example/synthetic', prNumber });
        }
      }
      const settled = [];
      const alerts = [];
      const capture = newCapture();
      const env = { AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED: 'false' };
      const result = await spawnReviewer({
        ...spawnArgs({ env, capture }), rootDir, reviewerModel: 'gemini',
        quotaCheckEnv: name === 'same-model fallback' ? undefined : env,
        env,
        readReviewerQuotaDecisionImpl: async () => ({ available: true }),
        geminiQuotaFallbackRoute: fallback,
        onPostOperationSettled: result => settled.push(result),
        onGeminiQuotaFallback: () => assert.fail('unavailable fallback must not transfer the claim'),
        deliverAlertImpl: async (_message, options) => alerts.push(options),
        reviewerRuntimeAdapterOverride: {
          async spawnReviewer() {
            capture.spawnCalls++;
            return { ok: false, failureClass: 'reviewer-model-unavailable', error: 'invalid model selection (--model retired-model)' };
          },
        },
      });
      assert.equal(capture.spawnCalls, 1);
      assert.equal(result.failureClass, 'reviewer-model-unavailable');
      assert.equal(alerts[0].env, env);
      assert.equal(settled.length, 1);
      assert.equal(settled[0], result);
      const failures = [];
      const retry = () => assert.fail('model refusal must not release the claim for retries');
      settleReviewerAttempt({
        rootDir, repoPath: 'example/synthetic', prNumber: 99, result,
        leaseRecoveryEnabled: true,
        env: { HQ_ROOT: rootDir },
        statements: {
          markFailed: { run: (...args) => failures.push(args) },
          markOutageTransient: { run: retry }, releaseReviewLease: { run: retry },
          markPendingUpstream: { run: retry },
        },
        log: { warn() {} },
      });
      assert.equal(failures.length, 1);
      assert.match(failures[0][1], /^\[reviewer-model-unavailable\]/);
      assert.equal(infraRecoverableFailureClass({ review_status: 'failed', failure_message: failures[0][1] }), null);
      assert.equal(readCascadeState(rootDir, { repo: 'example/synthetic', prNumber: 99 }), null);
    } finally { await rm(rootDir, { recursive: true, force: true }); }
  });
}

test('AGYCOOLDOWN-01: runtime quota evidence records the identity from its lease', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'leased-quota-'));
  const env = { AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED: 'false', ADVERSARIAL_REVIEW_STATE_DIR: rootDir };
  let released = false;
  try {
    const result = await spawnReviewer({
      ...spawnArgs({ env, capture: newCapture() }),
      rootDir, repo: 'example/synthetic', reviewerModel: 'gemini', builderTag: 'codex',
      agyReviewerIdentityPool: {
        plan: () => ({ multi: true }),
        acquire: async () => ({ user: 'reviewer-b', hqOwner: false, reviewId: 'synthetic-review' }),
        release: async () => {
          assert.ok(readGeminiQuotaCooldown({ rootDir, env, identityUser: 'reviewer-b' }), 'cooldown must exist before the lease is released');
          released = true;
        },
      },
      reviewerRuntimeAdapterOverride: {
        describe: () => ({ capabilities: { agyReviewerIdentity: true } }),
        async spawnReviewer({ subjectContext }) {
          assert.equal(subjectContext.agyIdentity.user, 'reviewer-b');
          return { ok: false, failureClass: 'quota-exhausted', stderrTail: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 50h' };
        },
      },
    });
    assert.equal(result.failureClass, 'quota-exhausted');
    assert.equal(released, true);
    const cooldown = readGeminiQuotaCooldown({ rootDir, env, identityUser: 'reviewer-b' });
    assert.ok(Date.parse(cooldown.resetAt) > Date.now() + 49 * 3600000);
    assert.equal(readGeminiQuotaCooldown({ rootDir, env, identityUser: 'owner-identity' }), null);
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

for (const [options, expectedProvider] of [[{}, 'claude-code-corp'], [{ corpNearCap: true }, 'claude-code-corp'],
  [{ corp: 'exhausted' }, 'claude-code'],
  [{ corpReady: false }, 'claude-code'], [{ corp: 'exhausted', primary: 'exhausted' }, null]]) {
  test(`Claude account decision reaches runtime: ${JSON.stringify(options)}`, async () => {
    const capture = newCapture();
    const args = spawnArgs({ env: {}, capture });
    args.builderTag = 'codex';
    args.readReviewerQuotaDecisionImpl = async ({ claudeBrokerProvider }) => {
      assert.equal(claudeBrokerProvider, expectedProvider || 'claude-code');
      return { available: true, state: 'ok' };
    };
    args.claudeAccountSelection = afhGroundingSnapshotFromStdout(JSON.stringify(claudeAccountFixture(options))).claudeAccountSelection;
    args.reviewerRuntimeAdapterOverride.spawnReviewer = async request => {
      capture.spawnCalls++;
      assert.equal(request.subjectContext.claudeBrokerProvider, expectedProvider);
      return { ok: true, reviewBody: 'synthetic', reviewBodyDelivery: 'adapter' };
    };
    const result = await spawnReviewer(args);
    assert.equal(capture.spawnCalls, expectedProvider ? 1 : 0);
    if (expectedProvider === 'claude-code-corp') assert.equal(result.claudeBrokerProvider, expectedProvider);
    if (!expectedProvider) assert.equal(result.failureClass, 'quota-exhausted');
  });
}

test('Claude builders cannot reach either Claude reviewer account', async () => {
  for (const builderTag of ['claude-code', 'claude-code-corp']) {
    const capture = newCapture();
    const args = spawnArgs({ env: {}, capture });
    args.builderTag = builderTag;
    args.readReviewerQuotaDecisionImpl = async () => { throw new Error('refusal must precede quota read'); };
    const result = await spawnReviewer(args);
    assert.equal(result.routingRefusal, true);
    assert.equal(capture.spawnCalls, 0);
  }
});

test('corporate credential failures and recovery neither pause nor clear primary credential state', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'claude-account-outage-'));
  const corp = reviewerCredentialKey('claude-code', 'claude-code-corp');
  const rearmed = [];
  const statements = {
    markPosted: { run() { return { changes: 1 }; } }, markReviewerCredentialOutage: { run() {} },
    getReviewRow: { get: () => null },
    rearmReviewerCredentialOutage: { run: pattern => rearmed.push(pattern) },
  };
  try {
    for (const reviewerModel of [corp, 'claude-code']) {
      recordReviewerCredentialFailure(rootDir, { reviewerModel, repo: 'example/synthetic', prNumber: 1 });
    }
    settleReviewerAttempt({ rootDir, repoPath: 'example/synthetic', prNumber: 2, reviewerModel: 'claude-code',
      result: { ok: false, failureClass: 'oauth-broken', claudeBrokerProvider: 'claude-code-corp' }, statements,
      log: { warn() {}, log() {} } });
    assert.equal(readReviewerCredentialOutage(rootDir, corp).active, true);
    assert.equal(readReviewerCredentialOutage(rootDir, 'claude-code').active, false);
    assert.equal(readReviewerCredentialOutage(rootDir, 'claude-code').distinctPrCount, 1);
    settleReviewerAttempt({ rootDir, repoPath: 'example/synthetic', prNumber: 2, reviewerModel: 'claude-code',
      reviewerHeadSha: 'synthetic-head',
      result: { ok: true, claudeBrokerProvider: 'claude-code-corp' }, statements,
      log: { warn() {}, log() {} } });
    assert.equal(readReviewerCredentialOutage(rootDir, corp), null);
    assert.equal(readReviewerCredentialOutage(rootDir, 'claude-code').distinctPrCount, 1);
    assert.deepEqual(rearmed, ['[outage-transient:reviewer-credential:claude-code-corp]%']);
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

for (const [reviewerModel, provider, active, expectedSpawns] of [
  ['codex', 'codex-corp', true, 0],
  ['codex', 'codex', true, 1],
  ['gemini', 'codex-corp', true, 1],
  ['codex', 'codex-corp', false, 1],
]) test(`corporate cooldown preflight isolates ${reviewerModel}/${provider} active=${active}`, async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-cooldown-preflight-'));
  const env = { ADVERSARIAL_REVIEW_STATE_DIR: rootDir };
  const resetAt = new Date(Date.now() + 3600000).toISOString();
  try {
    // Distinct formatting makes even a same-reset atomic rewrite observable.
    const originalCooldown = `${JSON.stringify({ resetAt }, null, 2)}\n`;
    if (active) {
      recordCorporateCodexQuotaCooldown(rootDir, { env, resetAt });
      await writeFile(join(rootDir, 'codex-corporate-quota-cooldown.json'), originalCooldown);
    } else await writeFile(join(rootDir, 'codex-corporate-quota-cooldown.json'), JSON.stringify({ resetAt: '2000-01-01T00:00:00Z' }));
    let quotaReads = 0;
    const capture = newCapture();
    const result = await spawnReviewer({
      ...spawnArgs({ env, capture }), rootDir, reviewerModel, codexBrokerProvider: provider,
      readReviewerQuotaDecisionImpl: async () => { quotaReads += 1; return { available: true, state: 'ok' }; },
    });
    assert.equal(capture.spawnCalls, expectedSpawns);
    assert.equal(quotaReads, expectedSpawns, 'active corporate cooldown must precede even a stale healthy quota probe');
    if (!expectedSpawns) {
      assert.equal(result.failureClass, 'quota-exhausted');
      assert.equal(result.quotaState, 'corporate-quota-cooldown');
      assert.equal(capture.completed[0].metadata.quotaState, 'corporate-quota-cooldown');
    } else assert.equal(result.ok, true);
    if (active) {
      assert.equal(readCorporateCodexQuotaCooldown(rootDir, { env }).resetAt, resetAt, 'refusal must not extend the cooldown');
      assert.equal(await readFile(join(rootDir, 'codex-corporate-quota-cooldown.json'), 'utf8'), originalCooldown,
        'preflight must leave an existing cooldown file untouched');
    }
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});
