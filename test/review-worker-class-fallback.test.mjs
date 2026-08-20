import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyReviewerWorkerClassFallbackToRoute,
  resolveReviewerWorkerClassWithFallback,
  reviewWorkerClassFallback,
} from '../src/review-worker-class-fallback.mjs';

function fleetStatusStub(rows) {
  const stdout = JSON.stringify({ providerStatuses: rows });
  return async () => ({ stdout });
}

const CODEX_EXHAUSTED_CLAUDE_OK = [
  { provider: 'openai', authPath: 'oauth', state: 'exhausted' },
  { provider: 'anthropic', authPath: 'oauth', state: 'ok' },
];
const CODEX_OK = [
  { provider: 'openai', authPath: 'oauth', state: 'ok' },
  { provider: 'anthropic', authPath: 'oauth', state: 'ok' },
];

test('falls back codex -> claude-code when the routed codex harness provider is exhausted', async () => {
  const result = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: fleetStatusStub(CODEX_EXHAUSTED_CLAUDE_OK),
  });
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.fellBack, true);
  assert.equal(result.reason, 'primary-grounded-fallback');
  assert.equal(result.primaryState, 'exhausted');
});

test('keeps the routed codex harness when codex has quota (auto-revert on recovery)', async () => {
  const result = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: fleetStatusStub(CODEX_OK),
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
  assert.equal(result.reason, 'primary-available');
});

test('never grounds on a soft/unknown signal (does not fall back when codex is only degraded)', async () => {
  const result = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: fleetStatusStub([
      { provider: 'openai', authPath: 'oauth', state: 'degraded' },
      { provider: 'anthropic', authPath: 'oauth', state: 'ok' },
    ]),
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
});

test('no fallback configured -> keeps the primary', async () => {
  const result = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: [],
    execFileImpl: fleetStatusStub(CODEX_EXHAUSTED_CLAUDE_OK),
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
  assert.equal(result.reason, 'no-fallback-configured');
});

test('fail-open: an unreadable fleet-quota status keeps the primary (never guesses a cap)', async () => {
  const result = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: async () => {
      throw new Error('hq unavailable');
    },
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
  assert.equal(result.reason, 'fleet-quota-status-unavailable');
});

test('rejects a fallback candidate equal to the PR author class (diversity preserved)', async () => {
  const result = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'claude-code',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: fleetStatusStub(CODEX_EXHAUSTED_CLAUDE_OK),
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
  assert.equal(result.reason, 'no-available-fallback');
});

test('does not read fleet quota status when no configured fallback is a viable alternate', async () => {
  const result = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'codex',
    primary: 'claude-code',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: async () => {
      throw new Error('fleet status should not be read');
    },
  });
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.fellBack, false);
  assert.equal(result.reason, 'no-available-fallback');
});

test('reviewWorkerClassFallback defaults to [claude-code] and honors the env override', () => {
  assert.deepEqual(reviewWorkerClassFallback({}), ['claude-code']);
  assert.deepEqual(
    reviewWorkerClassFallback({ ADVERSARIAL_REVIEW_REVIEWER_WORKER_CLASS_FALLBACK: 'claude-code, gemini' }),
    ['claude-code', 'gemini'],
  );
  assert.deepEqual(reviewWorkerClassFallback({ ADVERSARIAL_REVIEW_REVIEWER_WORKER_CLASS_FALLBACK: '' }), []);
});

test('applies fallback route with explicit worker-class precedence and model-key lookup', () => {
  const result = applyReviewerWorkerClassFallbackToRoute({
    route: {
      reviewerModel: 'codex',
      botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
      reviewerWorkerClass: 'codex',
      workerClass: 'codex',
    },
    decision: {
      fellBack: true,
      workerClass: 'claude-code',
      from: 'codex',
      to: 'claude-code',
      reason: 'primary-grounded-fallback',
    },
    reviewerRouteByModel: {
      claude: {
        reviewerModel: 'claude',
        botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
      },
    },
  });

  assert.equal(result.applied, true);
  assert.equal(result.route.workerClass, undefined);
  assert.equal(result.route.reviewerWorkerClass, 'claude-code');
  assert.equal(result.route.reviewerModel, 'claude');
  assert.equal(result.route.botTokenEnv, 'GH_CLAUDE_REVIEWER_TOKEN');
  assert.deepEqual(result.route.reviewWorkerClassFallback, {
    fromWorkerClass: 'codex',
    toWorkerClass: 'claude-code',
    reason: 'primary-grounded-fallback',
  });
});

test('does not apply or claim fallback success when the worker class has no model route', () => {
  const route = { reviewerModel: 'codex', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' };
  const result = applyReviewerWorkerClassFallbackToRoute({
    route,
    decision: {
      fellBack: true,
      workerClass: 'unknown-worker',
      from: 'codex',
      to: 'unknown-worker',
      reason: 'primary-grounded-fallback',
    },
    reviewerRouteByModel: {},
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, 'fallback-route-unavailable');
  assert.equal(result.route, route);
});
