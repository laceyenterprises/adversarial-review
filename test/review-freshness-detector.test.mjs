// Review-freshness liveness alert (2026-07-26 SEV): the reviewer dispatch path
// silently failed for hours while the watcher marked failed spawns as
// review_status='posted', so nothing paged. This detector pages the pipeline's
// own subscribed alert channel, keyed on the ACTUAL last-posted-review time
// (recordPostedReview), never the maskable status.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  maybeFireReviewStalledAlert,
  recordPostedReview,
  readLastPostedReviewMs,
  REVIEW_STALL_THRESHOLD_MS,
  REVIEW_STALL_ALERT_DEBOUNCE_MS,
} from '../src/review-freshness-detector.mjs';

function tmpState() {
  return mkdtempSync(join(tmpdir(), 'review-freshness-'));
}

const T0 = 1_800_000_000_000; // fixed base "now"

test('no PRs awaiting review -> never pages', async () => {
  const stateDir = tmpState();
  try {
    const calls = [];
    const res = await maybeFireReviewStalledAlert({
      deliverAlertFn: async (t, s) => calls.push([t, s]),
      now: T0,
      pendingReviewCount: 0,
      stateDir,
    });
    assert.equal(res.fired, false);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('cold start seeds a baseline and does not page', async () => {
  const stateDir = tmpState();
  try {
    const calls = [];
    const res = await maybeFireReviewStalledAlert({
      deliverAlertFn: async (t, s) => calls.push([t, s]),
      now: T0,
      pendingReviewCount: 3,
      stateDir,
    });
    assert.equal(res.fired, false);
    assert.match(res.reason, /baseline/);
    assert.equal(calls.length, 0);
    assert.equal(readLastPostedReviewMs({ stateDir }), T0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('fresh reviews (age < threshold) do not page', async () => {
  const stateDir = tmpState();
  try {
    recordPostedReview(T0, { stateDir });
    const calls = [];
    const res = await maybeFireReviewStalledAlert({
      deliverAlertFn: async (t, s) => calls.push([t, s]),
      now: T0 + REVIEW_STALL_THRESHOLD_MS - 1,
      pendingReviewCount: 2,
      stateDir,
    });
    assert.equal(res.fired, false);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('stale posted-review + PRs awaiting -> pages once, then debounces', async () => {
  const stateDir = tmpState();
  try {
    recordPostedReview(T0, { stateDir });
    const calls = [];
    const deliver = async (t, s) => calls.push([t, s]);
    const now = T0 + REVIEW_STALL_THRESHOLD_MS + 60_000;

    const first = await maybeFireReviewStalledAlert({
      deliverAlertFn: deliver, now, pendingReviewCount: 4, stateDir,
    });
    assert.equal(first.fired, true);
    assert.equal(calls.length, 1);
    const [text, structured] = calls[0];
    assert.match(text, /reviewer STALLED/);
    assert.match(text, /4 PR\(s\)/);
    assert.equal(structured.event, 'adversarial_review.reviewer_stalled');
    assert.equal(structured.payload.pending_review_count, 4);

    // A second tick inside the debounce window does NOT re-page.
    const second = await maybeFireReviewStalledAlert({
      deliverAlertFn: deliver, now: now + REVIEW_STALL_ALERT_DEBOUNCE_MS - 1,
      pendingReviewCount: 4, stateDir,
    });
    assert.equal(second.fired, false);
    assert.equal(second.reason, 'debounced');
    assert.equal(calls.length, 1);

    // Past the debounce window, it re-pages (stall persists).
    const third = await maybeFireReviewStalledAlert({
      deliverAlertFn: deliver, now: now + REVIEW_STALL_ALERT_DEBOUNCE_MS + 1,
      pendingReviewCount: 4, stateDir,
    });
    assert.equal(third.fired, true);
    assert.equal(calls.length, 2);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a real posted review clears the stall (baseline advances)', async () => {
  const stateDir = tmpState();
  try {
    recordPostedReview(T0, { stateDir });
    const now = T0 + REVIEW_STALL_THRESHOLD_MS + 60_000;
    // A review actually lands at `now` — the ONLY thing that advances freshness.
    recordPostedReview(now, { stateDir });
    const calls = [];
    const res = await maybeFireReviewStalledAlert({
      deliverAlertFn: async (t, s) => calls.push([t, s]),
      now: now + 1, pendingReviewCount: 4, stateDir,
    });
    assert.equal(res.fired, false);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('delivery failure does not persist the debounce marker (retries next tick)', async () => {
  const stateDir = tmpState();
  try {
    recordPostedReview(T0, { stateDir });
    const now = T0 + REVIEW_STALL_THRESHOLD_MS + 60_000;
    let attempts = 0;
    const flaky = async () => { attempts += 1; if (attempts === 1) throw new Error('hooks down'); };
    const first = await maybeFireReviewStalledAlert({
      deliverAlertFn: flaky, now, pendingReviewCount: 1, stateDir,
      logger: { warn() {} },
    });
    assert.equal(first.fired, false);
    assert.equal(first.reason, 'delivery-failed');
    // Next tick (still stalled) retries immediately — not debounced away.
    const second = await maybeFireReviewStalledAlert({
      deliverAlertFn: flaky, now: now + 1000, pendingReviewCount: 1, stateDir,
    });
    assert.equal(second.fired, true);
    assert.equal(attempts, 2);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
