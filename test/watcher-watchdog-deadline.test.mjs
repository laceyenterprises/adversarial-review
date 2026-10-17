import test from 'node:test';
import assert from 'node:assert/strict';
import { createWatcherHeartbeat, createWatcherStallWatchdog } from '../src/watcher-heartbeat.mjs';
import { resolvePollStarvationConfig, createPollWatchdogBudget, trackPollHandlerProgress } from '../src/watcher-poll-starvation-signal.mjs';
import { computeWorkloadAwarePollDeadlineMs } from '../src/watcher-poll-guard.mjs';

const minute = 60_000;
const logger = { error() {}, warn() {} };
function workloadBudget(env = {}) {
  return createPollWatchdogBudget({
    getDeadlineMs: () => computeWorkloadAwarePollDeadlineMs({
      activeRepoCount: 2, reviewerTimeoutMs: 10 * minute,
    }),
    env, intervalMs: 5 * minute,
  });
}
function fixture(starvationMs) {
  let now = 0;
  const exits = [];
  const heartbeat = createWatcherHeartbeat({ filePath: '/synthetic/heartbeat.json',
    readFile: () => '{}', writeFile: () => {}, now: () => new Date(now), logger });
  const watchdog = createWatcherStallWatchdog({ heartbeat, starvationMs,
    nowMs: () => now, onStarvation: event => exits.push(event), logger });
  heartbeat.markPoll();
  watchdog.beginPoll();
  return { heartbeat, watchdog, exits, at: value => { now = value; } };
}

test('WATCHERSTARVE-02: a 25 minute poll completing handlers survives and a later hang still restarts', async () => {
  const budget = workloadBudget();
  const h = fixture(() => budget.starvationMs);
  const handler = trackPollHandlerProgress({ run: async () => 'completed' }, h.heartbeat);
  for (let elapsed = 30_000; elapsed <= 25 * minute; elapsed += 30_000) {
    h.at(elapsed);
    if (elapsed % (5 * minute) === 0) await handler.run();
    h.watchdog.checkStarvation();
    assert.equal(h.exits.length, 0, `productive poll killed at ${elapsed}ms`);
  }
  assert.equal(h.heartbeat.snapshot().poll_progress_counter, 5);
  // Prove that survival came from progress, rather than an hours-long threshold.
  h.at(40 * minute - 1);
  for (let check = 0; check < 3; check++) assert.equal(h.watchdog.checkStarvation(), false);
  h.at(40 * minute);
  assert.equal(h.watchdog.checkStarvation(), false);
  assert.equal(h.watchdog.checkStarvation(), false);
  assert.equal(h.watchdog.checkStarvation(), true);
  assert.equal(h.exits.length, 1);
  assert.equal(h.exits[0].noProgressMs, 15 * minute);
  h.watchdog.endPoll();
});

test('WATCHERSTARVE-02: a 60300 second workload deadline does not delay a frozen poll restart at 16 minutes', () => {
  const budget = workloadBudget();
  assert.equal(budget.deadlineMs, 60_300_000);
  assert.equal(budget.checksRequired, 3);
  const h = fixture(() => budget.starvationMs);
  for (const elapsed of [15 * minute, 15.5 * minute]) {
    h.at(elapsed);
    assert.equal(h.watchdog.checkStarvation(), false, 'three consecutive checks are required');
  }
  h.at(16 * minute);
  assert.equal(h.watchdog.checkStarvation(), true);
  assert.equal(h.watchdog.checkStarvation(), false, 'only one restart per poll');
  assert.equal(h.exits.length, 1);
  assert.equal(h.exits[0].starvationMs, 15 * minute);
  assert.equal(h.exits[0].noProgressMs, 16 * minute);
  assert.equal(h.exits[0].checks, 3);
});

