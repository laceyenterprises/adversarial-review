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
  const errors = [];
  const result = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: async () => {
      throw new Error('hq unavailable');
    },
    logger: { error: (message) => errors.push(String(message)) },
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
  assert.equal(result.reason, 'fleet-quota-status-unavailable');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /quota-status unavailable/);
  assert.match(errors[0], /failing open/);
});

test('fail-open: malformed fleet-quota status stdout keeps the primary', async () => {
  const errors = [];
  const result = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: async () => ({ stdout: 'not json and no object' }),
    logger: { error: (message) => errors.push(String(message)) },
  });

  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
  assert.equal(result.reason, 'fleet-quota-status-parse-error');
  assert.match(result.error, /did not return JSON|Unexpected/);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /parse failed/);
  assert.match(errors[0], /failing open/);
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

test('retries transient fleet quota status failures with bounded backoff before falling back', async () => {
  const warnings = [];
  const errors = [];
  const sleeps = [];
  let calls = 0;
  const transient = new Error('temporary EIO');
  transient.code = 'EIO';

  const result = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    retryDelaysMs: [5, 10],
    sleepImpl: async (ms) => sleeps.push(ms),
    logger: {
      warn: (message) => warnings.push(String(message)),
      error: (message) => errors.push(String(message)),
    },
    execFileImpl: async () => {
      calls += 1;
      if (calls === 1) throw transient;
      return { stdout: JSON.stringify({ providerStatuses: CODEX_EXHAUSTED_CLAUDE_OK }) };
    },
  });

  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [5]);
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /transient failure/);
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.fellBack, true);
});

test('retries execFile subprocess failures whose transient diagnostic is only in stderr/message', async () => {
  const warnings = [];
  const errors = [];
  const sleeps = [];
  let calls = 0;
  const subprocessFailure = new Error('Command failed: hq fleet quota status --json');
  subprocessFailure.code = 1;
  subprocessFailure.stderr = Buffer.from('TLS handshake timeout while reading fleet quota status');
  subprocessFailure.stdout = '';

  const result = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    retryDelaysMs: [5, 10],
    sleepImpl: async (ms) => sleeps.push(ms),
    logger: {
      warn: (message) => warnings.push(String(message)),
      error: (message) => errors.push(String(message)),
    },
    execFileImpl: async () => {
      calls += 1;
      if (calls === 1) throw subprocessFailure;
      return { stdout: JSON.stringify({ providerStatuses: CODEX_EXHAUSTED_CLAUDE_OK }) };
    },
  });

  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [5]);
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /transient failure/);
  assert.match(warnings[0], /TLS handshake timeout/);
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.fellBack, true);
});

test('retries execFile subprocess failures whose transient diagnostic is only in stdout', async () => {
  const warnings = [];
  const errors = [];
  const sleeps = [];
  let calls = 0;
  const subprocessFailure = new Error('Command failed: hq fleet quota status --json');
  subprocessFailure.code = 1;
  subprocessFailure.stderr = '';
  subprocessFailure.stdout = 'HTTP 503 service unavailable from fleet quota status';

  const result = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    retryDelaysMs: [5],
    sleepImpl: async (ms) => sleeps.push(ms),
    logger: {
      warn: (message) => warnings.push(String(message)),
      error: (message) => errors.push(String(message)),
    },
    execFileImpl: async () => {
      calls += 1;
      if (calls === 1) throw subprocessFailure;
      return { stdout: JSON.stringify({ providerStatuses: CODEX_EXHAUSTED_CLAUDE_OK }) };
    },
  });

  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [5]);
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /HTTP 503 service unavailable/);
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.fellBack, true);
});

test('does not retry non-transient fleet quota status failures but logs the fail-open state', async () => {
  const errors = [];
  const sleeps = [];
  let calls = 0;
  const missingBinary = new Error('spawn hq ENOENT');
  missingBinary.code = 'ENOENT';

  const result = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    retryDelaysMs: [5, 10],
    sleepImpl: async (ms) => sleeps.push(ms),
    logger: { error: (message) => errors.push(String(message)) },
    execFileImpl: async () => {
      calls += 1;
      throw missingBinary;
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
  assert.equal(result.reason, 'fleet-quota-status-unavailable');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ENOENT/);
  assert.match(errors[0], /failing open/);
});

