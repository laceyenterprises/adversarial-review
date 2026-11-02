import './helpers/load-aware-timeout-fixture.mjs';
import './helpers/registry-session-fixture.mjs';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createCpuBusySampler, hostCpuBusyPercent, loadAwareTimeoutMs, loadAwareTimeoutSeconds, resetLoadAwareTimeoutCachesForTesting } from '../src/load-aware-timeout.mjs';
import { loadConfig, __testYamlHooks } from '../src/config-loader.mjs';
import { execGhWithRetry, GH_LOOKUP_TIMEOUT_MS } from '../src/gh-cli.mjs';
import { FLEET_QUOTA_STATUS_TIMEOUT_MS } from '../src/fleet-quota-status.mjs';
import { readAfhReviewerGrounding } from '../src/afh-reviewer-fallback.mjs';
import { resolveCloserDispatchHarness } from '../src/ama/harness-fallback.mjs';
import { readFleetQuotaStatuses } from '../src/argus-reviewer-routing.mjs';
import { resolveRemediationWorkerClassWithFallback } from '../src/remediation-worker-class-fallback.mjs';
import { resolveReviewerWorkerClassWithFallback } from '../src/review-worker-class-fallback.mjs';
import { collectBurstQuotaSignal } from '../src/reviewer-burst-cli.mjs';
import { createWatcherReviewerQuotaPollFactory } from '../src/watcher-reviewer-quota.mjs';
import { createQuotaHoldRevalidator } from '../src/remediation-admission.mjs';
import { createRateLimitThrottle } from '../src/rate-limit-throttle.mjs';
import { resolveMergeAgentCoexistenceStepDeadlineMs, resolveMergeAgentCoexistenceOperationTimeoutMs, preparePostedReviewHandlers, runQueuedReviewAdoptionPhase, resolveNominalMergeAgentCoexistenceStepDeadlineMs } from '../src/posted-review-row.mjs';
import { resolvePostedReviewPhaseBudgetMs, runPostedReviewHandlersFairly } from '../src/watcher-poll-fairness.mjs';

const busyLoad = { enabled: true, maxMultiplier: 6, cpuCount: 4, cpuBusyPercent: 100 };
const quiet = { log() {}, warn() {}, error() {} };

// Registry preparation sizes reads before each test; start policy/cache-clock
// assertions without that preparation's cached timeout policy.
beforeEach(() => resetLoadAwareTimeoutCachesForTesting());

