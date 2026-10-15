import test from 'node:test';
import assert from 'node:assert/strict';
import * as timeouts from '../src/reviewer-timeout.mjs';
import { resolveAgyOversizedReviewRoute, reviewAgyOversizedInChunks, reviewWithGemini, __test__ as harness } from '../src/reviewer-harness.mjs';
import { reviewerExecutionFailureExitCode } from '../src/reviewer-outcomes.mjs';
import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';
import { settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { infraRecoverableFailureClass } from '../src/reviewer-failure-classification.mjs';

const diff = 'diff --git a/sample.mjs b/sample.mjs\n--- a/sample.mjs\n+++ b/sample.mjs\n@@ -0,0 +1,9000 @@\n' + '+synthetic content\n'.repeat(9000);

test('CHUNKTIME-01: N chunks receive N per-call budgets plus slack within the cap', () => {
  const plan = timeouts.resolveAgyChunkTimeoutPlan({ chunkCount: 4, env: {} });
  assert.ok(plan.timeoutMs >= 4 * plan.perChunkTimeoutMs);
  assert.ok(plan.timeoutMs <= plan.capMs);
  assert.equal(plan.timeoutMs, 4 * plan.perChunkTimeoutMs + timeouts.AGY_CHUNK_TIMEOUT_SLACK_MS);
});

test('CHUNKTIME-01: over-cap plan refuses before the first credential checkout and is non-infra', async () => {
  await assert.rejects(reviewAgyOversizedInChunks(diff, '', {
    env: { ADVERSARIAL_REVIEW_AGY_CHUNK_TIMEOUT_CAP_MS: '1' },
    maxBytes: 60000,
    reviewWithGeminiImpl: () => assert.fail('no identity time may be spent'),
  }), (error) => {
    assert.match(error.message, /chunks=\d+.*perChunkTimeoutMs=\d+.*requiredMs=\d+.*capMs=1/);
    const failureClass = classifyReviewerFailure(error.message, reviewerExecutionFailureExitCode(error));
    assert.equal(failureClass, 'reviewer-chunk-budget-exceeded');
    assert.equal(infraRecoverableFailureClass({ failure_message: `[${failureClass}] ${error.message}` }), null);
    const rootDir = mkdtempSync(join(tmpdir(), 'chunk-budget-'));
    const writes = [];
    try {
      settleReviewerAttempt({ rootDir, repoPath: 'example/project', prNumber: 1,
        result: { ok: false, failureClass, error: error.message }, leaseRecoveryEnabled: true,
        statements: {
          markFailed: { run: (...args) => writes.push(args) },
          releaseReviewLease: { run: () => assert.fail('must remain terminal') },
          getReviewRow: { get: () => assert.fail('must not consult or charge infra attempts') },
        }, log: { warn() {}, error() {}, info() {} },
      });
      assert.equal(writes.length, 1);
      assert.match(writes[0][1], /chunks=/);
    } finally { rmSync(rootDir, { recursive: true, force: true }); }
    return true;
  });
});

test('CHUNKTIME-01: chunk execution receives the plan deadline and an abort signal', async () => {
  let plan;
  let calls = 0;
  const result = await reviewAgyOversizedInChunks(diff, '', {
    env: {}, maxBytes: 60000,
    onChunkPlan: (value) => { plan = value; },
    reviewWithGeminiImpl: async (_diff, _context, options) => {
      assert.ok(plan.chunkCount > 1);
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.timeoutMs, plan.perChunkTimeoutMs);
      calls += 1;
      return { reviewText: '## Verdict\nComment only' };
    },
  });
  assert.equal(calls, result.chunks.length);
  assert.equal(plan.chunkCount, calls);
});

test('CHUNKTIME-01: timeout stops fake agy and releases its credential lease in the same tick', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  await assert.rejects(reviewWithGemini('+synthetic', '', {
    timeoutMs: 100, agyIdentity: null,
    resolveGeminiRuntimeImpl: () => 'antigravity',
    purgeStaleGeminiReviewerSessionDirsImpl: () => {},
    checkoutGeminiCredentialImpl: async () => ({ checkoutId: 'synthetic-checkout' }),
    materializeGeminiCheckoutSessionImpl: () => ({ env: {} }),
    assertAgyAuthImpl: async () => {},
    releaseGeminiCredentialCheckoutImpl: async () => { events.push('released'); },
    spawnAgyReviewImpl: async ({ signal }) => {
      assert.ok(signal instanceof AbortSignal);
      signal.addEventListener('abort', () => events.push('stopped'), { once: true });
      t.mock.timers.tick(100);
      signal.throwIfAborted();
    },
  }));
  assert.deepEqual(events, ['stopped', 'released']);
});


