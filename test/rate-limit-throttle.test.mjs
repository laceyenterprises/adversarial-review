import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createRateLimitThrottle,
  DEFAULT_RESOURCE,
  DEFAULT_THROTTLE_FLOOR,
  resolveThrottleFloor,
} from '../src/rate-limit-throttle.mjs';

function makeRootDir(prefix = 'rate-limit-throttle-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

async function waitFor(predicate, { timeoutMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}

function makeThrottle({
  rootDir,
  env = {},
  nowMs,
  sleepImpl,
  logger = console,
  recordApiCallImpl = () => {},
} = {}) {
  return createRateLimitThrottle({
    env: {
      GHO_RATE_LIMIT_SHARED_STATE_PATH: path.join(rootDir, 'data', 'api-cache', 'rate-limit-state.json'),
      ...env,
    },
    nowMs,
    sleepImpl,
    logger,
    recordApiCallImpl,
  });
}

test('throttle activates exactly below the configured floor', async () => {
  const rootDir = makeRootDir();
  try {
    let now = Date.parse('2026-06-06T12:00:00.000Z');
    const sleeps = [];
    const throttle = makeThrottle({
      rootDir,
      env: { GHO_RATE_LIMIT_THROTTLE_FLOOR: '200' },
      nowMs: () => now,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    await throttle.recordResponseRateLimit({
      remaining: 200,
      resetAt: '2026-06-06T12:00:30.000Z',
      observedAt: '2026-06-06T12:00:00.000Z',
    });
    assert.equal(await throttle.awaitThrottleIfNeeded(), false);

    await throttle.recordResponseRateLimit({
      remaining: 199,
      resetAt: '2026-06-06T12:01:00.000Z',
      observedAt: '2026-06-06T12:00:01.000Z',
    });
    assert.equal(await throttle.awaitThrottleIfNeeded(), true);
    assert.equal(sleeps.length, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('pause duration matches reset_at minus now', async () => {
  const rootDir = makeRootDir();
  try {
    const now = Date.parse('2026-06-06T12:00:00.000Z');
    let sleptMs = null;
    const throttle = makeThrottle({
      rootDir,
      nowMs: () => now,
      sleepImpl: async (ms) => {
        sleptMs = ms;
      },
    });

    await throttle.recordResponseRateLimit({
      remaining: 100,
      resetAt: '2026-06-06T12:00:42.000Z',
      observedAt: '2026-06-06T12:00:00.000Z',
    });
    await throttle.awaitThrottleIfNeeded();
    assert.ok(Math.abs((sleptMs / 1000) - 42) <= 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('multiple call sites share one in-process throttle activation', async () => {
  const rootDir = makeRootDir();
  try {
    let releaseSleep;
    let sleepCalls = 0;
    const throttle = makeThrottle({
      rootDir,
      nowMs: () => Date.parse('2026-06-06T12:00:00.000Z'),
      sleepImpl: () => new Promise((resolve) => {
        sleepCalls += 1;
        releaseSleep = resolve;
      }),
    });
    await throttle.recordResponseRateLimit({
      remaining: 10,
      resetAt: '2026-06-06T12:00:05.000Z',
      observedAt: '2026-06-06T12:00:00.000Z',
    });

    const first = throttle.awaitThrottleIfNeeded();
    const second = throttle.awaitThrottleIfNeeded();
    await waitFor(() => sleepCalls === 1 && typeof releaseSleep === 'function');
    assert.equal(sleepCalls, 1);
    releaseSleep();
    await Promise.all([first, second]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('shared-state inheritance and monotonic merge keep the lower remaining budget', async () => {
  const rootDir = makeRootDir();
  try {
    const now = Date.parse('2026-06-06T12:00:00.000Z');
    const parent = makeThrottle({
      rootDir,
      nowMs: () => now,
      sleepImpl: async () => {},
    });
    const child = makeThrottle({
      rootDir,
      nowMs: () => now,
      sleepImpl: async () => {},
    });

    await parent.recordResponseRateLimit({
      remaining: 199,
      resetAt: '2026-06-06T12:00:30.000Z',
      observedAt: '2026-06-06T12:00:00.000Z',
    });
    assert.equal(await child.awaitThrottleIfNeeded(), true);

    await child.recordResponseRateLimit({
      remaining: 150,
      resetAt: '2026-06-06T12:00:30.000Z',
      observedAt: '2026-06-06T12:00:02.000Z',
    });
    await parent.recordResponseRateLimit({
      remaining: 175,
      resetAt: '2026-06-06T12:00:30.000Z',
      observedAt: '2026-06-06T12:00:03.000Z',
    });

    const stored = JSON.parse(readFileSync(path.join(rootDir, 'data', 'api-cache', 'rate-limit-state.json'), 'utf8'));
    assert.equal(stored.buckets.core.remaining, 150);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('different rate-limit buckets do not throttle each other', async () => {
  const rootDir = makeRootDir();
  try {
    const sleeps = [];
    const throttle = makeThrottle({
      rootDir,
      nowMs: () => Date.parse('2026-06-06T12:00:00.000Z'),
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });

    await throttle.recordResponseRateLimit({
      resource: 'search',
      remaining: 1,
      resetAt: '2026-06-06T12:00:42.000Z',
      observedAt: '2026-06-06T12:00:00.000Z',
    });

    assert.equal(await throttle.awaitThrottleIfNeeded('core'), false);
    assert.equal(await throttle.awaitThrottleIfNeeded('search'), true);
    assert.equal(sleeps.length, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('out-of-range floor falls back to default with a warning', () => {
  const warnings = [];
  const floor = resolveThrottleFloor(
    { GHO_RATE_LIMIT_THROTTLE_FLOOR: '10000' },
    { warn: (message) => warnings.push(message) },
  );
  assert.equal(floor, DEFAULT_THROTTLE_FLOOR);
  assert.equal(warnings.length, 1);
});

test('reset window resumes without a second throttle activation', async () => {
  const rootDir = makeRootDir();
  try {
    let now = Date.parse('2026-06-06T12:00:00.000Z');
    let sleepCalls = 0;
    const throttle = makeThrottle({
      rootDir,
      nowMs: () => now,
      sleepImpl: async (ms) => {
        sleepCalls += 1;
        now += ms;
      },
    });
    await throttle.recordResponseRateLimit({
      remaining: 1,
      resetAt: '2026-06-06T12:00:05.000Z',
      observedAt: '2026-06-06T12:00:00.000Z',
    });
    assert.equal(await throttle.awaitThrottleIfNeeded(), true);
    assert.equal(await throttle.awaitThrottleIfNeeded(), false);
    assert.equal(sleepCalls, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('throttle recovers after a rejected sleep', async () => {
  const rootDir = makeRootDir();
  try {
    let shouldReject = true;
    const throttle = makeThrottle({
      rootDir,
      nowMs: () => Date.parse('2026-06-06T12:00:00.000Z'),
      sleepImpl: async () => {
        if (shouldReject) throw new Error('cancelled');
      },
    });
    await throttle.recordResponseRateLimit({
      remaining: 1,
      resetAt: '2026-06-06T12:00:05.000Z',
      observedAt: '2026-06-06T12:00:00.000Z',
    });

    await assert.rejects(throttle.awaitThrottleIfNeeded(), /cancelled/);
    shouldReject = false;
    assert.equal(await throttle.awaitThrottleIfNeeded(), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('shared-state path is resolved lazily from env', async () => {
  const rootDir = makeRootDir();
  const env = {};
  try {
    const firstPath = path.join(rootDir, 'first', 'state.json');
    const secondPath = path.join(rootDir, 'second', 'state.json');
    env.GHO_RATE_LIMIT_SHARED_STATE_PATH = firstPath;
    const throttle = createRateLimitThrottle({
      env,
      nowMs: () => Date.parse('2026-06-06T12:00:00.000Z'),
      sleepImpl: async () => {},
    });
    assert.equal(throttle.resolveSharedStatePath(), firstPath);
    env.GHO_RATE_LIMIT_SHARED_STATE_PATH = secondPath;
    assert.equal(throttle.resolveSharedStatePath(), secondPath);
    await throttle.recordResponseRateLimit({
      resource: DEFAULT_RESOURCE,
      remaining: 100,
      resetAt: '2026-06-06T12:00:42.000Z',
      observedAt: '2026-06-06T12:00:00.000Z',
    });
    const stored = JSON.parse(readFileSync(secondPath, 'utf8'));
    assert.equal(stored.buckets.core.remaining, 100);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
