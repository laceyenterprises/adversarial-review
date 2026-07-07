// Reviewer token capture must match session-ledger fidelity: input, cache_read,
// output, reasoning, tool_use — for BOTH the codex reviewer shape and the gemini
// usageMetadata shape. Previously reasoning_output_tokens was dropped and gemini
// usage was unrecognized (bucketed as claude).
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCodexJsonTokenUsage } from '../src/adapters/reviewer-runtime/cli-direct/index.mjs';
import { normalizeReviewerClass, normalizeTokenUsage } from '../src/reviewer-pass-tokens.mjs';
import { __test__ } from '../src/reviewer.mjs';

const { estimateTokensFromText } = __test__;

test('codex reviewer usage captures reasoning (was dropped)', () => {
  const line = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 5000,
          cached_input_tokens: 1200,
          output_tokens: 400,
          reasoning_output_tokens: 350,
          total_tokens: 5400,
        },
      },
    },
  });
  const usage = parseCodexJsonTokenUsage(line);
  assert.equal(usage.input, 5000);
  assert.equal(usage.output, 400);
  assert.equal(usage.reasoning, 350, 'reasoning_output_tokens must be captured');
  assert.equal(usage.cacheRead, 1200);
  assert.equal(usage.source, 'codex-json');
});

test('gemini reviewer usageMetadata is captured with full breakdown', () => {
  const line = JSON.stringify({
    usageMetadata: {
      promptTokenCount: 8000,
      candidatesTokenCount: 120,
      thoughtsTokenCount: 90,
      cachedContentTokenCount: 2000,
      toolUsePromptTokenCount: 40,
      totalTokenCount: 8210,
    },
  });
  const usage = parseCodexJsonTokenUsage(line);
  assert.equal(usage.input, 8000);
  assert.equal(usage.output, 120 + 90, 'inclusive output = candidates + thoughts');
  assert.equal(usage.reasoning, 90);
  assert.equal(usage.cacheRead, 2000);
  assert.equal(usage.toolContext, 40, 'tool-use tokens captured');
  assert.equal(usage.source, 'gemini-json');
  assert.equal(usage.usageTag, undefined, 'gemini usage must not be tagged as guardrail');
  assert.equal(usage.guardrail, undefined, 'gemini usage must not synthesize guardrail totals');
});

test('normalizeTokenUsage carries reasoning + toolContext through', () => {
  const n = normalizeTokenUsage({
    input: 10,
    output: 5,
    reasoning: 3,
    toolContext: 2,
    cacheRead: 4,
  });
  assert.equal(n.reasoning, 3);
  assert.equal(n.toolContext, 2);
  assert.equal(n.input, 10);
  assert.equal(n.cacheRead, 4);
});

test('normalizeTokenUsage persists a reasoning-only usage (not dropped as empty)', () => {
  const n = normalizeTokenUsage({ reasoning: 7 });
  assert.ok(n, 'a usage with only reasoning must not normalize to null');
  assert.equal(n.reasoning, 7);
});

test('estimateTokensFromText is a ~4-chars/token floor', () => {
  assert.equal(estimateTokensFromText(''), 0);
  assert.equal(estimateTokensFromText('a'.repeat(400)), 100);
  assert.equal(estimateTokensFromText(null), 0);
});

test('antigravity estimate reviewer.token_usage flows through parser + normalize', () => {
  // agy reviewers have no native usage; reviewer.mjs emits this estimate line.
  const line = JSON.stringify({
    type: 'reviewer.token_usage',
    tokenUsage: {
      input: 2000,
      output: 300,
      reasoning: null,
      cacheRead: null,
      cacheWrite: 0,
      toolContext: null,
      total: 2300,
      source: 'gemini-antigravity-estimate',
    },
  });
  const parsed = parseCodexJsonTokenUsage(line);
  assert.equal(parsed.input, 2000);
  assert.equal(parsed.output, 300);
  assert.equal(parsed.source, 'gemini-antigravity-estimate', 'estimate source preserved');
  const n = normalizeTokenUsage(parsed);
  assert.equal(n.input, 2000);
  assert.equal(n.output, 300);
  assert.equal(n.source, 'gemini-antigravity-estimate');
});

test('normalizeReviewerClass recognizes gemini / antigravity', () => {
  assert.equal(normalizeReviewerClass('gemini-2.5-pro'), 'gemini');
  assert.equal(normalizeReviewerClass('Gemini 3.1 Pro (High)'), 'gemini');
  assert.equal(normalizeReviewerClass('antigravity'), 'gemini');
  assert.equal(normalizeReviewerClass('agy'), 'gemini');
  // regression: codex/claude unchanged
  assert.equal(normalizeReviewerClass('codex'), 'codex');
  assert.equal(normalizeReviewerClass('gpt-5'), 'codex');
  assert.equal(normalizeReviewerClass('claude-opus'), 'claude');
});