function syntheticBusyHost(t) {
  t.mock.method(os, 'loadavg', () => [os.cpus().length * 3, 0, 0]);
  t.mock.method(childProcess, 'execFileSync', command => {
    assert.equal(command, '/bin/ps');
    return `${os.cpus().length * 100}\n`;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test('millisecond and second forms share the curve, corroboration and bounds', () => {
  for (const [loadAvg1m, multiplier] of [[0, 1], [4, 1], [8, 3.5], [12, 6], [40, 6]]) {
    assert.equal(loadAwareTimeoutMs(123, { ...busyLoad, loadAvg1m }), Math.ceil(123 * multiplier));
    assert.equal(loadAwareTimeoutSeconds(123, { ...busyLoad, loadAvg1m }), Math.ceil(123 * multiplier));
  }
  assert.equal(loadAwareTimeoutMs(100, { ...busyLoad, loadAvg1m: 12, maxMultiplier: 2 }), 200);
  assert.equal(loadAwareTimeoutMs(100, { ...busyLoad, loadAvg1m: 12, cpuBusyPercent: 42.5 }), 350);
  assert.equal(loadAwareTimeoutMs(100, { ...busyLoad, loadAvg1m: 12, cpuBusyPercent: null }), 600);
  assert.equal(loadAwareTimeoutMs(100, { ...busyLoad, loadAvg1m: 12, maxMs: 250 }), 250);
  assert.equal(loadAwareTimeoutMs(100, { ...busyLoad, loadAvg1m: 12, maxMs: 50 }), 100);
  assert.throws(() => loadAwareTimeoutMs(0), /positive number/);
});

test('CPU sample, including failure, is reused for five seconds', () => {
  let now = 0;
  let calls = 0;
  const sample = createCpuBusySampler({ cpuCount: 2, nowMs: () => now,
    execFileSyncImpl: () => { calls++; return calls === 1 ? '85\n85\n' : '40\n'; } });
  assert.equal(sample(), 85);
  now = 4999;
  for (let i = 0; i < 100; i++) assert.equal(sample(), 85);
  assert.equal(calls, 1);
  now = 5000;
  assert.equal(sample(), 20);
  assert.equal(calls, 2);
  let failures = 0;
  const failedSample = createCpuBusySampler({ nowMs: () => now, warn() {},
    execFileSyncImpl: () => { failures++; throw new Error('synthetic ps failure'); } });
  assert.equal(failedSample(), null);
  now += 4999;
  assert.equal(failedSample(), null);
  assert.equal(failures, 1);
  now++;
  assert.equal(failedSample(), null);
  assert.equal(failures, 2);
});

test('host timeout scaling survives ps failure with fresh evidence, then the load curve', t => {
  syntheticBusyHost(t);
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  t.mock.method(childProcess, 'execFileSync', () => { throw new Error('synthetic ps timeout'); });
  syncBuiltinESMExports();
  const opts = { enabled: true, maxMultiplier: 6 };
  assert.equal(loadAwareTimeoutMs(100, opts), 600, 'no good sample uses full load curve');
  t.mock.method(childProcess, 'execFileSync', () => `${os.cpus().length * 42.5}\n`);
  syncBuiltinESMExports();
  now = 5000;
  assert.equal(loadAwareTimeoutMs(100, opts), 350);
  t.mock.method(childProcess, 'execFileSync', () => { throw new Error('synthetic ps timeout'); });
  syncBuiltinESMExports();
  now = 10000;
  assert.equal(loadAwareTimeoutMs(100, opts), 350, 'fresh CPU evidence keeps graded scaling');
  now = 65000;
  assert.equal(loadAwareTimeoutMs(100, opts), 600, 'stale CPU evidence uses full load curve');
  assert.equal(warnings.length, 2);
});

test('reset discards a cached default CPU sample without waiting for expiry', t => {
  syntheticBusyHost(t);
  t.mock.method(performance, 'now', () => 0);
  assert.equal(hostCpuBusyPercent(), 100);
  t.mock.method(childProcess, 'execFileSync', () => '0\n');
  syncBuiltinESMExports();
  assert.equal(hostCpuBusyPercent(), 100);
  resetLoadAwareTimeoutCachesForTesting();
  assert.equal(hostCpuBusyPercent(), 0);
});

test('local config disables scaling and sets the multiplier cap', t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const topPath = process.env.AGENT_OS_CONFIG_PATH;
  const localPath = join(dirname(topPath), 'config.local.yaml');
  const cfg = loadConfig({ topPath, env: {} });
  assert.equal(cfg.get('adversarial.reviewer.load_aware.enabled'), true);
  assert.equal(cfg.get('adversarial.reviewer.load_aware.max_multiplier'), 6);
  writeFileSync(localPath, 'adversarial:\n  reviewer:\n    load_aware:\n      enabled: false\n      max_multiplier: 2.5\n');
  assert.equal(loadAwareTimeoutMs(200, { loadAvg1m: 12, cpuCount: 4, cpuBusyPercent: 100 }), 200);
  assert.equal(loadAwareTimeoutSeconds(200, { loadAvg1m: 12, cpuCount: 4, cpuBusyPercent: 100 }), 200);
  writeFileSync(localPath, 'adversarial:\n  reviewer:\n    load_aware:\n      enabled: true\n      max_multiplier: 2.5\n');
  now = 5000;
  assert.equal(loadAwareTimeoutMs(200, { loadAvg1m: 12, cpuCount: 4, cpuBusyPercent: 100 }), 500);
  // The cached policy refreshes without waiting in real time.
  const parsed = loadConfig({ topPath, env: {} });
  assert.equal(parsed.get('adversarial.reviewer.load_aware.max_multiplier'), 2.5);
  for (const bad of ['enabled: invalid', 'max_multiplier: 0', 'max_multiplier: invalid']) {
    writeFileSync(localPath, `adversarial:\n  reviewer:\n    load_aware:\n      ${bad}\n`);
    assert.throws(() => loadConfig({ topPath, env: {} }), /adversarial.reviewer.load_aware/);
  }
});

test('load-aware config accepts multiplier bounds 1 and 20 and rejects values outside them', () => {
  const topPath = process.env.AGENT_OS_CONFIG_PATH;
  const localPath = join(dirname(topPath), 'config.local.yaml');
  for (const value of [1, 20]) {
    writeFileSync(localPath, `adversarial:\n  reviewer:\n    load_aware:\n      max_multiplier: ${value}\n`);
    assert.equal(loadConfig({ topPath, env: {} }).get('adversarial.reviewer.load_aware.max_multiplier'), value);
  }
  for (const [value, error] of [[0.5, /below minimum 1/], [21, /above maximum 20/]]) {
    writeFileSync(localPath, `adversarial:\n  reviewer:\n    load_aware:\n      max_multiplier: ${value}\n`);
    assert.throws(() => loadConfig({ topPath, env: {} }), {
      name: 'AgentOSConfigError',
      message: error,
      key: 'adversarial.reviewer.load_aware.max_multiplier',
    });
  }
});

test('GitHub default and all quota readers scale at the call site', async t => {
  syntheticBusyHost(t);
  const rootDir = dirname(process.env.AGENT_OS_CONFIG_PATH);
  let ghTimeout;
  await execGhWithRetry({ env: {}, retries: 0, args: ['api', 'repos/example/project'],
    execFileImpl: async (_cmd, _args, options) => { ghTimeout = options.timeout; return { stdout: '{}' }; } });
  assert.equal(ghTimeout, GH_LOOKUP_TIMEOUT_MS * 6);
  await execGhWithRetry({ env: {}, retries: 0, timeoutMs: 17, args: ['api', 'repos/example/project'],
    execFileImpl: async (_cmd, _args, options) => { assert.equal(options.timeout, 17); return { stdout: '{}' }; } });
  const budgets = [];
  const stdout = JSON.stringify({ providerStatuses: [{ provider: 'openai', authPath: 'oauth', state: 'ok' }] });
  const execFileImpl = async (_cmd, args, options) => {
    assert.deepEqual(args, ['fleet', 'quota', 'status', '--json']);
    budgets.push(options.timeout);
    return { stdout };
  };
  await readAfhReviewerGrounding({ env: {}, execFileImpl, includeFleetQuotaStatus: true });
  await resolveCloserDispatchHarness({ rootDir, env: {}, execFileImpl, workerClass: 'hammer', codexAccountPolicy: 'pinned' });
  await readFleetQuotaStatuses({ env: {}, execFileImpl });
  await resolveRemediationWorkerClassWithFallback({ env: {}, execFileImpl, primary: 'codex', codexAccountPolicy: 'pinned' });
  await resolveReviewerWorkerClassWithFallback({ env: {}, execFileImpl, primary: 'codex', fallbackWorkerClasses: ['claude-code'], authorClass: 'gemini', logger: quiet });
  collectBurstQuotaSignal({ env: {}, execFileSyncImpl: (_cmd, args, options) => {
    budgets.push(options.timeout); return stdout;
  } });
  const revalidator = createQuotaHoldRevalidator({ env: {}, execFileImpl });
  await revalidator.prefetch({ harnesses: ['codex'] });
  const poll = createWatcherReviewerQuotaPollFactory({ env: {}, logger: quiet })(execFileImpl);
  await poll.getGrounding();
  assert.equal(budgets.length, 8);
  assert.deepEqual(budgets, Array(8).fill(FLEET_QUOTA_STATUS_TIMEOUT_MS * 6));
});

test('rate-limit lock waits scale while the retry interval stays fixed', async t => {
  syntheticBusyHost(t);
  let now = 0;
  const rootDir = dirname(process.env.AGENT_OS_CONFIG_PATH);
  const throttle = createRateLimitThrottle({
    env: { GHO_RATE_LIMIT_SHARED_STATE_PATH: join(rootDir, 'state.json') },
    nowMs: () => now,
    mkdirImpl: async target => { if (target.endsWith('.lock')) throw Object.assign(new Error('busy'), { code: 'EEXIST' }); },
    statImpl: async () => ({ mtimeMs: now }),
    sleepImpl: async ms => { assert.equal(ms, 50); now += 30_000; },
    logger: quiet,
  });
  await assert.rejects(throttle.recordResponseRateLimit({ remaining: 100, resetAt: new Date(300_000).toISOString() }), /Timed out waiting/);
  assert.equal(now, 180_000);
});

test('posted-review deadlines scale while phase cadence stays fixed', async t => {
  syntheticBusyHost(t);
  assert.equal(resolvePostedReviewPhaseBudgetMs({}), 600_000);
  assert.equal(resolveMergeAgentCoexistenceStepDeadlineMs({}), 87_500 * 6);
  assert.equal(resolveMergeAgentCoexistenceOperationTimeoutMs({}), 60_000 * 6);
  const timers = [];
  await runPostedReviewHandlersFairly({ handlers: [{ repoPath: 'example/project', prNumber: 1, run: async () => ({}) }],
    rootDir: dirname(process.env.AGENT_OS_CONFIG_PATH), logger: quiet,
    setTimeoutFn: (_fn, ms) => { timers.push(ms); return 1; }, clearTimeoutFn() {},
  });
  assert.ok(timers.some(ms => ms > 180_000 && ms <= 600_000));
  let probeBudget;
  t.mock.method(globalThis, 'setTimeout', (_fn, ms) => { if (ms !== 5000) probeBudget = ms; return { unref() {} }; });
  await preparePostedReviewHandlers([{ repoPath: 'example/project', prNumber: 1, headSha: 'head' }], {
    logger: quiet, readReviewRow: () => ({ review_status: 'posted', reviewer_head_sha: 'head' }),
    resolveSettled: () => ({ verdict: 'approved', remediationPending: false }),
    fetchSnapshot: async () => ({ headRefOid: 'head', state: 'OPEN' }),
  });
  assert.equal(probeBudget, 60_000);
});


test('invalid local config degrades timeout sizing and caches failure until recovery', t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  const originalLoad = __testYamlHooks.load;
  let reads = 0;
  t.mock.method(__testYamlHooks, 'load', (...args) => { reads++; return originalLoad(...args); });
  const localPath = join(dirname(process.env.AGENT_OS_CONFIG_PATH), 'config.local.yaml');
  const opts = { loadAvg1m: 12, cpuCount: 4, cpuBusyPercent: 100 };
  writeFileSync(localPath, 'adversarial: [\n'); // Malformed YAML, not an unread sibling key.
  assert.equal(loadAwareTimeoutMs(200, opts), 1200);
  const failedReads = reads;
  for (let i = 0; i < 100; i++) {
    assert.equal(loadAwareTimeoutSeconds(200, opts), 1200);
    assert.equal(loadAwareTimeoutMs(200, { ...opts, loadAvg1m: 0 }), 200);
  }
  assert.equal(reads, failedReads);
  assert.equal(warnings.length, 1);
  now = 5000;
  assert.equal(loadAwareTimeoutMs(200, opts), 1200);
  assert.equal(warnings.length, 2);
  writeFileSync(localPath, 'adversarial:\n  reviewer:\n    load_aware:\n      max_multiplier: 25\n');
  now = 10000;
  assert.equal(loadAwareTimeoutMs(200, opts), 1200);
  assert.equal(warnings.length, 3);
  writeFileSync(localPath, 'adversarial:\n  reviewer:\n    load_aware:\n      enabled: false\n');
  now = 15000;
  assert.equal(loadAwareTimeoutMs(200, opts), 200);
  assert.equal(warnings.length, 3);
});

test('GitHub reads survive a running service config typo and recover its policy', async t => {
  syntheticBusyHost(t);
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  const localPath = join(dirname(process.env.AGENT_OS_CONFIG_PATH), 'config.local.yaml');
  const readTimeout = async () => {
    let timeout;
    await execGhWithRetry({ env: {}, retries: 0, args: ['api', 'repos/example/project'],
      execFileImpl: async (_cmd, _args, options) => { timeout = options.timeout; return { stdout: '{}' }; } });
    return timeout;
  };
  writeFileSync(localPath, 'adversarial:\n  reviewer:\n    load_aware:\n      enabled: false\n');
  assert.equal(await readTimeout(), GH_LOOKUP_TIMEOUT_MS);
  writeFileSync(localPath, 'adversarial:\n  reviewer:\n    load_aware:\n      max_multiplier: 25\n');
  now = 4999;
  assert.equal(await readTimeout(), GH_LOOKUP_TIMEOUT_MS);
  now = 5000;
  assert.equal(await readTimeout(), GH_LOOKUP_TIMEOUT_MS * 6);
  assert.equal(warnings.length, 1);
  writeFileSync(localPath, 'adversarial:\n  reviewer:\n    load_aware:\n      max_multiplier: 2\n');
  now = 9999;
  assert.equal(await readTimeout(), GH_LOOKUP_TIMEOUT_MS * 6);
  now = 10000;
  assert.equal(await readTimeout(), GH_LOOKUP_TIMEOUT_MS * 2);
  assert.equal(warnings.length, 1);
});

for (const pressure of [false, true]) {
  for (const maxMultiplier of [6, 20]) {
    test(`loaded adoption starts handlers after preparation: pressure=${pressure}, cap=${maxMultiplier}`, async t => {
      syntheticBusyHost(t);
      t.mock.method(os, 'loadavg', () => [os.cpus().length * 10, 0, 0]);
      const rootDir = dirname(process.env.AGENT_OS_CONFIG_PATH);
      writeFileSync(join(rootDir, 'config.local.yaml'),
        `adversarial:\n  reviewer:\n    load_aware:\n      max_multiplier: ${maxMultiplier}\n`);
      let now = 0;
      t.mock.method(Date, 'now', () => now);
      let started = 0;
      const deadlines = [];
      await runQueuedReviewAdoptionPhase({
        rootDir, logger: quiet, recoveryRoots: new Set([rootDir]),
        drainReviewerDispatchCandidates: async () => ({ deferred: pressure ? 1 : 0 }),
        postedReviewHandlers: [{ repoPath: 'example/project', prNumber: 1, run: async () => { started++; } }],
        noProgressLaneGate: { evaluate: () => ({ run: true }) },
        retryPendingMergeAgentLifecycleCleanupsImpl: async () => {},
        syncPRLifecycleImpl: async () => {},
        retryPendingCloserCancelsImpl: async () => {},
        sweepRereviewWakeQueueImpl: () => ({ scanned: 0 }),
        rereviewWakeBacklogImpl: () => ({ pending: 0 }),
        retryPendingTriageSyncsImpl: async () => ({ attempted: 0 }),
        retryPendingDagAutowalkOnMergeImpl: async () => {},
        retryPendingMergeCloseoutsImpl: async () => {},
        retryPendingRetriggerAckCommentsImpl: async () => ({ attempted: 0 }),
        reportStalledRetriggerOutcomesImpl: async () => ({ checked: 0 }),
        retryPendingRetriggerReviewAckCommentsImpl: async () => ({ attempted: 0 }),
        preparePostedReviewHandlersImpl: async (handlers, { deadlineAt }) => {
          now = deadlineAt; // Preparation consumes its entire allowed share.
          return handlers;
        },
        runPostedReviewHandlersFairlyImpl: async options => {
          assert.equal(options.minimumHandlerStartBudgetMs, 87_500);
          assert.equal(resolveNominalMergeAgentCoexistenceStepDeadlineMs({}), 87_500);
          const summary = await runPostedReviewHandlersFairly({ ...options,
            setTimeoutFn: (_fn, ms) => { deadlines.push(ms); return 1; }, clearTimeoutFn() {},
          });
          assert.equal(summary.ran, 1);
          assert.equal(summary.deferredByBudget, 0);
          assert.deepEqual(deadlines, [options.budgetMs - now]);
          return summary;
        },
      });
      assert.equal(started, 1);
    });
  }
}

test('scaled handler timeout yields at the remaining phase deadline', async t => {
  syntheticBusyHost(t);
  let now = 200_000;
  let expire;
  const summary = await runPostedReviewHandlersFairly({
    phaseStartedMs: 0, budgetMs: 360_000, nowMs: () => now, logger: quiet,
    handlers: [{ repoPath: 'example/project', prNumber: 1, run: () => {
      now = 360_000;
      expire();
      return new Promise(() => {});
    } }],
    setTimeoutFn: (fn, ms) => { assert.equal(ms, 160_000); expire = fn; return 1; },
    clearTimeoutFn() {},
  });
  assert.equal(summary.timedOut, 1);
  assert.equal(now, 360_000);
});
