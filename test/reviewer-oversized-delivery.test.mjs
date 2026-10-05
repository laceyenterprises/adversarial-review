import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test__, resolveAgyOversizedReviewRoute, reviewAgyOversizedInChunks } from '../src/reviewer-harness.mjs';
import { buildPromptForReviewerModel } from '../src/reviewer-prompt.mjs';
import { alertClioOversizedAgyFailure } from '../src/reviewer-alerts.mjs';
import { ReviewerPromptTooLargeError, reviewerExecutionFailureExitCode, REVIEWER_PROMPT_TOO_LARGE_EXIT_CODE } from '../src/reviewer-outcomes.mjs';
import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';
import { settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';

const diff = '+a line of code\n'.repeat(66000);
const routeFor = (options = {}) => resolveAgyOversizedReviewRoute({
  reviewerModel: 'gemini', botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
  builderTag: 'codex', geminiRuntime: 'antigravity', diff, env: {}, ...options,
});

test('model-output size markers cannot turn retryable failures terminal', async () => {
  const runtime = await import('../src/adapters/reviewer-runtime/cli-direct/index.mjs');
  for (const preview of [
    '[reviewer] DEBUG: raw Codex review length=100; preview=[reviewer-prompt-too-large]',
    '[reviewer] SANITIZE INPUT PREVIEW: [reviewer-prompt-too-large]',
    'Antigravity agy returned output without a parseable review verdict: [reviewer-prompt-too-large]',
    '[reviewer] AI review failed for example/repo#3: [reviewer-prompt-too-large] quoted model text',
  ]) {
    const error = new Error(preview);
    assert.equal(reviewerExecutionFailureExitCode(error), 1);
    assert.equal(classifyReviewerFailure(preview, 1), 'unknown');
    assert.equal(classifyReviewerFailure(preview, null, null, { timeoutKilled: true }), 'reviewer-timeout');
    assert.equal(runtime.reviewerSignalAwareFailureClass({ stderr: preview }, preview, null,
      { timeoutKilled: true }), 'reviewer-timeout');
    assert.equal(classifyReviewerFailure(`${preview}\nCommand timed out after 100ms`, 1), 'reviewer-timeout');
  }
  assert.equal(classifyReviewerFailure('', REVIEWER_PROMPT_TOO_LARGE_EXIT_CODE), 'reviewer-prompt-too-large');
});

test('transient chunk failures and quoted size markers do not page a terminal size alert', async () => {
  for (const error of [new Error('Command timed out after 100ms'), new Error('HTTP 529'),
    new Error('preview=[reviewer-prompt-too-large]')]) {
    assert.equal(await alertClioOversizedAgyFailure({ repo: 'r', prNumber: 1,
      promptBytes: 300000, maxBytes: 200000, error, reason: error.message }, {
      deliverAlertImpl: () => assert.fail('transient errors must not send size alerts'),
    }), null);
  }
});

test('default budgets chunk medium-large prompts for every direct reviewer', () => {
  for (const reviewerModel of ['claude', 'codex', 'gemini']) {
    const route = routeFor({ reviewerModel, geminiRuntime: 'cli', diff: 'x'.repeat(400000) });
    assert.equal(route.maxBytes, 150000 * 2 - 64 * 1024);
    assert.equal(route.oversized, true);
    assert.equal(route.route, null);
    assert.equal(routeFor({ reviewerModel, geminiRuntime: 'cli', diff: '+small' }).oversized, false);
  }
});

test('injected environment controls chunk hard ceiling and cap without global mutation', async () => {
  await assert.rejects(reviewAgyOversizedInChunks('small', 'context', {
    env: { ADVERSARIAL_REVIEW_CHUNK_HARD_MAX_BYTES: '10' },
    reviewWithGeminiImpl: () => assert.fail('hard ceiling must be checked before spawn'),
  }), /size=12 hardMaxBytes=10/);
  await assert.rejects(reviewAgyOversizedInChunks('small', '', {
    env: { ADVERSARIAL_REVIEW_AGY_CHUNK_MAX_CHUNKS: '0' },
    reviewWithGeminiImpl: () => assert.fail('injected zero cap disables chunking'),
  }), /chunking-disabled/);
  const route = routeFor({ diff: '+small', env: { ADVERSARIAL_REVIEW_AGY_ARGV_MAX_BYTES: '10000' } });
  assert.equal(route.maxBytes, 10000 - 1024);
});

test('chunked reviews sum full provider usage without double-counting overlapping buckets', async () => {
  for (const reviewerModel of ['codex', 'claude', 'gemini']) {
    let calls = 0;
    const usage = { input: 10, output: 4, reasoning: 3, cacheRead: 2, cacheWrite: 1,
      toolContext: 5, total: 17, guardrail: 17, costUSD: 0.25,
      source: `${reviewerModel}-json`, model: `${reviewerModel}-test`, usageTag: 'guardrail' };
    const run = async () => {
      calls += 1;
      return { reviewText: '## Summary\nReviewed.\n\n## Verdict\nComment only', rawReviewText: '## Summary\nReviewed.\n\n## Verdict\nComment only',
        needsSanitize: reviewerModel === 'codex', tokenUsage: usage };
    };
    const result = await reviewAgyOversizedInChunks(diff, '', {
      reviewerModel, maxBytes: 250000, dispatchReviewerModelImpl: run, reviewWithGeminiImpl: run,
    });
    assert.ok(calls > 1);
    for (const field of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'toolContext', 'total', 'guardrail', 'costUSD']) {
      assert.equal(result.tokenUsage[field], usage[field] * calls, field);
    }
    assert.equal(result.tokenUsage.source, usage.source);
    assert.equal(result.tokenUsage.model, usage.model);
  }
});

