import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseReviewerQuotaExhaustion,
  quotaFallbackDecision,
  parseDurationToMs,
} from '../src/reviewer-quota-signal.mjs';

const NOW = Date.parse('2026-07-06T23:00:00Z');

test('CQP broker no-credit body WITH reset_at surfaces the reset time', () => {
  // Shape modeled on the CQP /checkout deny body (reason/type + weekly reset).
  const brokerBody = {
    type: 'no-credit',
    reason: 'no credential with remaining quota is available',
    window: 'weekly',
    reset_at: '2026-07-13T00:00:00Z',
  };
  const sig = parseReviewerQuotaExhaustion({ brokerBody, nowMs: NOW });
  assert.equal(sig.exhausted, true);
  assert.equal(sig.resetAt, '2026-07-13T00:00:00.000Z');
  assert.equal(sig.source, 'cqp-broker');
  assert.ok(sig.retryAfterMs > 0);
});

test('CQP broker no-credit WITHOUT a reset is still detected (resetAt null)', () => {
  const sig = parseReviewerQuotaExhaustion({
    brokerBody: { reason: 'no-credit' },
    nowMs: NOW,
  });
  assert.equal(sig.exhausted, true);
  assert.equal(sig.resetAt, null);
  assert.equal(sig.retryAfterMs, null);
  assert.equal(sig.source, 'cqp-broker');
});

test('GeminiCredentialPoolNoCreditError flag alone marks exhausted', () => {
  const err = Object.assign(new Error('Gemini credential checkout deferred: no-credit'), {
    isGeminiCredentialPoolNoCredit: true,
  });
  const sig = parseReviewerQuotaExhaustion({ error: err, nowMs: NOW });
  assert.equal(sig.exhausted, true);
});

test('antigravity RESOURCE_EXHAUSTED with google.rpc.RetryInfo.retryDelay', () => {
  // Real Gemini API 429 shape: RetryInfo detail carries retryDelay.
  const err = Object.assign(new Error('gemini exec failed'), {
    stderr: JSON.stringify({
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message: 'Resource has been exhausted (e.g. check quota).',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '39s',
          },
        ],
      },
    }),
  });
  const sig = parseReviewerQuotaExhaustion({ error: err, nowMs: NOW });
  assert.equal(sig.exhausted, true);
  assert.equal(sig.retryAfterMs, 39000);
  assert.equal(sig.resetAt, new Date(NOW + 39000).toISOString());
  assert.equal(sig.source, 'antigravity-429');
});

test('antigravity retryDelay parsed from loose 429 text', () => {
  const sig = parseReviewerQuotaExhaustion({
    stderr: 'Error 429 RESOURCE_EXHAUSTED ... "retryDelay": "12s" ...',
    nowMs: NOW,
  });
  assert.equal(sig.exhausted, true);
  assert.equal(sig.retryAfterMs, 12000);
  assert.equal(sig.source, 'antigravity-429');
});

test('HTTP-date Retry-After text derives reset and retry delay', () => {
  const sig = parseReviewerQuotaExhaustion({
    stderr: 'HTTP 429 RESOURCE_EXHAUSTED\nRetry-After: Tue, 07 Jul 2026 00:00:30 GMT',
    nowMs: NOW,
  });
  assert.equal(sig.exhausted, true);
  assert.equal(sig.retryAfterMs, 3630000);
  assert.equal(sig.resetAt, '2026-07-07T00:00:30.000Z');
  assert.equal(sig.source, 'antigravity-429');
});

test('ANSI-colored quota diagnostics are normalized before matching', () => {
  const sig = parseReviewerQuotaExhaustion({
    stderr: '\u001b[31mRESOURCE_EXHAUSTED\u001b[0m retryDelay: 5s',
    nowMs: NOW,
  });
  assert.equal(sig.exhausted, true);
  assert.equal(sig.retryAfterMs, 5000);
  assert.equal(sig.source, 'antigravity-429');
});

test('primitive string errors contribute quota diagnostic text', () => {
  const sig = parseReviewerQuotaExhaustion({
    error: 'HTTP 429 RESOURCE_EXHAUSTED retryDelay: 7s',
    nowMs: NOW,
  });
  assert.equal(sig.exhausted, true);
  assert.equal(sig.retryAfterMs, 7000);
  assert.equal(sig.source, 'antigravity-429');
});

test('standalone PR number 429 does not trigger quota fallback', () => {
  const sig = parseReviewerQuotaExhaustion({
    stdout: 'Checking out PR 429\nFixes #429\nWrote 429 bytes',
    nowMs: NOW,
  });
  assert.equal(sig.exhausted, false);
  assert.equal(sig.resetAt, null);
  assert.equal(sig.source, null);
});

test('contextual HTTP 429 text still triggers quota fallback', () => {
  const sig = parseReviewerQuotaExhaustion({
    stderr: 'HTTP 429 from reviewer runtime; retryDelay: 100 milliseconds',
    nowMs: NOW,
  });
  assert.equal(sig.exhausted, true);
  assert.equal(sig.retryAfterMs, 100);
  assert.equal(sig.resetAt, new Date(NOW + 100).toISOString());
  assert.equal(sig.source, 'antigravity-429');
});

test('coarse quota text with no reset is exhausted with source=text', () => {
  const sig = parseReviewerQuotaExhaustion({
    stderr: 'rate limit reached for this account',
    nowMs: NOW,
  });
  assert.equal(sig.exhausted, true);
  assert.equal(sig.resetAt, null);
  assert.equal(sig.source, 'text');
});

