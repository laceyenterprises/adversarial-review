import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reviewPopulationRetryDecision } from '../src/watcher.mjs';
import { reviewPopulationFailureClass } from '../src/reviewer-failure-classification.mjs';
import { resolveReviewPopulationRetryConfig } from '../src/role-config.mjs';

function failedPopulationRow(overrides = {}) {
  return {
    review_status: 'failed',
    failed_at: '2026-06-22T10:00:00.000Z',
    failure_message: 'Reviewer session abc123 is no longer alive and no GitHub review was found',
    review_population_retry_attempts: 0,
    review_population_retry_head_sha: 'head-a',
    ...overrides,
  };
}

test('review-population failure waits for backoff, retries up to budget, then exhausts durably', () => {
  const config = { maxAttempts: 2, backoffSeconds: 30 };
  const beforeBackoff = reviewPopulationRetryDecision(failedPopulationRow(), {
    config,
    headSha: 'head-a',
    nowMs: Date.parse('2026-06-22T10:00:10.000Z'),
  });
  assert.equal(beforeBackoff.action, 'wait');
  assert.equal(beforeBackoff.waitUntilMs, Date.parse('2026-06-22T10:00:30.000Z'));

  const firstRetry = reviewPopulationRetryDecision(failedPopulationRow(), {
    config,
    headSha: 'head-a',
    nowMs: Date.parse('2026-06-22T10:00:31.000Z'),
  });
  assert.equal(firstRetry.action, 'retry');
  assert.equal(firstRetry.attempts, 0);

  const exhausted = reviewPopulationRetryDecision(failedPopulationRow({
    review_population_retry_attempts: 2,
  }), {
    config,
    headSha: 'head-a',
    nowMs: Date.parse('2026-06-22T10:05:00.000Z'),
  });
  assert.equal(exhausted.action, 'exhausted');
  assert.equal(exhausted.attempts, 2);
});

test('review-population retry max_attempts=0 preserves immediate skip behavior', () => {
  const decision = reviewPopulationRetryDecision(failedPopulationRow(), {
    config: { maxAttempts: 0, backoffSeconds: 0 },
    headSha: 'head-a',
    nowMs: Date.parse('2026-06-22T10:05:00.000Z'),
  });
  assert.equal(decision.action, 'exhausted');
  assert.equal(decision.maxAttempts, 0);
});

test('review-population retry budget is scoped to the current head', () => {
  const decision = reviewPopulationRetryDecision(failedPopulationRow({
    review_population_retry_attempts: 2,
    review_population_retry_head_sha: 'old-head',
  }), {
    config: { maxAttempts: 2, backoffSeconds: 0 },
    headSha: 'new-head',
    nowMs: Date.parse('2026-06-22T10:05:00.000Z'),
  });
  assert.equal(decision.action, 'retry');
  assert.equal(decision.attempts, 0);
});

test('non-population non-recoverable failures are not retried by population path', () => {
  assert.equal(
    reviewPopulationFailureClass(failedPopulationRow({
      failure_message: '[unknown] generated-but-not-posted: reviewer output never reached GitHub',
    })),
    'generated-but-not-posted',
  );
  const row = failedPopulationRow({
    failure_message: 'malformed title: missing recognized builder prefix',
  });
  assert.equal(reviewPopulationFailureClass(row), null);
  assert.deepEqual(
    reviewPopulationRetryDecision(row, {
      config: { maxAttempts: 1, backoffSeconds: 0 },
      headSha: 'head-a',
    }),
    { retryable: false, action: 'not-population-failure', failureClass: null },
  );
});

test('review-population retry config resolves default, file, and env alias', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'review-population-retry-cfg-'));
  try {
    const modulePath = join(tmp, 'config.yaml');
    writeFileSync(modulePath, 'reviewer:\n  review_population_retry:\n    max_attempts: 3\n    backoff_seconds: 12\n');

    assert.deepEqual(resolveReviewPopulationRetryConfig({
      env: {},
      topPath: '/dev/null',
      modulePaths: [join(tmp, 'missing.yaml')],
    }), { maxAttempts: 1, backoffSeconds: 45 });

    assert.deepEqual(resolveReviewPopulationRetryConfig({
      env: {},
      topPath: '/dev/null',
      modulePaths: [modulePath],
    }), { maxAttempts: 3, backoffSeconds: 12 });

    assert.deepEqual(resolveReviewPopulationRetryConfig({
      env: {
        ADVERSARIAL_REVIEW_POPULATION_RETRY_MAX_ATTEMPTS: '4',
        ADVERSARIAL_REVIEW_POPULATION_RETRY_BACKOFF_SECONDS: '9',
      },
      topPath: '/dev/null',
      modulePaths: [modulePath],
    }), { maxAttempts: 4, backoffSeconds: 9 });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
