import './helpers/load-aware-timeout-fixture.mjs';
import { resolveProgressTimeoutMs } from '../src/reviewer-timeout.mjs';
import { resolveReviewerAbsoluteCeilingMs } from '../src/reviewer-timeout-model.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  codexOAuthRequestBody,
  consumeCodexOAuthSse,
  readCodexOAuthCredential,
  reviewWithCodexOAuthResponses,
} from '../src/codex-oauth-responses.mjs';
import { __test__ as reviewerHarnessTest } from '../src/reviewer-harness.mjs';

function fakeJwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function sseResponse(events, init = {}) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status: 200, ...init });
}

test('readCodexOAuthCredential extracts ChatGPT account id without exposing token', () => {
  const token = fakeJwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
  });
  const result = readCodexOAuthCredential('/tmp/auth.json', {
    readFileImpl: () => JSON.stringify({ tokens: { access_token: token } }),
  });
  assert.deepEqual(result, { accessToken: token, accountId: 'acct_123' });
});

test('codexOAuthRequestBody preserves the exact review prompt and OAuth model', () => {
  const body = codexOAuthRequestBody({ prompt: 'review this diff', model: 'gpt-5.5', reasoningEffort: 'high' });
  assert.equal(body.model, 'gpt-5.5');
  assert.equal(body.input[0].content[0].text, 'review this diff');
  assert.equal(body.reasoning.effort, 'high');
  assert.equal(body.stream, true);
  assert.deepEqual(body.tools, []);
});

test('reviewWithCodexOAuthResponses returns SSE review text and normalized usage', async () => {
  const token = fakeJwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_456' },
  });
  let request = null;
  const result = await reviewWithCodexOAuthResponses('review prompt', {
    authPath: '/tmp/auth.json',
    model: 'gpt-5.5',
    readFileImpl: () => JSON.stringify({ tokens: { access_token: token } }),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return sseResponse([
        { type: 'response.output_text.delta', delta: '## Summary\n' },
        { type: 'response.output_text.delta', delta: 'Reviewed.\n' },
        {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              total_tokens: 14,
              input_tokens_details: { cached_tokens: 3 },
              output_tokens_details: { reasoning_tokens: 2 },
            },
          },
        },
      ]);
    },
    timeoutMs: 1_000,
    idleTimeoutMs: 1_000,
  });
  assert.equal(result.reviewText, '## Summary\nReviewed.\n');
  assert.deepEqual(result.tokenUsage, {
    input: 10,
    output: 4,
    reasoning: 2,
    cacheRead: 3,
    cacheWrite: 0,
    total: 14,
    source: 'codex-oauth-responses',
    usageTag: 'guardrail',
    guardrail: 14,
  });
  assert.equal(request.options.headers.authorization, `Bearer ${token}`);
  assert.equal(request.options.headers['chatgpt-account-id'], 'acct_456');
  assert.equal(JSON.parse(request.options.body).input[0].content[0].text, 'review prompt');
});

test('reviewWithCodexOAuthResponses fails closed on a rejected OAuth request', async () => {
  await assert.rejects(
    reviewWithCodexOAuthResponses('review prompt', {
      authPath: '/tmp/auth.json',
      model: 'gpt-5.5',
      readFileImpl: () => JSON.stringify({ tokens: { access_token: 'opaque-token' } }),
      fetchImpl: async () => new Response('{"error":"denied"}', { status: 401 }),
      timeoutMs: 1_000,
      idleTimeoutMs: 1_000,
    }),
    /HTTP 401/,
  );
});

test('native no-progress recovery is OAuth-only and never hijacks custom providers', () => {
  assert.equal(reviewerHarnessTest.shouldRecoverCodexWithOAuth({ progressTimedOut: true }, null), true);
  assert.equal(reviewerHarnessTest.shouldRecoverCodexWithOAuth({ progressTimedOut: true }, 'openai'), true);
  assert.equal(reviewerHarnessTest.shouldRecoverCodexWithOAuth({ progressTimedOut: true }, 'litellm'), false);
  assert.equal(reviewerHarnessTest.shouldRecoverCodexWithOAuth(new Error('ordinary failure'), null), false);
});

test('REVIEWERLEASECAP-02: OAuth wall and idle timers cannot exceed shared bounds', async t => {
  const delays = [];
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    delays.push(ms);
    return original(fn, ms, ...args);
  });
  await reviewWithCodexOAuthResponses('synthetic prompt', {
    authPath: '/synthetic/auth.json', model: 'synthetic-model',
    timeoutMs: 100_000_000, idleTimeoutMs: 100_000_000,
    readFileImpl: () => JSON.stringify({ tokens: { access_token: fakeJwt({}) } }),
    fetchImpl: async () => sseResponse([{ type: 'response.output_text.delta', delta: 'Synthetic review' }]),
  });
  assert.equal(delays[0], resolveReviewerAbsoluteCeilingMs());
  assert.ok(delays.slice(1).length > 0);
  assert.ok(delays.slice(1).every(ms => ms <= resolveProgressTimeoutMs()));
});

for (const [name, env, options, wallMs, idleMs] of [
  ['scoped defaults', { AGENT_OS_REVIEWER_CEILING_MAX_SECONDS: '60', ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '2500' },
    {}, 60_000, 2500],
  ['scoped clamps', { AGENT_OS_REVIEWER_CEILING_MAX_SECONDS: '60', ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '2500' },
    { timeoutMs: 100_000_000, idleTimeoutMs: 100_000_000 }, 60_000, 2500],
  ['shorter requests', { AGENT_OS_REVIEWER_CEILING_MAX_SECONDS: '60', ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '2500' },
    { timeoutMs: 1000, idleTimeoutMs: 500 }, 1000, 500],
  ['larger scoped bounds', { AGENT_OS_REVIEWER_CEILING_MAX_SECONDS: '14400', ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '1200000' },
    { timeoutMs: 100_000_000, idleTimeoutMs: 100_000_000 }, 14_400_000, 1_200_000],
]) {
  test(`OAuth transport and standalone SSE reader honor caller env: ${name}`, async t => {
    const delays = [];
    const original = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
      delays.push(ms);
      return original(fn, ms, ...args);
    });
    const response = () => sseResponse([{ type: 'response.output_text.delta', delta: 'Synthetic review' }]);
    const result = await reviewWithCodexOAuthResponses('synthetic prompt', {
      env,
      authPath: '/synthetic/auth.json',
      model: 'synthetic-model',
      readFileImpl: () => JSON.stringify({ tokens: { access_token: fakeJwt({}) } }),
      fetchImpl: async () => response(),
      ...options,
    });
    assert.equal(result.reviewText, 'Synthetic review');
    assert.equal(delays.shift(), wallMs);
    assert.ok(delays.length > 0);
    assert.ok(delays.every(ms => ms === idleMs));
    delays.length = 0;
    await consumeCodexOAuthSse(response(), { env, controller: new AbortController(), ...options });
    assert.ok(delays.length > 0);
    assert.ok(delays.every(ms => ms === idleMs));
  });
}
