import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { beginReviewerPass, completeReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { openReviewStateDb } from '../src/review-state.mjs';
import { recordReviewerCredentialFailure, readReviewerCredentialOutage, readCascadeState } from '../src/reviewer-cascade.mjs';
import { readGeminiQuotaCooldown } from '../src/gemini-quota-cooldown.mjs';
import { spawnReviewer, settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';

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
      const args = spawnArgs({ env: { AGENT_OS_REVIEWER_QUOTA_STATUS_DIR: statusDir }, capture });
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
      const args = spawnArgs({ env: { AGENT_OS_REVIEWER_QUOTA_STATUS_DIR: statusDir }, capture });
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
    const args = {
      ...spawnArgs({ env: { AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED: 'false', ADVERSARIAL_REVIEW_STATE_DIR: rootDir }, capture }),
      rootDir,
      beginReviewerPassImpl: beginReviewerPass,
      completeReviewerPassImpl: completeReviewerPass,
      reviewerModel: 'gemini',
      builderTag: 'codex',
      geminiQuotaFallbackRoute: { reviewerModel: 'claude-code', botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN' },
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

for (const failureClass of ['stale-review-head', 'review-post', 'github-review-create-transient', 'unknown']) {
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
        reviewerModel: 'gemini', result,
        statements: {
          markPosted: { run() {} },
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