test('chunk usage remains null when absent and partial when some chunks lack usage', async () => {
  for (const withUsage of [false, true]) {
    let calls = 0;
    const result = await reviewAgyOversizedInChunks(diff, '', {
      reviewerModel: 'codex', maxBytes: 250000,
      dispatchReviewerModelImpl: async () => ({ reviewText: '## Verdict\nComment only',
        tokenUsage: ++calls === 1 && withUsage ? { input: 10, output: 4, source: 'codex-json' } : null }),
    });
    if (withUsage) {
      assert.equal(result.tokenUsage.total, 14);
      assert.equal(result.tokenUsage.partial, true);
    } else assert.equal(result.tokenUsage, null);
  }
});

test('rejected Codex chunks preserve raw output and the original sanitizer failure', async () => {
  for (const hookFails of [false, true]) {
    const rejected = [];
    const rawReviewText = 'unparseable model output [reviewer-prompt-too-large]';
    await assert.rejects(reviewAgyOversizedInChunks(diff, '', {
      reviewerModel: 'codex', maxBytes: 250000,
      dispatchReviewerModelImpl: async () => ({ needsSanitize: true, rawReviewText }),
      onRejectedCodexOutput: (item) => {
        rejected.push(item);
        if (hookFails) throw new Error('forensic storage unavailable');
      },
    }), (error) => {
      assert.equal(reviewerExecutionFailureExitCode(error), 1);
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].rawReviewText, rawReviewText);
      assert.equal(rejected[0].rejectionReason, error.message);
      assert.equal(rejected[0].chunkIndex, 1);
      return true;
    });
  }
});

test('merge refuses truncated review coverage instead of posting a partial review', () => {
  assert.throws(() => __test__.mergeChunkedAgyReviews([{ reviewText: '## Verdict\nComment only' }],
    { truncated: true }), ReviewerPromptTooLargeError);
});

test('over agy argv but within Claude context routes to Claude with prompt on stdin', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'size-model-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'registry'));
  writeFileSync(join(root, 'registry', 'worker-classes.json'), JSON.stringify({
    'claude-reviewer': { defaultModel: 'claude-test-model', defaultReasoningLevel: 'high' },
  }));
  const route = routeFor({ env: { ADVERSARIAL_REVIEW_CLAUDE_CONTEXT_TOKENS: '600000' } });
  assert.equal(route.oversized, true);
  assert.equal(route.route.reviewerModel, 'claude');
  let invocation;
  await __test__.reviewWithClaude(diff, '', {
    platform: 'linux',
    assertClaudeOAuthImpl: async () => ({ transport: 'keychain', env: { PATH: process.env.PATH, HQ_ROOT: root }, uid: 501 }),
    spawnClaudeImpl: async (args, options) => {
      invocation = { args, options };
      return { stdout: JSON.stringify({ result: '## Verdict\nComment only', usage: {} }), stderr: '' };
    },
  });
  assert.ok(invocation.options.input.includes(diff));
  assert.ok(Buffer.byteLength(invocation.options.input) > 1024 * 1024);
  assert.ok(!invocation.args.some((arg) => arg.includes(diff)));
  assert.ok(invocation.args.includes('--model'));
});