test('shares one successful fleet quota status read across nearby subjects', async () => {
  const cache = new Map();
  let calls = 0;
  let now = 1_000;
  const execFileImpl = async () => {
    calls += 1;
    return { stdout: JSON.stringify({ providerStatuses: CODEX_EXHAUSTED_CLAUDE_OK }) };
  };

  const first = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl,
    fleetQuotaStatusCache: cache,
    fleetQuotaStatusCacheTtlMs: 10_000,
    nowMs: () => now,
  });
  now += 500;
  const second = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl,
    fleetQuotaStatusCache: cache,
    fleetQuotaStatusCacheTtlMs: 10_000,
    nowMs: () => now,
  });

  assert.equal(calls, 1);
  assert.equal(first.workerClass, 'claude-code');
  assert.equal(second.workerClass, 'claude-code');
});

test('shares one in-flight fleet quota status read across concurrent subjects', async () => {
  const cache = new Map();
  let calls = 0;
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const execFileImpl = async () => {
    calls += 1;
    await ready;
    return { stdout: JSON.stringify({ providerStatuses: CODEX_EXHAUSTED_CLAUDE_OK }) };
  };

  const args = {
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl,
    fleetQuotaStatusCache: cache,
    fleetQuotaStatusCacheTtlMs: 10_000,
    nowMs: () => 1_000,
  };
  const first = resolveReviewerWorkerClassWithFallback(args);
  const second = resolveReviewerWorkerClassWithFallback(args);

  assert.equal(calls, 1);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(firstResult.workerClass, 'claude-code');
  assert.equal(secondResult.workerClass, 'claude-code');
});

test('does not let an expired in-flight status read clobber a newer cache result', async () => {
  const cache = new Map();
  let calls = 0;
  let now = 1_000;
  let releaseFirst;
  let releaseSecond;
  const firstReady = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const secondReady = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  const execFileImpl = async () => {
    calls += 1;
    if (calls === 1) {
      await firstReady;
      return { stdout: JSON.stringify({ providerStatuses: CODEX_EXHAUSTED_CLAUDE_OK }) };
    }
    await secondReady;
    return { stdout: JSON.stringify({ providerStatuses: CODEX_OK }) };
  };

  const args = {
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl,
    fleetQuotaStatusCache: cache,
    fleetQuotaStatusCacheTtlMs: 5,
    nowMs: () => now,
  };

  const first = resolveReviewerWorkerClassWithFallback(args);
  assert.equal(calls, 1);
  now += 10;
  const second = resolveReviewerWorkerClassWithFallback(args);
  assert.equal(calls, 2);

  releaseSecond();
  const secondResult = await second;
  assert.equal(secondResult.workerClass, 'codex');

  releaseFirst();
  const firstResult = await first;
  assert.equal(firstResult.workerClass, 'claude-code');

  now += 1;
  const thirdResult = await resolveReviewerWorkerClassWithFallback(args);
  assert.equal(calls, 2);
  assert.equal(thirdResult.workerClass, 'codex');
});

test('does not retain an unavailable in-flight fleet quota status result in cache', async () => {
  const cache = new Map();
  let calls = 0;
  const errors = [];
  const execFileImpl = async () => {
    calls += 1;
    throw new Error('permanent quota status failure');
  };

  const args = {
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl,
    fleetQuotaStatusCache: cache,
    fleetQuotaStatusCacheTtlMs: 10_000,
    retryDelaysMs: [],
    logger: { error: (message) => errors.push(String(message)) },
    nowMs: () => 1_000,
  };

  await Promise.all([
    resolveReviewerWorkerClassWithFallback(args),
    resolveReviewerWorkerClassWithFallback(args),
  ]);
  await resolveReviewerWorkerClassWithFallback(args);

  assert.equal(calls, 2);
  assert.equal(cache.size, 0);
  assert.equal(errors.length, 2);
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
      baseUrl: 'https://openai.invalid',
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
        baseUrl: 'https://anthropic.invalid',
        timeoutMs: 12345,
      },
    },
  });

  assert.equal(result.applied, true);
  assert.equal(result.route.workerClass, undefined);
  assert.equal(result.route.reviewerWorkerClass, 'claude-code');
  assert.equal(result.route.reviewerModel, 'claude');
  assert.equal(result.route.botTokenEnv, 'GH_CLAUDE_REVIEWER_TOKEN');
  assert.equal(result.route.baseUrl, 'https://anthropic.invalid');
  assert.equal(result.route.timeoutMs, 12345);
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
