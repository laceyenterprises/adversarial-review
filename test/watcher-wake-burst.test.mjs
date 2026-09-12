import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requestWatcherWake, watcherWakeMatchesSubject } from "../src/watcher-wake.mjs";

// The wake file is one slot that renameSync overwrites. Before this fix, a
// burst of settled-clean PRs kept only the last wake, so with N clean PRs
// settling in one drainer pass N-1 lost priority and fell back to poll
// latency -- the exact backlog the hammer wake exists to clear.

function wakePayload(root) {
  return JSON.parse(readFileSync(join(root, "data", "watcher-wake.json"), "utf8"));
}

test("a burst of wakes keeps every subject, not just the last", () => {
  const root = mkdtempSync(join(tmpdir(), "wake-burst-"));
  for (const prNumber of [101, 102, 103]) {
    requestWatcherWake({ rootDir: root, reason: "clean-verdict-to-hammer", repo: "o/r", prNumber });
  }
  const payload = wakePayload(root);
  for (const prNumber of [101, 102, 103]) {
    assert.equal(
      watcherWakeMatchesSubject(payload, { repoPath: "o/r", prNumber }),
      true,
      `PR ${prNumber} lost its wake`
    );
  }
});

test("newest request still occupies the legacy top-level fields", () => {
  const root = mkdtempSync(join(tmpdir(), "wake-compat-"));
  requestWatcherWake({ rootDir: root, reason: "r", repo: "o/r", prNumber: 101 });
  requestWatcherWake({ rootDir: root, reason: "r", repo: "o/r", prNumber: 102 });
  const payload = wakePayload(root);
  assert.equal(payload.repo, "o/r");
  assert.equal(payload.pr_number, 102);
});

test("a non-matching PR is still not woken", () => {
  const root = mkdtempSync(join(tmpdir(), "wake-neg-"));
  requestWatcherWake({ rootDir: root, reason: "r", repo: "o/r", prNumber: 101 });
  const payload = wakePayload(root);
  assert.equal(watcherWakeMatchesSubject(payload, { repoPath: "o/r", prNumber: 999 }), false);
  assert.equal(watcherWakeMatchesSubject(payload, { repoPath: "other/r", prNumber: 101 }), false);
});

test("head-pinned subjects still require a head match", () => {
  const root = mkdtempSync(join(tmpdir(), "wake-head-"));
  requestWatcherWake({ rootDir: root, reason: "r", repo: "o/r", prNumber: 101, headSha: "aaa" });
  const payload = wakePayload(root);
  assert.equal(watcherWakeMatchesSubject(payload, { repoPath: "o/r", prNumber: 101, headSha: "aaa" }), true);
  assert.equal(watcherWakeMatchesSubject(payload, { repoPath: "o/r", prNumber: 101, headSha: "bbb" }), false);
});

test("the carried list is bounded", () => {
  const root = mkdtempSync(join(tmpdir(), "wake-cap-"));
  for (let i = 1; i <= 80; i += 1) {
    requestWatcherWake({ rootDir: root, reason: "r", repo: "o/r", prNumber: i });
  }
  const payload = wakePayload(root);
  assert.ok(payload.pending_subjects.length <= 64, `unbounded: ${payload.pending_subjects.length}`);
  assert.equal(watcherWakeMatchesSubject(payload, { repoPath: "o/r", prNumber: 80 }), true);
});
