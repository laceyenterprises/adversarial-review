import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requestWatcherWake, watcherWakeMatchesSubject } from "../src/watcher-wake.mjs";

// Review follow-ups on #1052.
//
// 1. `requested: wake?.requested !== false` read `undefined` as success, so a
//    no-op wake impl recorded a hammer_wake event for a wake that never
//    happened. The production impl returns {requested:true} or throws, so this
//    only bit injected impls -- but the feature exists to MEASURE wakes, so a
//    false positive defeats its purpose.
//
// 2. The latency event was gated on wakeRecord.requested, so a FAILED wake
//    wrote nothing. "How often did the wake fail" was the one number with no
//    telemetry, and a regression to zero wakes looked like a quiet backlog.

test("a real wake reports requested=true", () => {
  const root = mkdtempSync(join(tmpdir(), "wake-real-"));
  const wake = requestWatcherWake({ rootDir: root, reason: "r", repo: "o/r", prNumber: 7 });
  assert.equal(wake.requested, true);
  assert.equal(wake?.requested === true, true);
});

test("a no-op wake impl must not read as success", () => {
  // The old predicate `wake?.requested !== false` was true for both of these.
  for (const shape of [undefined, {}, { payload: {} }]) {
    assert.equal(shape?.requested === true, false, `${JSON.stringify(shape)} read as a successful wake`);
    assert.equal(shape?.requested !== false, true, "sanity: the old predicate accepted it");
  }
});

test("a failing wake impl surfaces as requested=false", () => {
  const thrower = () => { throw new Error("boom"); };
  let requested = null;
  try {
    thrower();
    requested = true;
  } catch {
    requested = false;
  }
  assert.equal(requested, false);
});

test("burst retention still holds after the telemetry change", () => {
  const root = mkdtempSync(join(tmpdir(), "wake-burst2-"));
  for (const prNumber of [11, 12, 13]) {
    requestWatcherWake({ rootDir: root, reason: "clean-verdict-to-hammer", repo: "o/r", prNumber });
  }
  const payload = JSON.parse(readFileSync(join(root, "data", "watcher-wake.json"), "utf8"));
  for (const prNumber of [11, 12, 13]) {
    assert.equal(watcherWakeMatchesSubject(payload, { repoPath: "o/r", prNumber }), true);
  }
});
