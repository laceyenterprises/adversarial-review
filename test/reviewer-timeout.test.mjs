import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_AGY_PRINT_TIMEOUT_MS,
  DEFAULT_PROGRESS_TIMEOUT_MS,
  DEFAULT_REVIEWER_TIMEOUT_MS,
  resolveAgyPrintTimeoutMs,
  resolveProgressTimeoutMs,
  resolveReviewerTimeoutMs,
} from '../src/reviewer-timeout.mjs';
import { AgentOSConfigError } from '../src/config-loader.mjs';

// Guards the subprocess timeout that protects spawnCaptured around the
// reviewer CLI calls. Raised 10m -> 20m on 2026-05-10 after PR #331 hit
// the 10m wall on a substantive spec diff. A future revert that drops
// it below 20m needs to fail this test, not silently shorten review
// budgets again. The progress timeout guards the separate no-output watchdog.
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

test('resolveReviewerTimeoutMs falls back for integer non-positive overrides', () => {
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '0' }), DEFAULT_REVIEWER_TIMEOUT_MS);
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '-1000' }), DEFAULT_REVIEWER_TIMEOUT_MS);
});

test('resolveReviewerTimeoutMs fails loud for non-integer env overrides', () => {
  assert.throws(
    () => resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: 'not-a-number' }),
    AgentOSConfigError
  );
  assert.throws(
    () => resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '120000.7' }),
    AgentOSConfigError
  );
});

test('default reviewer progress timeout is 15 minutes', () => {
  assert.equal(DEFAULT_PROGRESS_TIMEOUT_MS, 15 * 60 * 1000);
});

test('resolveProgressTimeoutMs follows the reviewer env override parser shape', () => {
  assert.equal(resolveProgressTimeoutMs({}), DEFAULT_PROGRESS_TIMEOUT_MS);
  assert.equal(resolveProgressTimeoutMs({ ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '2500' }), 2500);
  assert.throws(
    () => resolveProgressTimeoutMs({ ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '' }),
    AgentOSConfigError
  );
  assert.throws(
    () => resolveProgressTimeoutMs({ ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '2500.9' }),
    AgentOSConfigError
  );
  assert.throws(
    () => resolveProgressTimeoutMs({ ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '0' }),
    AgentOSConfigError
  );
  assert.throws(
    () => resolveProgressTimeoutMs({ ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: 'nope' }),
    AgentOSConfigError
  );
});

test('default agy print timeout is independently below the reviewer wall timeout', () => {
  assert.equal(DEFAULT_AGY_PRINT_TIMEOUT_MS, 19.5 * 60 * 1000);
  assert.equal(resolveAgyPrintTimeoutMs({}), DEFAULT_AGY_PRINT_TIMEOUT_MS);
  assert.ok(resolveAgyPrintTimeoutMs({}) < resolveReviewerTimeoutMs({}));
});

test('resolveAgyPrintTimeoutMs honors independent antigravity env aliases', () => {
  assert.equal(
    resolveAgyPrintTimeoutMs({ AGENT_OS_REVIEWER_GEMINI_AGY_PRINT_TIMEOUT_MS: '2400000' }),
    2_400_000
  );
  assert.equal(
    resolveAgyPrintTimeoutMs({ ADVERSARIAL_REVIEWER_AGY_PRINT_TIMEOUT_MS: '1800000' }),
    1_800_000
  );
  assert.equal(resolveAgyPrintTimeoutMs({ AGY_PRINT_TIMEOUT_MS: '120000' }), 120_000);
});

test('resolveAgyPrintTimeoutMs is independent of shared reviewer timeout', () => {
  assert.equal(
    resolveAgyPrintTimeoutMs({
      ADVERSARIAL_REVIEWER_TIMEOUT_MS: '60000',
      ADVERSARIAL_REVIEWER_AGY_PRINT_TIMEOUT_MS: '1800000',
    }),
    1_800_000
  );
});