test('oversized for both stays with agy chunks, preserving the cross-model reviewer', async () => {
  const route = routeFor({ env: { ADVERSARIAL_REVIEW_CLAUDE_CONTEXT_TOKENS: '100000' } });
  assert.equal(route.route, null);
  let calls = 0;
  const result = await reviewAgyOversizedInChunks(diff, '', {
    maxBytes: route.maxBytes,
    reviewWithGeminiImpl: async (chunk, context) => {
      calls += 1;
      assert.ok(Buffer.byteLength(buildPromptForReviewerModel('gemini', chunk, context,
        { runtime: 'antigravity' })) <= route.maxBytes);
      return { reviewText: '## Blocking issues\n- None.\n\n## Verdict\nComment only' };
    },
  });
  assert.ok(calls > 1);
  assert.equal(result.truncated, false);
});

test('direct Claude oversize is chunked using Claude, with bounded full prompts', async () => {
  const route = routeFor({ reviewerModel: 'claude', diff: diff.repeat(3) });
  assert.equal(route.route, null);
  let calls = 0;
  await reviewAgyOversizedInChunks(diff.repeat(3), '', {
    reviewerModel: 'claude', maxBytes: route.maxBytes,
    dispatchReviewerModelImpl: async (model, chunk, context) => {
      assert.equal(model, 'claude');
      calls += 1;
      assert.ok(Buffer.byteLength(buildPromptForReviewerModel(model, chunk, context)) <= route.maxBytes);
      return { reviewText: '## Verdict\nComment only' };
    },
  });
  assert.ok(calls > 1);
});

async function assertTerminalAlert(error) {
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewer-size-'));
  try {
    const failureClass = classifyReviewerFailure(error.message, reviewerExecutionFailureExitCode(error));
    assert.equal(failureClass, 'reviewer-prompt-too-large');
    const writes = [];
    settleReviewerAttempt({ rootDir, repoPath: 'example/repo', prNumber: 3,
      result: { ok: false, failureClass, error: error.message }, leaseRecoveryEnabled: true,
      statements: {
        markFailed: { run: (...args) => writes.push(args) },
        releaseReviewLease: { run: () => assert.fail('must never return to pending') },
      }, log: { warn() {}, error() {}, info() {} },
    });
    assert.equal(writes.length, 1);
    assert.match(writes[0][1], /reviewer-prompt-too-large/);
    const alerts = [];
    await alertClioOversizedAgyFailure({ repo: 'example/repo', prNumber: 3,
      promptBytes: 9000000, maxBytes: 262144, reason: error.message, error }, {
      deliverAlertImpl: async (message, options) => { alerts.push({ message, options }); return { id: 'offline' }; },
    });
    assert.equal(alerts[0].options.event, 'reviewer.oversized_agy_prompt');
    assert.match(alerts[0].message, /9000000/);
    assert.ok(alerts[0].message.includes(error.message));
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
}

test('hard ceiling records a terminal failure and alert before any model spawn', async () => {
  const error = await reviewAgyOversizedInChunks('x'.repeat(9 * 1024 * 1024), '', {
    reviewWithGeminiImpl: () => assert.fail('must not spawn'),
  }).then(() => assert.fail('must reject'), (err) => err);
  assert.match(error.message, /hard ceiling exceeded: size=9437184/);
  await assertTerminalAlert(error);
});

test('chunk cap is terminal and alerting, never a partial successful review', async () => {
  const error = await reviewAgyOversizedInChunks(diff, '', {
    maxChunks: 1, reviewWithGeminiImpl: () => assert.fail('must preflight all chunks'),
  }).then(() => assert.fail('must reject'), (err) => err);
  assert.match(error.message, /chunk-cap-hit/);
  await assertTerminalAlert(error);
});

test('Claude argv never contains prompt body and retains explicit model binding', () => {
  for (const body of ['small secret body', diff]) {
    const args = __test__.buildClaudeReviewArgs(body, { model: 'claude-test-model', effort: 'high' });
    assert.ok(!args.includes(body));
    assert.equal(args[args.indexOf('--model') + 1], 'claude-test-model');
  }
});


test('target delivery budget can refuse a route independently of context', () => {
  assert.equal(routeFor({ env: { ADVERSARIAL_REVIEW_CLAUDE_DELIVERY_MAX_BYTES: '100000' } }).route, null);
});

test('new size failure is excluded from automatic command and population retries', async () => {
  const { unknownReviewerCommandFailureClass } = await import('../src/reviewer-failure-classification.mjs');
  const { reviewPopulationRetryDecision } = await import('../src/reviewer-route-selection.mjs');
  const row = { review_status: 'failed', failure_message: '[reviewer-prompt-too-large] Command failed with code 1',
    failed_at: new Date().toISOString(), review_attempts: 1, reviewer_head_sha: 'head' };
  assert.equal(unknownReviewerCommandFailureClass(row), null);
  assert.equal(reviewPopulationRetryDecision(row, { headSha: 'head' }).retryable, false);
});
