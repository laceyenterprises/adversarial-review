import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createRateLimitThrottle,
  DEFAULT_THROTTLE_FLOOR,
  resolveThrottleFloor,
} from '../src/rate-limit-throttle.mjs';

function makeRootDir(prefix = 'rate-limit-throttle-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
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
    assert.equal(stored.remaining, 150);
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
