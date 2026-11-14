import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createRateLimitThrottle,
  withGitHubBudgetScope,
  DEFAULT_RESOURCE,
  DEFAULT_THROTTLE_FLOOR,
  resolveRateLimitSharedStatePath,
  resolveThrottleFloor,
} from '../src/rate-limit-throttle.mjs';

function makeRootDir(prefix = 'rate-limit-throttle-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

async function waitFor(predicate, { timeoutMs = 1000 } = {}) {
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
  confirmBudgetImpl = async () => null,
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
    confirmBudgetImpl,
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

for (const remaining of [100, 0]) {
  test(`scoped callers decide independently of an un-scoped sleep with ${remaining} remaining`, { timeout: 2000 }, async t => {
    const rootDir = makeRootDir();
    const now = Date.parse('2026-06-06T12:00:00.000Z');
    let releaseSleep, sleeping;
    let signalSleep;
    const sleepStarted = new Promise(resolve => { signalSleep = resolve; });
    const throttle = makeThrottle({ rootDir, nowMs: () => now,
      sleepImpl: () => new Promise(resolve => { releaseSleep = resolve; signalSleep(); }),
    });
    t.after(async () => {
      releaseSleep?.();
      await sleeping;
      rmSync(rootDir, { recursive: true, force: true });
    });
    await throttle.recordResponseRateLimit({ resource: 'graphql', remaining, resetAt: now + 60_000 });
    sleeping = throttle.awaitThrottleIfNeeded('graphql');
    await sleepStarted;
    await Promise.all([false, true].map(urgent => withGitHubBudgetScope({ urgent }, async scope => {
      if (urgent && remaining > 0) {
        assert.equal(await throttle.awaitThrottleIfNeeded('graphql'), false);
        assert.equal(scope.deferred, false);
      } else {
        await assert.rejects(throttle.awaitThrottleIfNeeded('graphql'), { name: 'GitHubBudgetDeferredError' });
        assert.equal(scope.deferred, true);
      }
    })));
    await withGitHubBudgetScope({ urgent: true }, async () => {
      await throttle.recordRateLimitedCall('graphql');
      await assert.rejects(throttle.awaitThrottleIfNeeded('graphql'), { name: 'GitHubBudgetDeferredError' });
    });
  });
}

for (const order of [[false, true, false], [true, false, false]]) {
  test(`concurrent budget scopes retain their own urgency and deferral flags: ${order}`, async t => {
    const rootDir = makeRootDir();
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const now = Date.parse('2026-06-06T12:00:00.000Z');
    const throttle = makeThrottle({ rootDir, nowMs: () => now,
      sleepImpl: () => { assert.fail('budget scopes must not sleep'); },
    });
    await throttle.recordResponseRateLimit({ remaining: 100, resetAt: now + 60_000 });
    await Promise.all(order.map(urgent => withGitHubBudgetScope({ urgent }, async scope => {
      if (urgent) assert.equal(await throttle.awaitThrottleIfNeeded(), false);
      else await assert.rejects(throttle.awaitThrottleIfNeeded(), { name: 'GitHubBudgetDeferredError' });
      assert.equal(scope.deferred, !urgent);
    })));
  });
}

for (const remaining of [100, 0]) {
  test(`operator safety scopes are never slept or deferred by the floor with ${remaining} remaining (NOMERGEHOLDHANG-01)`, async t => {
    const rootDir = makeRootDir();
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const now = Date.parse('2026-06-06T12:00:00.000Z');
    const throttle = makeThrottle({ rootDir, nowMs: () => now,
      sleepImpl: () => { assert.fail('operator safety actions must not sleep until reset'); },
    });
    await throttle.recordResponseRateLimit({ resource: 'graphql', remaining, resetAt: now + 3_600_000 });
    await withGitHubBudgetScope({ operatorSafety: true }, async scope => {
      assert.equal(await throttle.awaitThrottleIfNeeded('graphql'), false);
      assert.equal(scope.deferred, false);
      // A rate limit this operation itself observed still fails fast.
      await throttle.recordRateLimitedCall('graphql');
      await assert.rejects(throttle.awaitThrottleIfNeeded('graphql'), { name: 'GitHubBudgetDeferredError' });
    });
  });
}

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

test('default shared-state path is anchored to the module root, not process cwd', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.dirname(testDir);
  assert.equal(
    resolveRateLimitSharedStatePath({}, '/tmp/not-the-tool-root'),
    path.join(repoRoot, 'data', 'api-cache', 'rate-limit-state.json'),
  );
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

test('recordResponseRateLimit skips shared-state writes when the observation is unchanged', async () => {
  const rootDir = makeRootDir();
  try {
    const statePath = path.join(rootDir, 'data', 'api-cache', 'rate-limit-state.json');
    let openCalls = 0;
    const throttle = createRateLimitThrottle({
      env: { GHO_RATE_LIMIT_SHARED_STATE_PATH: statePath },
      nowMs: () => Date.parse('2026-06-06T12:00:00.000Z'),
      sleepImpl: async () => {},
      openImpl: async (...args) => {
        openCalls += 1;
        const { open } = await import('node:fs/promises');
        return open(...args);
      },
    });
    const observation = {
      remaining: 100,
      resetAt: '2026-06-06T12:00:42.000Z',
      observedAt: '2026-06-06T12:00:00.000Z',
    };

    await throttle.recordResponseRateLimit(observation);
    await throttle.recordResponseRateLimit(observation);

    assert.equal(openCalls, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('lock release does not depend on rereading owner metadata', async () => {
  const rootDir = makeRootDir();
  try {
    const statePath = path.join(rootDir, 'data', 'api-cache', 'rate-limit-state.json');
    const rmCalls = [];
    const throttle = createRateLimitThrottle({
      env: { GHO_RATE_LIMIT_SHARED_STATE_PATH: statePath },
      nowMs: () => Date.parse('2026-06-06T12:00:00.000Z'),
      sleepImpl: async () => {},
      readFileImpl: async (targetPath) => {
        if (String(targetPath).endsWith('owner.json')) throw new Error('transient owner read failure');
        return '{}';
      },
      rmImpl: async (targetPath) => {
        rmCalls.push(String(targetPath));
      },
    });

    await throttle.recordResponseRateLimit({
      remaining: 100,
      resetAt: '2026-06-06T12:00:42.000Z',
      observedAt: '2026-06-06T12:00:00.000Z',
    });

    assert.ok(rmCalls.some((targetPath) => targetPath.endsWith('rate-limit-state.json.lock')));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('long throttle waits publish and clear a sidecar status file', async () => {
  const rootDir = makeRootDir();
  let releaseSleep;
  try {
    const statePath = path.join(rootDir, 'data', 'api-cache', 'rate-limit-state.json');
    const throttle = createRateLimitThrottle({
      env: { GHO_RATE_LIMIT_SHARED_STATE_PATH: statePath },
      nowMs: () => Date.parse('2026-06-06T12:00:00.000Z'),
      sleepImpl: () => new Promise((resolve) => {
        releaseSleep = resolve;
      }),
    });
    await throttle.recordResponseRateLimit({
      remaining: 1,
      resetAt: '2026-06-06T12:05:00.000Z',
      observedAt: '2026-06-06T12:00:00.000Z',
    });

    const pending = throttle.awaitThrottleIfNeeded();
    const sidecarPath = `${statePath}.throttled.json`;
    let sidecar = null;
    await waitFor(() => {
      if (typeof releaseSleep !== 'function' || !existsSync(sidecarPath)) return false;
      try {
        sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
        return true;
      } catch {
        return false;
      }
    }, { timeoutMs: 5_000 });
    assert.equal(sidecar.resource, DEFAULT_RESOURCE);
    assert.equal(sidecar.throttledUntil, '2026-06-06T12:02:00.000Z');

    releaseSleep();
    await pending;
    assert.equal(existsSync(sidecarPath), false);
  } finally {
    releaseSleep?.();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('GHBUDGET-01: watcher skips low-budget reads, serves ready closes, and resumes at reset', async t => {
  const { withGitHubBudgetScope, GitHubBudgetDeferredError } = await import('../src/rate-limit-throttle.mjs');
  const { runLowBudgetClosingTick } = await import('../src/watcher-github-budget.mjs');
  const rootDir = makeRootDir();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let now = Date.parse('2026-01-01T00:00:00Z');
  const throttle = makeThrottle({ rootDir, nowMs: () => now, sleepImpl: () => { throw new Error('poll must not sleep'); } });
  await throttle.recordResponseRateLimit({ resource: 'graphql', remaining: 100, resetAt: now + 60_000 });
  let nonUrgent = 0, closing = 0, noProgressTicks = 0;
  const logs = [];
  for (let tick = 0; tick < 2; tick++) {
    await withGitHubBudgetScope({}, async scope => {
      await assert.rejects(throttle.awaitThrottleIfNeeded('graphql'), GitHubBudgetDeferredError);
      assert.equal(scope.deferred, true);
    });
    const deferred = await runLowBudgetClosingTick({ budgets: await throttle.readSharedState(),
      rows: [{ ready: false }, { ready: true }], isReady: row => row.ready,
      serve: async () => { assert.equal(await throttle.awaitThrottleIfNeeded('graphql'), false); closing++; },
      logger: { log: line => logs.push(line) },
    });
    if (!deferred) { nonUrgent++; noProgressTicks++; }
    now += 20_000;
  }
  assert.equal(nonUrgent, 0);
  assert.equal(closing, 2);
  assert.equal(noProgressTicks, 0);
  assert.equal(logs.length, 2);
  assert.ok(logs.every(line => line.includes('remaining=100') && line.includes('reset=2026-01-01T00:01:00.000Z')));
  now += 20_000;
  assert.equal(await runLowBudgetClosingTick({ budgets: await throttle.readSharedState(), rows: [], isReady: () => true,
    serve: async () => {}, logger: { log: () => assert.fail('reset window must resume') } }), false);
  await withGitHubBudgetScope({}, async () => assert.equal(await throttle.awaitThrottleIfNeeded('graphql'), false));
});

test('GHBUDGET-01: rate-limited counters are shared, atomic and scoped to a resource window', async t => {
  const rootDir = makeRootDir();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let now = Date.parse('2026-01-01T00:00:00Z');
  const a = makeThrottle({ rootDir, nowMs: () => now });
  const b = makeThrottle({ rootDir, nowMs: () => now });
  const observation = { resource: 'graphql', remaining: 4000, resetAt: now + 60_000 };
  await Promise.all([a.recordResponseRateLimit({ ...observation, rateLimited: true }),
    b.recordResponseRateLimit({ ...observation, rateLimited: true })]);
  await a.recordResponseRateLimit(observation);
  await b.recordResponseRateLimit({ ...observation, resource: 'core', rateLimited: true });
  let state = await a.readSharedState();
  assert.equal(state.graphql.rateLimitedCalls, 2);
  assert.equal(state.core.rateLimitedCalls, 1);
  await a.recordRateLimitedCall('graphql');
  assert.equal((await b.readSharedState()).graphql.rateLimitedCalls, 3);
  now += 60_000;
  await a.recordResponseRateLimit({ ...observation, resetAt: now + 60_000 });
  state = await b.readSharedState();
  assert.equal(state.graphql.rateLimitedCalls || 0, 0);
  assert.equal(state.core, undefined);
});

test('headerless rate limits initialize and renew an expired resource window atomically', async t => {
  const rootDir = makeRootDir();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let now = Date.parse('2026-01-01T00:00:00Z');
  const a = makeThrottle({ rootDir, nowMs: () => now });
  const b = makeThrottle({ rootDir, nowMs: () => now });
  await Promise.all([a.recordRateLimitedCall('GraphQL'), b.recordRateLimitedCall('graphql')]);
  let state = await b.readSharedState();
  assert.equal(state.graphql.rateLimitedCalls, 2);
  assert.equal(state.graphql.remaining, null);
  assert.equal(state.graphql.secondaryUntil, new Date(now + 120_000).toISOString());
  assert.equal(state.core, undefined);
  await withGitHubBudgetScope({}, async () => {
    await assert.rejects(a.awaitThrottleIfNeeded('graphql'), { name: 'GitHubBudgetDeferredError' });
  });
  now += 120_000;
  await b.recordRateLimitedCall('graphql');
  state = await a.readSharedState();
  assert.equal(state.graphql.rateLimitedCalls, 1);
  assert.equal(state.graphql.resetAt, new Date(now + 60_000).toISOString());
  const persisted = JSON.parse(readFileSync(a.resolveSharedStatePath(), 'utf8'));
  assert.deepEqual(persisted.buckets.graphql, state.graphql);
  await a.recordRateLimitedCall();
  assert.equal((await b.readSharedState()).core.rateLimitedCalls, 1);
});

for (const [description, observation, expectedLimit] of [
  ['failure with a reset but no limit', { remaining: 0, resetAt: '2026-01-01T00:02:00Z' }, 60],
  ['failure with a new limit', { remaining: 0, resetAt: '2026-01-01T00:02:00Z', limit: 120 }, 120],
]) {
  test(`zero-balance merge retains the known limit: ${description}`, async t => {
    const rootDir = makeRootDir();
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const now = Date.parse('2026-01-01T00:00:00Z');
    const writer = makeThrottle({ rootDir, nowMs: () => now });
    await writer.recordResponseRateLimit({ remaining: 58, limit: 60, resetAt: now + 1800_000 });
    const recorded = await writer.recordRateLimitedCall('core', 'default', observation);
    assert.equal(recorded.remaining, 0);
    assert.equal(recorded.limit, expectedLimit);
    assert.equal(recorded.rateLimitedCalls, 1);
    assert.equal(recorded.resetAt, new Date(now + (observation ? 120_000 : 60_000)).toISOString());
    assert.equal(recorded.resetUnknown === true, observation === null);
    const persisted = JSON.parse(readFileSync(writer.resolveSharedStatePath(), 'utf8'));
    assert.equal(persisted.buckets.core.limit, expectedLimit);

    const reader = makeThrottle({ rootDir, nowMs: () => now });
    assert.deepEqual((await reader.readSharedState()).core, persisted.buckets.core);
    await withGitHubBudgetScope({}, async () => {
      await assert.rejects(reader.awaitThrottleIfNeeded(), err => {
        assert.equal(err.name, 'GitHubBudgetDeferredError');
        assert.equal(err.observation.limit, expectedLimit);
        assert.ok(err.message.includes(`remaining=0/${expectedLimit}; floor=${expectedLimit / 10}`));
        return true;
      });
    });
  });
}

test('GHBUDGET-01: a newly settled review gets closing priority before its published gate refresh', async () => {
  const { isClosingRowReady } = await import('../src/watcher-github-budget.mjs');
  const row = { repo: 'fixture/repo', pr_number: 42, reviewer_head_sha: 'a'.repeat(40), review_status: 'posted' };
  const readGate = () => ({ state: 'pending' });
  assert.equal(isClosingRowReady('/fixture', row, { readGate, resolveSettled: () => ({ verdict: 'comment-only', remediationPending: false }) }), true);
  assert.equal(isClosingRowReady('/fixture', row, { readGate, resolveSettled: () => ({ verdict: 'approved', remediationPending: false }) }), true);
  assert.equal(isClosingRowReady('/fixture', row, { readGate, resolveSettled: () => ({ verdict: 'request-changes', remediationPending: false }) }), false);
  assert.equal(isClosingRowReady('/fixture', row, { readGate, resolveSettled: () => ({ verdict: 'comment-only', remediationPending: true }) }), false);
});

test('reading an unobserved budget leaves the state directory absent', async () => {
  const rootDir = makeRootDir();
  try {
    const throttle = makeThrottle({ rootDir });
    assert.deepEqual(await throttle.readSharedState(), {});
    assert.equal(await throttle.awaitThrottleIfNeeded(), false);
    assert.equal(existsSync(path.join(rootDir, 'data')), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('long wait confirms a stale primary zero, persists recovery and never sleeps', async t => {
  const rootDir = makeRootDir();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let now = Date.parse('2026-06-06T12:00:00Z');
  const rows = [], sleeps = [];
  let confirmations = 0;
  const throttle = makeThrottle({ rootDir, nowMs: () => now,
    sleepImpl: async ms => sleeps.push(ms), recordApiCallImpl: row => rows.push(row),
    confirmBudgetImpl: async () => {
      confirmations++;
      return { core: { remaining: 4500, limit: 5000, reset: (now + 3600_000) / 1000 } };
    } });
  await throttle.recordResponseRateLimit({ remaining: 0, limit: 5000, resource: 'core',
    resetAt: now + 3600_000, observedAt: now });
  now += 1000;
  assert.equal(await throttle.awaitThrottleIfNeeded(), false);
  assert.equal(await throttle.awaitThrottleIfNeeded(), false);
  assert.equal(confirmations, 1);
  assert.deepEqual(sleeps, []);
  assert.equal((await throttle.readSharedState()).core.remaining, 4500);
  const otherProcess = makeThrottle({ rootDir, nowMs: () => now });
  assert.equal((await otherProcess.readSharedState()).core.remaining, 4500);
  assert.equal(rows.some(row => row.category === 'rate_limit_throttle_seconds'), false);
});

for (const outcome of ['exhausted', 'failed', 'secondary']) test(`long wait retains ${outcome} evidence after confirmation`, async t => {
  const rootDir = makeRootDir();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let now = Date.parse('2026-06-06T12:00:00Z');
  const reset = now + 3600_000, sleeps = [];
  let confirmations = 0;
  const throttle = makeThrottle({ rootDir, nowMs: () => now,
    sleepImpl: async ms => { sleeps.push(ms); now += ms; },
    confirmBudgetImpl: async () => {
      confirmations++;
      if (outcome === 'failed') throw new Error('synthetic transport unavailable');
      return { core: { remaining: outcome === 'secondary' ? 4500 : 0, limit: 5000, reset: reset / 1000 } };
    } });
  await throttle.recordResponseRateLimit({ remaining: 0, resource: 'core', limit: 5000,
    resetAt: reset, observedAt: now, rateLimited: outcome === 'secondary' });
  now += 1000;
  assert.equal(await throttle.awaitThrottleIfNeeded(), true);
  assert.equal(confirmations, 1);
  assert.deepEqual(sleeps, [3599_000]);
});

test('zero observation logs only raw quota headers, request category and consumer', async t => {
  const { extractRateLimitObservation } = await import('../src/rate-limit-throttle.mjs');
  const rootDir = makeRootDir();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const now = Date.parse('2026-06-06T12:00:00Z'), rows = [];
  const throttle = makeThrottle({ rootDir, nowMs: () => now, recordApiCallImpl: row => rows.push(row) });
  const headers = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0',
    'x-ratelimit-used': '5000', 'x-ratelimit-reset': String((now + 3600_000) / 1000),
    'x-ratelimit-resource': 'core' };
  await withGitHubBudgetScope({ consumer: 'synthetic-reviewer' }, () => throttle.recordResponseRateLimit({
    ...extractRateLimitObservation({ ...headers, authorization: 'never-log-this' }, { observedAt: now }),
    requestCategory: 'pr_state', credential: 'synthetic-credential',
  }));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].extra.rawRateLimitHeaders, headers);
  assert.equal(rows[0].extra.requestCategory, 'pr_state');
  assert.equal(rows[0].extra.consumer, 'synthetic-reviewer');
  assert.equal(JSON.stringify(rows).includes('never-log-this'), false);
});

test('free confirmation endpoint uses the selected environment and retains only quota headers', async t => {
  const { rateLimitConfirmation } = await import('../src/rate-limit-throttle.mjs');
  const { writeFileSync } = await import('node:fs');
  const rootDir = makeRootDir();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const reset = Math.floor((Date.now() + 3600_000) / 1000);
  const headers = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0',
    'x-ratelimit-used': '5000', 'x-ratelimit-reset': String(reset), 'x-ratelimit-resource': 'core' };
  writeFileSync(path.join(rootDir, 'gh'), `#!${process.execPath}
    if (process.argv.slice(2).join(' ') !== 'api --method GET --include rate_limit') process.exit(2);
    if (process.env.GH_TOKEN !== 'synthetic-token' || process.env.GH_DEBUG !== '') process.exit(3);
    process.stdout.write(${JSON.stringify('HTTP/2.0 200 OK\r\n' + Object.entries(headers).map(([k,v]) => `${k}: ${v}`).join('\r\n') + '\r\nAuthorization: never-retain\r\n\r\n' + JSON.stringify({ resources: { core: { limit: 5000, remaining: 0, reset } } }))});
  `, { mode: 0o700 });
  const live = await rateLimitConfirmation.read({ PATH: rootDir, GH_TOKEN: 'synthetic-token', GH_DEBUG: 'api' });
  assert.equal(live.core.remaining, 0);
  assert.deepEqual(live.rawRateLimitHeaders, headers);
  assert.equal(JSON.stringify(live).includes('never-retain'), false);
});

test('long wait cannot confirm a different credential and defers instead of sleeping', async t => {
  const rootDir = makeRootDir();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const now = Date.parse('2026-06-06T12:00:00Z');
  const throttle = makeThrottle({ rootDir, nowMs: () => now,
    sleepImpl: async () => assert.fail('unconfirmed credential cannot sleep'),
    confirmBudgetImpl: async () => assert.fail('must not send a different identity') });
  await throttle.recordResponseRateLimit({ resource: 'core', remaining: 0, observedAt: now,
    resetAt: now + 3600_000, credential: 'synthetic-other-identity' });
  await assert.rejects(throttle.awaitThrottleIfNeeded('core', 'synthetic-other-identity'), { name: 'GitHubBudgetDeferredError' });
});

 test('a headerless structured secondary failure preserves the previous primary bucket', async t => {
  const rootDir = makeRootDir();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const now = Date.parse('2026-01-01T00:00:00Z');
  const writer = makeThrottle({ rootDir, nowMs: () => now });
  await writer.recordResponseRateLimit({ remaining: 58, limit: 60, resetAt: now + 1800_000 });
  await writer.recordRateLimitedCall('core');
  const state = (await writer.readSharedState()).core;
  assert.equal(state.remaining, 58);
  assert.equal(state.limit, 60);
  assert.equal(state.secondaryUntil, new Date(now + 60_000).toISOString());
  assert.equal(state.resetAt, new Date(now + 1800_000).toISOString());
});
