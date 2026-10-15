import test from 'node:test';
import assert from 'node:assert/strict';
import * as timeouts from '../src/reviewer-timeout.mjs';
import { reviewAgyOversizedInChunks, reviewWithGemini } from '../src/reviewer-harness.mjs';
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

test('CHUNKTIME-01: abort reaches the fake agy child before credential release', async () => {
  const controller = new AbortController();
  const events = [];
  await assert.rejects(reviewWithGemini('+synthetic', '', {
    signal: controller.signal, agyIdentity: null,
    resolveGeminiRuntimeImpl: () => 'antigravity',
    purgeStaleGeminiReviewerSessionDirsImpl: () => {},
    checkoutGeminiCredentialImpl: async () => ({ checkoutId: 'synthetic-checkout' }),
    materializeGeminiCheckoutSessionImpl: () => ({ env: {} }),
    assertAgyAuthImpl: async () => {},
    releaseGeminiCredentialCheckoutImpl: async () => { events.push('released'); },
    spawnAgyReviewImpl: async ({ signal }) => {
      assert.ok(signal instanceof AbortSignal);
      signal.addEventListener('abort', () => events.push('stopped'), { once: true });
      controller.abort();
      signal.throwIfAborted();
    },
  }));
  assert.deepEqual(events, ['stopped', 'released']);
});
