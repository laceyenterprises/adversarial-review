import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

// The watcher never writes back what it consumed, so without an age bound the
// carried list was "the last 64 wakes": on 2026-09-27 it held 64 entries for
// 34 PRs, 57 of them merged or closed, and four open PRs kept tier-0 wake
// priority long after their wake was served.

const T0 = Date.parse("2026-09-27T16:00:00.000Z");
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();

test("carried subjects older than the TTL are dropped on the next wake", () => {
  const root = mkdtempSync(join(tmpdir(), "wake-ttl-"));
  requestWatcherWake({ rootDir: root, reason: "r", repo: "o/r", prNumber: 101, requestedAt: at(0) });
  requestWatcherWake({ rootDir: root, reason: "r", repo: "o/r", prNumber: 102, requestedAt: at(25) });
  requestWatcherWake({ rootDir: root, reason: "r", repo: "o/r", prNumber: 103, requestedAt: at(31) });
  const payload = wakePayload(root);
  assert.equal(watcherWakeMatchesSubject(payload, { repoPath: "o/r", prNumber: 101 }), false);
  assert.equal(watcherWakeMatchesSubject(payload, { repoPath: "o/r", prNumber: 102 }), true);
  assert.equal(watcherWakeMatchesSubject(payload, { repoPath: "o/r", prNumber: 103 }), true);
  for (const subject of payload.pending_subjects) {
    assert.ok(subject.requested_at, `unstamped subject ${JSON.stringify(subject)}`);
  }
});

test("a re-wake refreshes a subject's time instead of keeping the stale one", () => {
  const root = mkdtempSync(join(tmpdir(), "wake-refresh-"));
  requestWatcherWake({ rootDir: root, reason: "r", repo: "o/r", prNumber: 101, requestedAt: at(0) });
  requestWatcherWake({ rootDir: root, reason: "r", repo: "o/r", prNumber: 101, requestedAt: at(20) });
  requestWatcherWake({ rootDir: root, reason: "r", repo: "o/r", prNumber: 102, requestedAt: at(45) });
  const payload = wakePayload(root);
  assert.equal(watcherWakeMatchesSubject(payload, { repoPath: "o/r", prNumber: 101 }), true);
  const entries = payload.pending_subjects.filter((s) => s.pr_number === 101);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].requested_at, at(20));
});

test("legacy untimed subjects inherit the file time and age out", () => {
  const root = mkdtempSync(join(tmpdir(), "wake-legacy-"));
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(
    join(root, "data", "watcher-wake.json"),
    JSON.stringify({
      schema_version: 1,
      request_id: "legacy",
      requested_at: at(0),
      reason: "r",
      repo: "o/r",
      pr_number: 100,
      pending_subjects: [
        { repo: "o/r", pr_number: 99 },
        { repo: "o/r", pr_number: 100 },
      ],
    })
  );
  requestWatcherWake({ rootDir: root, reason: "r", repo: "o/r", prNumber: 101, requestedAt: at(5) });
  let payload = wakePayload(root);
  assert.equal(watcherWakeMatchesSubject(payload, { repoPath: "o/r", prNumber: 99 }), true);
  requestWatcherWake({ rootDir: root, reason: "r", repo: "o/r", prNumber: 102, requestedAt: at(33) });
  payload = wakePayload(root);
  assert.equal(watcherWakeMatchesSubject(payload, { repoPath: "o/r", prNumber: 99 }), false);
  assert.equal(watcherWakeMatchesSubject(payload, { repoPath: "o/r", prNumber: 100 }), false);
  assert.equal(watcherWakeMatchesSubject(payload, { repoPath: "o/r", prNumber: 101 }), true);
});

test("the subject TTL honours the env override", () => {
  const root = mkdtempSync(join(tmpdir(), "wake-ttl-env-"));
  const env = { ADVERSARIAL_WATCHER_WAKE_SUBJECT_TTL_MS: String(5 * 60_000) };
  requestWatcherWake({ rootDir: root, reason: "r", repo: "o/r", prNumber: 101, requestedAt: at(0), env });
  requestWatcherWake({ rootDir: root, reason: "r", repo: "o/r", prNumber: 102, requestedAt: at(6), env });
  const payload = wakePayload(root);
  assert.equal(watcherWakeMatchesSubject(payload, { repoPath: "o/r", prNumber: 101 }), false);
  assert.equal(watcherWakeMatchesSubject(payload, { repoPath: "o/r", prNumber: 102 }), true);
});
