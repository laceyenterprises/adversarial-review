import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
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

test('watcher passes reviewer worker classes to quota fallback and records worker-class breadcrumbs', () => {
  const source = readFileSync(new URL('../src/pollonce-phases.mjs', import.meta.url), 'utf8');
  const fallbackStart = source.indexOf('const primaryReviewerWorkerClass = reviewerWorkerClassForRoute(route);');
  const fallbackEnd = source.indexOf('if (rwfDecision.fellBack) {', fallbackStart);
  assert.notEqual(fallbackStart, -1);
  assert.notEqual(fallbackEnd, -1);
  const fallbackBlock = source.slice(fallbackStart, fallbackEnd);
  assert.match(fallbackBlock, /primary:\s*primaryReviewerWorkerClass/);
  assert.doesNotMatch(fallbackBlock, /primary:\s*route\.reviewerModel/);

  const breadcrumbStart = source.indexOf('reviewWorkerClassFallback: {', fallbackEnd);
  const breadcrumbEnd = source.indexOf('reason: rwfDecision.reason', breadcrumbStart);
  assert.notEqual(breadcrumbStart, -1);
  assert.notEqual(breadcrumbEnd, -1);
  const breadcrumbBlock = source.slice(breadcrumbStart, breadcrumbEnd);
  assert.match(breadcrumbBlock, /fromWorkerClass:\s*rwfDecision\.from/);
  assert.match(breadcrumbBlock, /toWorkerClass:\s*rwfDecision\.to/);
  assert.doesNotMatch(breadcrumbBlock, /fromReviewerModel|toReviewerModel/);
});