test('stdout PR content mentioning quota does not trigger quota fallback', () => {
  const sig = parseReviewerQuotaExhaustion({
    error: new Error('ECONNRESET socket hang up'),
    stdout: 'PR body: document quota behavior and retryDelay: 100000000000000000000s',
    stderr: 'network blip',
    nowMs: NOW,
  });
  assert.equal(sig.exhausted, false);
  assert.equal(sig.resetAt, null);
  assert.equal(sig.retryAfterMs, null);
  assert.equal(sig.source, null);
});

test('oversized diagnostic retryDelay does not throw when reset date is invalid', () => {
  const sig = parseReviewerQuotaExhaustion({
    stderr: 'HTTP 429 RESOURCE_EXHAUSTED retryDelay: 100000000000000000000s',
    nowMs: NOW,
  });
  assert.equal(sig.exhausted, true);
  assert.equal(sig.resetAt, null);
  assert.equal(sig.retryAfterMs, 1e+23);
  assert.equal(sig.source, 'antigravity-429');
});

test('non-quota error is not exhausted', () => {
  const sig = parseReviewerQuotaExhaustion({
    error: new Error('ECONNRESET socket hang up'),
    stderr: 'network blip',
    nowMs: NOW,
  });
  assert.equal(sig.exhausted, false);
  assert.equal(sig.resetAt, null);
  assert.equal(sig.source, null);
});

test('parseDurationToMs handles s/ms/m and bare seconds', () => {
  assert.equal(parseDurationToMs('39s'), 39000);
  assert.equal(parseDurationToMs('500ms'), 500);
  assert.equal(parseDurationToMs('100 milliseconds'), 100);
  assert.equal(parseDurationToMs('3 seconds'), 3000);
  assert.equal(parseDurationToMs('2m'), 120000);
  assert.equal(parseDurationToMs('2 minutes'), 120000);
  assert.equal(parseDurationToMs('1.5s'), 1500);
  assert.equal(parseDurationToMs('42'), 42000); // bare number = seconds
  assert.equal(parseDurationToMs(''), null);
  assert.equal(parseDurationToMs('nonsense'), null);
  assert.equal(parseDurationToMs(['42']), null);
  assert.equal(parseDurationToMs(true), null);
});

test('stringified epoch reset timestamp is parsed through epoch heuristic', () => {
  const sig = parseReviewerQuotaExhaustion({
    brokerBody: { reason: 'no-credit', reset_at: '1719878400' },
    nowMs: NOW,
  });
  assert.equal(sig.exhausted, true);
  assert.equal(sig.resetAt, '2024-07-02T00:00:00.000Z');
});

test('nested response data error objects contribute reset and retry delay fields', () => {
  const err = Object.assign(new Error('request failed'), {
    response: {
      data: {
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          resetAt: '2026-07-07T01:00:00Z',
          details: [{ retryDelay: '2m' }],
        },
      },
    },
  });
  const sig = parseReviewerQuotaExhaustion({ error: err, nowMs: NOW });
  assert.equal(sig.exhausted, true);
  assert.equal(sig.resetAt, '2026-07-07T01:00:00.000Z');
  assert.equal(sig.retryAfterMs, 120000);
});

test('non-scalar structured retry fields are ignored', () => {
  const sig = parseReviewerQuotaExhaustion({
    brokerBody: {
      reason: 'no-credit',
      retryAfter: ['30s'],
      retryAfterMs: true,
    },
    nowMs: NOW,
  });
  assert.equal(sig.exhausted, true);
  assert.equal(sig.retryAfterMs, null);
  assert.equal(sig.resetAt, null);
  assert.equal(sig.source, 'cqp-broker');
});

test('message-only structured quota bodies are detected without text fallback', () => {
  const sig = parseReviewerQuotaExhaustion({
    brokerBody: { error: { message: 'quota exhausted for this account' } },
    nowMs: NOW,
  });
  assert.equal(sig.exhausted, true);
  assert.equal(sig.source, 'cqp-broker');
});

test('quotaFallbackDecision: exhausted + primary available -> fall back, skip until reset', () => {
  const signal = parseReviewerQuotaExhaustion({
    brokerBody: { reason: 'no-credit', reset_at: '2026-07-13T00:00:00Z' },
    nowMs: NOW,
  });
  const d = quotaFallbackDecision({ signal, primaryReviewerAvailable: true });
  assert.equal(d.fallbackToPrimary, true);
  assert.equal(d.skipReviewerUntil, '2026-07-13T00:00:00.000Z');
  assert.equal(d.reason, 'reviewer-quota-exhausted-fallback-to-primary');
});

test('quotaFallbackDecision: exhausted + NO primary -> do not orphan-silently, no fallback', () => {
  const signal = parseReviewerQuotaExhaustion({ brokerBody: { reason: 'no-credit' }, nowMs: NOW });
  const d = quotaFallbackDecision({ signal, primaryReviewerAvailable: false });
  assert.equal(d.fallbackToPrimary, false);
  assert.equal(d.reason, 'reviewer-quota-exhausted-no-primary-available');
});

test('quotaFallbackDecision: not exhausted -> no fallback', () => {
  const d = quotaFallbackDecision({ signal: { exhausted: false }, primaryReviewerAvailable: true });
  assert.equal(d.fallbackToPrimary, false);
  assert.equal(d.reason, 'not-exhausted');
});
