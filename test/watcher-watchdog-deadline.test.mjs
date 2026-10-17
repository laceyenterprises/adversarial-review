import test from 'node:test';
import assert from 'node:assert/strict';
import { createWatcherHeartbeat, createWatcherStallWatchdog } from '../src/watcher-heartbeat.mjs';
import { resolvePollStarvationConfig, createPollWatchdogBudget, trackPollHandlerProgress } from '../src/watcher-poll-starvation-signal.mjs';
import { computeWorkloadAwarePollDeadlineMs } from '../src/watcher-poll-guard.mjs';

const minute = 60_000;
const logger = { error() {}, warn() {} };
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

test('WATCHERSTARVE-01: a 25 minute poll completing handlers between checks survives', () => {
  const h = fixture(15 * minute);
  for (let elapsed = 30_000; elapsed <= 25 * minute; elapsed += 30_000) {
    h.at(elapsed);
    if (elapsed % (5 * minute) === 0) h.heartbeat.markPollProgress?.({ phase: 'handler-completed' });
    h.watchdog.checkStarvation();
    assert.equal(h.exits.length, 0, `productive poll killed at ${elapsed}ms`);
  }
  h.watchdog.endPoll();
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

test('WATCHERSTARVE-01: defaults and low overrides exceed every workload deadline with a margin', () => {
  for (const activeRepoCount of [0, 1, 4]) {
    const pollDeadlineMs = computeWorkloadAwarePollDeadlineMs({ activeRepoCount });
    for (const env of [{}, { ADVERSARIAL_WATCHER_POLL_STARVATION_MS: '1' }]) {
      const resolved = resolvePollStarvationConfig({ env, intervalMs: 5 * minute, pollDeadlineMs });
      assert.ok(resolved.starvationMs > pollDeadlineMs);
    }
  }
});

test('budget refresh keeps the detector and poll on the same changing deadline and logs both', () => {
  let deadline = 30 * minute;
  const logs = [];
  const budget = createPollWatchdogBudget({ getDeadlineMs: () => deadline,
    env: { ADVERSARIAL_WATCHER_POLL_STARVATION_MS: '1' }, intervalMs: 5 * minute,
    logger: { log: message => logs.push(message) } });
  const h = fixture(() => budget.starvationMs);
  assert.equal(h.watchdog.getState().starvationMs, 31 * minute);
  deadline = 60 * minute;
  budget.refresh();
  budget.refresh();
  assert.equal(budget.deadlineMs, deadline);
  assert.equal(h.watchdog.getState().starvationMs, 61 * minute);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /poll deadline changed: 3600s.*poll-starvation respawn: 3660s/);
  h.at(32 * minute);
  for (let check = 0; check < 3; check++) h.watchdog.checkStarvation();
  assert.equal(h.exits.length, 0, 'a deadline increase must reach the active detector');
  deadline = 30 * minute;
  budget.refresh();
  assert.equal(budget.starvationMs, 31 * minute);
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
