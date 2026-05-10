import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_REVIEWER_TIMEOUT_MS,
  resolveReviewerTimeoutMs,
} from '../src/reviewer-timeout.mjs';

// Guards the subprocess timeout that protects spawnCaptured around the
// reviewer CLI calls. Raised 10m → 20m on 2026-05-10 after PR #331 hit
// the 10m wall on a substantive spec diff. A future revert that drops
// it below 20m needs to fail this test, not silently shorten review
// budgets again.
test('default reviewer timeout is 20 minutes', () => {
  assert.equal(DEFAULT_REVIEWER_TIMEOUT_MS, 20 * 60 * 1000);
});

test('resolveReviewerTimeoutMs falls back to default when env is unset', () => {
  assert.equal(resolveReviewerTimeoutMs({}), DEFAULT_REVIEWER_TIMEOUT_MS);
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '' }), DEFAULT_REVIEWER_TIMEOUT_MS);
});

test('resolveReviewerTimeoutMs honors a positive env override', () => {
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '60000' }), 60000);
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '1800000' }), 1800000);
});

test('resolveReviewerTimeoutMs rejects non-positive / non-numeric overrides and falls back to default', () => {
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '0' }), DEFAULT_REVIEWER_TIMEOUT_MS);
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '-1000' }), DEFAULT_REVIEWER_TIMEOUT_MS);
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: 'not-a-number' }), DEFAULT_REVIEWER_TIMEOUT_MS);
});

test('resolveReviewerTimeoutMs floors fractional millisecond values', () => {
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '120000.7' }), 120000);
});
