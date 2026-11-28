import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import {
  WATCHER_AUTH_REFRESH_INTERVAL_MS,
  refreshWatcherAuthenticationForTick,
  startWatcherAuthenticationRefreshTimer,
  startWatcherRecoveryTimers,
} from "../src/watcher-tick-preflight.mjs";

const silent = { log() {}, warn() {} };

for (const [first, second] of [["SIGTERM", "SIGTERM"], ["SIGINT", "SIGINT"], ["SIGTERM", "SIGINT"]]) {
  test(`recovery sweeps run outside discovery and stop once on ${first} then ${second}`, async () => {
    const signals = new EventEmitter();
    const timers = [];
    let retries = 0, deadlines = 0, stops = 0;
    const readLive = async () => {};
    startWatcherRecoveryTimers({
      rootDir: "/synthetic", signals, readLive,
      overloadRescueRetry: { tick: () => { retries++; } },
      createSweep: options => {
        assert.deepEqual(options, { rootDir: "/synthetic", readLive });
        return { tick: () => { deadlines++; }, stop: async () => { stops++; throw new Error("synthetic stop failure"); } };
      },
      setIntervalImpl: (fn, ms) => {
        const timer = { fn, ms, referenced: true, unref() { this.referenced = false; return this; } };
        timers.push(timer);
        return timer;
      },
      clearIntervalImpl: timer => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      },
    });
    assert.deepEqual([retries, deadlines], [1, 1], "both sweeps start before discovery");
    assert.ok(timers.every(timer => timer.ms === 30_000 && !timer.referenced));
    for (const timer of timers) timer.fn();
    assert.deepEqual([retries, deadlines], [2, 2]);
    const [overloadTimer] = timers;
    signals.emit(first);
    signals.emit(second);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stops, 1, "successor sweep stops once across both shutdown signals");
    assert.deepEqual(timers, []);
    overloadTimer.fn();
    assert.equal(retries, 2, "a queued overload callback cannot start recovery after shutdown");
  });
}

// Drives the timer callback by hand instead of waiting on real time.
function fakeInterval() {
  const state = { fn: null, ms: null, unrefs: 0 };
  const setIntervalImpl = (fn, ms) => {
    state.fn = fn;
    state.ms = ms;
    return { unref: () => { state.unrefs += 1; } };
  };
  return { state, setIntervalImpl };
}

test("refresh cadence is well under the ~55 min token lifetime", () => {
  // SEV0 2026-09-06: 54 minutes of drains ran inside ONE tick against a ~55 min
  // App installation token. Any interval near the token lifetime reintroduces
  // that failure, so this asserts real headroom rather than merely "a timer".
  assert.ok(
    WATCHER_AUTH_REFRESH_INTERVAL_MS <= 10 * 60 * 1000,
    `refresh interval ${WATCHER_AUTH_REFRESH_INTERVAL_MS}ms is too close to the token lifetime`
  );
});

test("the timer refreshes independently of tick duration", async () => {
  const { state, setIntervalImpl } = fakeInterval();
  let calls = 0;
  startWatcherAuthenticationRefreshTimer({
    log: silent,
    refreshImpl: async () => { calls += 1; },
    setIntervalImpl,
  });
  assert.equal(state.ms, WATCHER_AUTH_REFRESH_INTERVAL_MS);
  // Three firings with no poll tick in between -- the case the per-tick refresh
  // could not cover, because the tick had not ended.
  for (let i = 0; i < 3; i += 1) {
    state.fn();
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(calls, 3);
});

test("a slow refresh never overlaps itself", async () => {
  const { state, setIntervalImpl } = fakeInterval();
  let started = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  startWatcherAuthenticationRefreshTimer({
    log: silent,
    refreshImpl: async () => { started += 1; await gate; },
    setIntervalImpl,
  });
  state.fn();
  await new Promise((r) => setImmediate(r));
  state.fn();           // fires while the first is still in flight
  state.fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(started, 1, "overlapping refreshes would waste broker calls");
  release();
  await new Promise((r) => setImmediate(r));
});

test("tick and timer refreshes share the exported in-flight lock", async () => {
  let reviewerRefreshes = 0;
  let watcherRefreshes = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const options = {
    log: silent,
    refreshReviewerBrokerTokensImpl: async () => { reviewerRefreshes += 1; await gate; },
    refreshWatcherGithubTokenImpl: async () => { watcherRefreshes += 1; return { refreshed: true }; },
  };

  const first = refreshWatcherAuthenticationForTick(options);
  await new Promise((r) => setImmediate(r));
  const second = refreshWatcherAuthenticationForTick(options);

  assert.equal(reviewerRefreshes, 1, "tick/timer overlap should not duplicate broker refreshes");
  assert.equal(watcherRefreshes, 0, "the joined refresh waits for the original mint");

  release();
  assert.deepEqual(await second, await first);
  assert.deepEqual((await second).service, { refreshed: true });
  assert.equal(watcherRefreshes, 1);
});

test("a failing refresh never throws out of the timer", async () => {
  const { state, setIntervalImpl } = fakeInterval();
  let warned = 0;
  startWatcherAuthenticationRefreshTimer({
    log: { log() {}, warn() { warned += 1; } },
    refreshImpl: async () => { throw new Error("broker unreachable"); },
    setIntervalImpl,
  });
  state.fn();
  await new Promise((r) => setImmediate(r));
  // An unhandled rejection here would kill the watcher, which is strictly worse
  // than a stale token.
  assert.equal(warned, 1);
});

test("the timer does not hold the event loop open", () => {
  const { state, setIntervalImpl } = fakeInterval();
  startWatcherAuthenticationRefreshTimer({
    log: silent,
    refreshImpl: async () => {},
    setIntervalImpl,
  });
  assert.equal(state.unrefs, 1);
});
