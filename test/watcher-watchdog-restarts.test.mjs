import test from 'node:test';
import assert from 'node:assert/strict';
import { createWatcherHeartbeat } from '../src/watcher-heartbeat.mjs';
import { createPollStarvationHandler, createPollStarvationRestartRequester } from '../src/watcher-poll-starvation-signal.mjs';

const minute = 60_000;
const logger = { error() {}, warn() {} };
function fixture() {
  let stored = '{}';
  const alerts = [], exits = [];
  return { alerts, exits,
    async restart(atMs, inFlightMs) {
      // Each call constructs the next process using only persisted state.
      const heartbeat = createWatcherHeartbeat({ filePath: '/synthetic/heartbeat.json',
        readFile: () => stored, writeFile: (_path, content) => { stored = content; },
        now: () => new Date(atMs), logger });
      heartbeat.persist('startup');
      const handler = createPollStarvationHandler({ getHeartbeat: () => heartbeat,
        deliverAlertFn: async (text, meta) => { alerts.push({ text, ...meta }); },
        requestRestartFn: createPollStarvationRestartRequester({
          exitAfterReviewerCleanup: exit => exits.push(exit), exitCode: 75 }), logger });
      handler({ inFlightMs, noProgressMs: inFlightMs, starvationMs: 15 * minute,
        checks: 3, heartbeat: heartbeat.snapshot() });
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('WATCHERSTARVE-01: the second watchdog respawn within an hour pages once with both durations', async () => {
  const h = fixture();
  await h.restart(20 * minute, 20 * minute);
  await h.restart(45 * minute, 25 * minute);
  await h.restart(65 * minute, 20 * minute);
  const pages = h.alerts.filter(alert => alert.event === 'adversarial_review.poll_starvation_restart_loop');
  assert.equal(pages.length, 1);
  assert.equal(h.alerts.length, 2, 'only the first starvation alert and one loop page are emitted');
  assert.deepEqual(pages[0].payload.restart_durations_ms, [20 * minute, 25 * minute]);
  assert.match(pages[0].text, /20m.*25m/);
  assert.equal(h.exits.length, 3, 'the guard must retain recovery and reviewer preservation');
  assert.ok(h.exits.every(exit => exit.code === 75 && exit.preserveInFlightReviewers !== false));
});

test('restart-loop paging rearms after a quiet hour and excludes older restarts', async () => {
  const h = fixture();
  await h.restart(20 * minute, 20 * minute);
  await h.restart(45 * minute, 25 * minute);
  await h.restart(120 * minute, 20 * minute);
  assert.equal(h.alerts.filter(alert => alert.event.endsWith('restart_loop')).length, 1);
  await h.restart(145 * minute, 25 * minute);
  assert.equal(h.alerts.filter(alert => alert.event.endsWith('restart_loop')).length, 2);
});

test('queued review heartbeat writes cannot erase restart history', async () => {
  let stored = '{}';
  let now = 0;
  const makeHeartbeat = () => createWatcherHeartbeat({ filePath: '/synthetic/heartbeat.json',
    readFile: () => stored, writeFile: (_path, content) => { stored = content; },
    now: () => new Date(now), logger });
  const first = makeHeartbeat();
  first.markReview(); // queued with a snapshot taken before the restart record
  now = 20 * minute;
  first.recordStarvationRestart({ inFlightMs: 20 * minute });
  await first.flush();
  now = 45 * minute;
  const second = makeHeartbeat();
  const state = second.recordStarvationRestart({ inFlightMs: 25 * minute });
  assert.equal(state.restartLoop, true);
  assert.deepEqual(state.restarts.map(entry => entry.in_flight_ms), [20 * minute, 25 * minute]);
});