test('WATCHERSTARVE-02: a 2700000 ms override is honoured exactly below the workload deadline', () => {
  const budget = workloadBudget({ ADVERSARIAL_WATCHER_POLL_STARVATION_MS: '2700000' });
  assert.equal(budget.deadlineMs, 60_300_000);
  const h = fixture(() => budget.starvationMs);
  h.at(2_700_000 - 1);
  for (let check = 0; check < 3; check++) assert.equal(h.watchdog.checkStarvation(), false);
  h.at(2_700_000);
  assert.equal(h.watchdog.checkStarvation(), false);
  assert.equal(h.watchdog.checkStarvation(), false);
  assert.equal(h.watchdog.checkStarvation(), true);
  assert.equal(budget.starvationMs, 2_700_000);
  assert.equal(h.exits[0].noProgressMs, 2_700_000);
});

test('WATCHERSTARVE-01: a hung poll gets a full no-progress threshold then one restart', () => {
  const h = fixture(1000);
  h.at(900);
  h.heartbeat.markSpawnDecision({ decision: 'synthetic-completion' });
  h.watchdog.checkStarvation();
  h.at(1100);
  h.watchdog.checkStarvation();
  h.watchdog.checkStarvation();
  h.watchdog.checkStarvation();
  h.watchdog.checkStarvation();
  assert.equal(h.exits.length, 0, 'recent progress must earn the whole threshold');
  h.at(1901);
  for (let check = 0; check < 5; check++) h.watchdog.checkStarvation();
  assert.equal(h.exits.length, 1, 'a genuinely hung poll still restarts exactly once');
  assert.equal(h.exits[0].noProgressMs, 1001);
});

test('WATCHERSTARVE-02: defaults and low overrides are independent of workload deadlines', () => {
  for (const activeRepoCount of [0, 1, 4]) {
    const pollDeadlineMs = computeWorkloadAwarePollDeadlineMs({ activeRepoCount });
    for (const env of [{}, { ADVERSARIAL_WATCHER_POLL_STARVATION_MS: '1' }]) {
      const resolved = resolvePollStarvationConfig({ env, intervalMs: 5 * minute, pollDeadlineMs });
      assert.equal(resolved.starvationMs, Object.keys(env).length ? 1 : 15 * minute);
    }
  }
});

test('budget refresh logs both values and keeps starvation independent of deadline increases and decreases', () => {
  let deadline = 30 * minute;
  const logs = [];
  const budget = createPollWatchdogBudget({ getDeadlineMs: () => deadline,
    env: { ADVERSARIAL_WATCHER_POLL_STARVATION_MS: '2700000' }, intervalMs: 5 * minute,
    logger: { log: message => logs.push(message) } });
  const h = fixture(() => budget.starvationMs);
  assert.equal(h.watchdog.getState().starvationMs, 45 * minute);
  deadline = 60_300_000;
  budget.refresh();
  budget.refresh();
  assert.equal(budget.deadlineMs, deadline);
  assert.equal(h.watchdog.getState().starvationMs, 45 * minute);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /poll deadline changed: 60300s.*poll-starvation respawn: 2700s × 3 checks/);
  h.at(32 * minute);
  for (let check = 0; check < 3; check++) h.watchdog.checkStarvation();
  assert.equal(h.exits.length, 0, 'the requested threshold has not elapsed');
  deadline = 30 * minute;
  budget.refresh();
  assert.equal(budget.starvationMs, 45 * minute);
  assert.match(logs[1], /poll deadline changed: 1800s.*poll-starvation respawn: 2700s × 3 checks/);
});

test('handler completion advances progress on success and failure, never on entry', async () => {
  const h = fixture(1000);
  let finish;
  const handler = { repoPath: 'sample/project', run: () => new Promise(resolve => { finish = resolve; }) };
  const tracked = trackPollHandlerProgress(handler, h.heartbeat);
  const pending = tracked.run();
  assert.equal(h.heartbeat.snapshot().poll_progress_counter, 0);
  finish('completed');
  assert.equal(await pending, 'completed');
  assert.equal(h.heartbeat.snapshot().poll_progress_counter, 1);
  assert.equal(tracked.repoPath, 'sample/project');
  const failed = trackPollHandlerProgress({ run() { throw new Error('synthetic failure'); } }, h.heartbeat);
  await assert.rejects(failed.run(), /synthetic failure/);
  assert.equal(h.heartbeat.snapshot().poll_progress_counter, 2);
});
