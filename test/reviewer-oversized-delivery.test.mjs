import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test__, resolveAgyOversizedReviewRoute, reviewAgyOversizedInChunks } from '../src/reviewer-harness.mjs';
import { buildPromptForReviewerModel } from '../src/reviewer-prompt.mjs';
import { alertClioOversizedAgyFailure } from '../src/reviewer-alerts.mjs';
import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';
import { settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';

const diff = '+a line of code\n'.repeat(66000);
const routeFor = (options = {}) => resolveAgyOversizedReviewRoute({
  reviewerModel: 'gemini', botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
  builderTag: 'codex', geminiRuntime: 'antigravity', diff, env: {}, ...options,
});

test('over agy argv but within Claude context routes to Claude with prompt on stdin', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'size-model-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'registry'));
  writeFileSync(join(root, 'registry', 'worker-classes.json'), JSON.stringify({
    'claude-reviewer': { defaultModel: 'claude-test-model', defaultReasoningLevel: 'high' },
  }));
  const route = routeFor();
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
    const failureClass = classifyReviewerFailure(error.message, 1);
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
      promptBytes: 9000000, maxBytes: 262144, reason: error.message }, {
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
