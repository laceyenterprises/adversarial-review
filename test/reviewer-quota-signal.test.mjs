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

test('coarse quota text with no reset is exhausted with source=text', () => {
  const sig = parseReviewerQuotaExhaustion({
    stderr: 'rate limit reached for this account',
    nowMs: NOW,
  });
  assert.equal(sig.exhausted, true);
  assert.equal(sig.resetAt, null);
  assert.equal(sig.source, 'text');
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
  assert.equal(parseDurationToMs('2m'), 120000);
  assert.equal(parseDurationToMs('1.5s'), 1500);
  assert.equal(parseDurationToMs('42'), 42000); // bare number = seconds
  assert.equal(parseDurationToMs(''), null);
  assert.equal(parseDurationToMs('nonsense'), null);
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
