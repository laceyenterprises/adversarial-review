import test from 'node:test';
import assert from 'node:assert/strict';

import { createWatcherStallWatchdog } from '../src/watcher-heartbeat.mjs';

// Regression cover for the merge-lane livelock of 2026-09-20.
//
// The starvation watchdog's only liveness signal was `poll_counter`, which
// increments when a poll STARTS -- so across a single long poll it is static by
// construction and a busy poll was indistinguishable from a frozen one. The
// watcher self-killed FATAL, launchd respawned it, the next poll hit the same
// work and starved again. 66 FATALs; `last_completed_poll_at` stuck at 03:04Z
// while `last_poll_at` read 05:28Z, and nothing merged for hours.
//
// Merge actions run at the END of a poll, so every kill dropped that tick's
// merges, which grew the queue, which lengthened the next poll: a
// self-reinforcing loop.

function makeHeartbeat(initial = {}) {
  let snap = {
    poll_counter: 1,
    completed_poll_counter: 0,
    last_poll_at: '2026-09-20T04:43:39.295Z',
    last_review_at: null,
    last_spawn_decision_at: null,
    ...initial,
  };
  return {
    snapshot: () => ({ ...snap }),
    set: (patch) => { snap = { ...snap, ...patch }; },
  };
}

// Drive the watchdog without real timers.
function harness({ heartbeat, starvationMs = 1000, starvationChecksRequired = 3 }) {
  let now = 0;
  const starvations = [];
  const wd = createWatcherStallWatchdog({
    heartbeat,
    starvationMs,
    starvationChecksRequired,
    nowMs: () => now,
    setIntervalFn: () => null,
    clearIntervalFn: () => {},
    onStarvation: (payload) => starvations.push(payload),
    logger: { error() {}, warn() {}, log() {} },
  });
  return {
    wd,
    starvations,
    advance(ms) { now += ms; },
    get now() { return now; },
  };
}

test('a poll making in-poll progress is never starved, however long it runs', () => {
  const heartbeat = makeHeartbeat();
  const h = harness({ heartbeat });

  h.wd.beginPoll();
  h.advance(5000); // well past starvationMs

  // The poll is walking subjects: spawn decisions land every check, exactly as
  // the live watcher did while it was being killed.
  for (let i = 0; i < 10; i += 1) {
    heartbeat.set({ last_spawn_decision_at: `2026-09-20T05:${String(20 + i).padStart(2, '0')}:00.000Z` });
    assert.equal(h.wd.checkStarvation(), false, `starved on check ${i} despite progress`);
    h.advance(1000);
  }
  assert.equal(h.starvations.length, 0, 'a busy poll must never be killed');
});

test('review progress alone also counts as liveness', () => {
  const heartbeat = makeHeartbeat();
  const h = harness({ heartbeat });

  h.wd.beginPoll();
  h.advance(5000);
  for (let i = 0; i < 6; i += 1) {
    heartbeat.set({ last_review_at: `2026-09-20T05:${String(30 + i).padStart(2, '0')}:00.000Z` });
    assert.equal(h.wd.checkStarvation(), false);
    h.advance(1000);
  }
  assert.equal(h.starvations.length, 0);
});

test('a genuinely frozen poll IS still killed — the guard keeps its teeth', () => {
  const heartbeat = makeHeartbeat();
  const h = harness({ heartbeat });

  h.wd.beginPoll();
  h.advance(5000);

  // No signal moves at all: this is the frozen loop the watchdog exists for.
  assert.equal(h.wd.checkStarvation(), false, 'check 1 of 3');
  assert.equal(h.wd.checkStarvation(), false, 'check 2 of 3');
  assert.equal(h.wd.checkStarvation(), true, 'must signal on the third consecutive no-progress check');
  assert.equal(h.starvations.length, 1);
  assert.ok(h.starvations[0].inFlightMs >= 5000);
});

test('progress RESETS the consecutive-check count rather than merely delaying the kill', () => {
  const heartbeat = makeHeartbeat();
  const h = harness({ heartbeat });

  h.wd.beginPoll();
  h.advance(5000);

  assert.equal(h.wd.checkStarvation(), false, 'no-progress check 1');
  assert.equal(h.wd.checkStarvation(), false, 'no-progress check 2');
  // One unit of real work lands right before the third check.
  heartbeat.set({ last_spawn_decision_at: '2026-09-20T05:40:00.000Z' });
  assert.equal(h.wd.checkStarvation(), false, 'progress must reset the series');
  // The series has to start over, so a single further check cannot kill.
  assert.equal(h.wd.checkStarvation(), false, 'post-reset check 1');
  assert.equal(h.wd.checkStarvation(), false, 'post-reset check 2');
  assert.equal(h.wd.checkStarvation(), true, 'post-reset check 3 signals');
  assert.equal(h.starvations.length, 1);
});

test('a completed poll counts as progress', () => {
  const heartbeat = makeHeartbeat();
  const h = harness({ heartbeat });

  h.wd.beginPoll();
  h.advance(5000);
  assert.equal(h.wd.checkStarvation(), false);
  heartbeat.set({ completed_poll_counter: 1 });
  assert.equal(h.wd.checkStarvation(), false, 'a completed poll is unambiguous progress');
  assert.equal(h.starvations.length, 0);
});

test('starvation is not evaluated before the in-flight threshold', () => {
  const heartbeat = makeHeartbeat();
  const h = harness({ heartbeat, starvationMs: 10_000 });

  h.wd.beginPoll();
  h.advance(500);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(h.wd.checkStarvation(), false);
  }
  assert.equal(h.starvations.length, 0);
});

test('the existing poll_counter escape still short-circuits', () => {
  const heartbeat = makeHeartbeat();
  const h = harness({ heartbeat });

  h.wd.beginPoll();
  h.advance(5000);
  // A re-entrant/externally-driven poll advanced the counter under us.
  heartbeat.set({ poll_counter: 2 });
  assert.equal(h.wd.checkStarvation(), false);
  assert.equal(h.starvations.length, 0);
});
