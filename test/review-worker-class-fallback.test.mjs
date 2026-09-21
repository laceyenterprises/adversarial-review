import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyReviewerWorkerClassFallbackToRoute,
  resolveReviewerWorkerClassWithFallback,
  reviewWorkerClassFallback,
  FLEET_QUOTA_STATUS_CACHE_TTL_MS,
  FLEET_QUOTA_STATUS_TIMEOUT_MS,
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
const GEMINI_EXHAUSTED_CODEX_OK = [
  { provider: 'google', authPath: 'agy', state: 'exhausted' },
  { provider: 'openai', authPath: 'oauth', state: 'ok' },
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

test('fleet quota status runs from the configured Agent OS root', async () => {
  const calls = [];
  const result = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    env: { AGENT_OS_ROOT: '/tmp/agent-os-root-for-reviewer' },
    execFileImpl: async (cmd, args, options = {}) => {
      calls.push({ cmd, args, options });
      return { stdout: JSON.stringify({ providerStatuses: CODEX_EXHAUSTED_CLAUDE_OK }) };
    },
  });
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cwd, '/tmp/agent-os-root-for-reviewer');
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

test('uses a same-writer reviewer only as an explicit quota-grounded last resort', async () => {
  const result = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'codex',
    primary: 'gemini',
    fallbackWorkerClasses: ['codex'],
    execFileImpl: fleetStatusStub(GEMINI_EXHAUSTED_CODEX_OK),
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, true);
  assert.equal(result.reason, 'primary-grounded-last-resort');
  assert.equal(result.lastResort, true);
  assert.equal(result.primaryState, 'exhausted');
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

test('shares an unavailable fleet quota status result across nearby subjects', async () => {
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

  assert.equal(calls, 1);
  assert.equal(cache.size, 1);
  assert.equal(errors.length, 1);
});

test('refreshes an unavailable fleet quota status result after its TTL', async () => {
  const cache = new Map();
  let calls = 0;
  let now = 1_000;
  const execFileImpl = async () => {
    calls += 1;
    throw new Error('temporary quota status failure');
  };
  const args = {
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl,
    fleetQuotaStatusCache: cache,
    fleetQuotaStatusCacheTtlMs: 10_000,
    retryDelaysMs: [],
    logger: { error: () => {} },
    nowMs: () => now,
  };

  await resolveReviewerWorkerClassWithFallback(args);
  now += 9_999;
  await resolveReviewerWorkerClassWithFallback(args);
  assert.equal(calls, 1);

  now += 2;
  await resolveReviewerWorkerClassWithFallback(args);
  assert.equal(calls, 2);
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

test('reviewWorkerClassFallback defaults to a cross-model pair and honors the env override', () => {
  assert.deepEqual(reviewWorkerClassFallback({}), ['codex', 'claude-code']);
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

test('route application preserves the diversity guard unless the decision is stamped last-resort', () => {
  const route = {
    builderClass: 'codex',
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
  };
  const rejected = applyReviewerWorkerClassFallbackToRoute({
    route,
    decision: {
      fellBack: true,
      workerClass: 'codex',
      from: 'gemini',
      to: 'codex',
      reason: 'primary-grounded-fallback',
    },
    reviewerRouteByModel: {
      codex: { reviewerModel: 'codex', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' },
    },
    authorClass: 'codex',
  });
  assert.equal(rejected.applied, false);
  assert.equal(rejected.reason, 'writer-diversity-violation');

  const applied = applyReviewerWorkerClassFallbackToRoute({
    route,
    decision: {
      fellBack: true,
      workerClass: 'codex',
      from: 'gemini',
      to: 'codex',
      reason: 'primary-grounded-last-resort',
      lastResort: true,
    },
    reviewerRouteByModel: {
      codex: { reviewerModel: 'codex', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' },
    },
    authorClass: 'codex',
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.route.reviewerModel, 'codex');
  assert.equal(applied.route.reviewWorkerClassFallback.lastResort, true);
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

// A cache cannot serve a hit if its TTL expires before the call it caches can
// even return. The shipped pairing was TTL=10s against a bound of 20s, so a slow
// read (measured median 18s on the reference host) guaranteed a miss for the next
// caller — the watcher re-read fleet quota status once per PR, 76 reads and
// 38.3 minutes of wall clock in one poll window, and polls stopped completing.
// Keep the ordering explicit so neither constant can be retuned back into it.
test('quota-status cache TTL outlives the quota-status timeout', () => {
  assert.ok(
    FLEET_QUOTA_STATUS_CACHE_TTL_MS > FLEET_QUOTA_STATUS_TIMEOUT_MS,
    `cache TTL (${FLEET_QUOTA_STATUS_CACHE_TTL_MS}ms) must exceed the read timeout ` +
      `(${FLEET_QUOTA_STATUS_TIMEOUT_MS}ms), or a slow read always expires its own cache entry`,
  );
});

test('a second PR in the same poll reuses the cached quota read across per-PR work', async () => {
  let execCount = 0;
  const cache = new Map();
  let clock = 0;
  const execFileImpl = async () => {
    execCount += 1;
    clock += 18_000; // the read itself: measured median on the reference host
    return { stdout: JSON.stringify({ providerStatuses: CODEX_EXHAUSTED_CLAUDE_OK }) };
  };
  const call = () => resolveReviewerWorkerClassWithFallback({
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl,
    fleetQuotaStatusCache: cache,
    nowMs: () => clock,
  });

  const first = await call();
  // A watcher poll does substantial per-PR work between quota reads (GitHub
  // reads, gate evaluation, spawn decisions). That gap, not the read latency,
  // is what expired the old 10s entry and forced one re-read per PR.
  clock += 30_000;
  const second = await call();

  assert.equal(first.workerClass, 'claude-code');
  assert.equal(second.workerClass, 'claude-code');
  assert.equal(execCount, 1, 'second PR must reuse the cached quota snapshot, not re-read it');
});