test('CHUNKTIME-01: termination forwards an abort to detached agy before self termination', async () => {
  const events = [];
  harness.configureGeminiSignalReleaseForTest({
    killImpl: () => events.push('self-signal'),
  });
  try {
    await assert.rejects(harness.spawnAgyReview({
      prompt: 'synthetic review', env: {},
      spawnWithInputImpl: async (_command, _args, options) => {
        assert.equal(options.killGraceMs, 0);
        options.signal.addEventListener('abort', () => events.push('stopped'), { once: true });
        await harness.releaseActiveGeminiCheckoutsForSignal('SIGTERM');
        options.signal.throwIfAborted();
      },
    }));
    assert.deepEqual(events, ['stopped', 'self-signal']);
  } finally { harness.resetGeminiSignalReleaseForTest(); }
});

test('CHUNKTIME-01: the plan timer aborts a late chunk without rerunning earlier chunks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let plan;
  let calls = 0;
  await assert.rejects(reviewAgyOversizedInChunks(diff, '', {
    env: {}, maxBytes: 60000,
    onChunkPlan: (value) => { plan = value; },
    reviewWithGeminiImpl: async (_diff, _context, { signal }) => {
      calls += 1;
      if (calls === 1) return { reviewText: '## Verdict\nComment only' };
      t.mock.timers.tick(plan.timeoutMs);
      assert.equal(signal.aborted, true);
      signal.throwIfAborted();
    },
  }), /Command timed out after .*chunks=/);
  assert.equal(calls, 2);
});

test('CHUNKTIME-01: Argus outer deadline covers its sequential model fallback plan', async () => {
  const { resolveArgusReviewChildTimeoutMs } = await import('../src/argus-security-drain.mjs');
  const { resolveReviewerCeilingConfig } = await import('../src/reviewer-timeout-model.mjs');
  const env = { ADVERSARIAL_ARGUS_REVIEWER_MODELS: 'claude,gemini,codex' };
  const required = 2 * resolveReviewerCeilingConfig(env).max * 1000
    + timeouts.resolveAgyReviewerSubprocessTimeoutMs(env);
  assert.ok(resolveArgusReviewChildTimeoutMs(env) >= required);
});

test('CHUNKTIME-01: native Gemini retries share one call budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  await assert.rejects(reviewWithGemini('+synthetic', '', {
    timeoutMs: 100, agyIdentity: null,
    resolveGeminiRuntimeImpl: () => 'cli',
    assertOAuthImpl: async () => {},
    retryDelaysMs: [1],
    sleepImpl: async () => { t.mock.timers.tick(100); },
    spawnGeminiReviewImpl: async () => {
      calls += 1;
      throw new Error('HTTP 503 service unavailable');
    },
  }), /Command timed out after 100ms/);
  assert.equal(calls, 1);
});


test('CHUNKTIME-01: prompt bytes include context and repeated context increases chunk count', async () => {
  const context = 'synthetic context\n'.repeat(500);
  const route = resolveAgyOversizedReviewRoute({ reviewerModel: 'gemini', geminiRuntime: 'antigravity',
    diff, extraContext: context, env: {} });
  assert.equal(route.diffBytes, Buffer.byteLength(diff));
  assert.equal(route.contextBytes, Buffer.byteLength(context));
  assert.ok(route.promptOverheadBytes > 0);
  assert.equal(route.promptBytes, route.diffBytes + route.contextBytes + route.promptOverheadBytes);
  const counts = [];
  for (const extraContext of ['', context]) {
    await reviewAgyOversizedInChunks(diff, extraContext, {
      env: {}, maxBytes: 60000,
      onChunkPlan: (plan) => counts.push(plan.chunkCount),
      reviewWithGeminiImpl: async () => ({ reviewText: '## Verdict\nComment only' }),
    });
  }
  assert.ok(counts[1] > counts[0], `${counts}`);
});


test('CHUNKTIME-01: the outer Gemini runtime defaults to the cap and honors an explicit bound', async () => {
  const { createCliDirectReviewerRuntimeAdapter } = await import('../src/adapters/reviewer-runtime/cli-direct/index.mjs');
  const rootDir = mkdtempSync(join(tmpdir(), 'chunk-runtime-'));
  const seen = [];
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({ rootDir,
      preflightImpl: async () => ({ ok: true }),
      spawnCapturedImpl: async (_command, _args, options) => {
        seen.push(options.timeout);
        return { stdout: '', stderr: '' };
      },
    });
    for (const [sessionUuid, timeoutMs] of [['synthetic-default', undefined], ['synthetic-explicit', 100]]) {
      await adapter.spawnReviewer({ model: 'gemini', prompt: '', timeoutMs, sessionUuid,
        subjectContext: { domainId: 'code-pr', repo: 'example/project', prNumber: 1 } });
    }
    assert.equal(seen[0], timeouts.resolveGeminiReviewerProcessTimeoutMs());
    assert.equal(seen[1], 100);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
