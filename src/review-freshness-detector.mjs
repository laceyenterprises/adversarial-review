// Review-freshness liveness alert — the adversarial-review pipeline pages
// ITSELF when no review has actually posted within a rolling threshold while
// PRs are waiting for a first-pass review. Operators subscribe to this alert;
// it originates from the pipeline that owns the signal, not an external poller.
//
// Motivation (2026-07-26 SEV): the reviewer dispatch path (app-contract
// OS-dispatch cutover) silently failed for ~hours. The watcher marked each
// failed reviewer spawn as review_status='posted' (same-head-already-reviewed),
// so nothing external detected the stall — the fleet looked "all green" while no
// review had landed. This detector is the pipeline's own truthful liveness
// signal. In watcher wiring, the primary baseline is the review DB's ACTUAL
// last-posted-review timestamp (MAX posted_at after timestamp normalization).
// The filesystem record written by recordPostedReview() is only the cold-start
// fallback/injected-test baseline. Neither path keys on the maskable per-PR
// status, so a masking bug can never suppress the page.
//
// Fully dependency-injected (deliverAlertFn, fsImpl, now) and debounced (one
// page per window). Fail-OPEN on state-store errors: a state read/write glitch
// must never suppress a real liveness page.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Page when no review has posted in this long while PRs await first-pass review.
export const REVIEW_STALL_THRESHOLD_MS = 20 * 60 * 1000;
// Re-page at most this often while the stall persists.
export const REVIEW_STALL_ALERT_DEBOUNCE_MS = 30 * 60 * 1000;
export const REVIEW_FRESHNESS_STATE_DIR = join(ROOT, 'data', 'review-freshness');

const LAST_POSTED_FILE = 'last-posted-review.json';
const LAST_ALERT_FILE = 'last-stall-alert.json';

const defaultFs = { existsSync, mkdirSync, readFileSync, writeFileSync };

function _readMs(stateDir, file, fsImpl) {
  try {
    const raw = fsImpl.readFileSync(join(stateDir, file), 'utf8');
    const value = JSON.parse(raw)?.atMs;
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function _writeMs(stateDir, file, atMs, fsImpl) {
  if (!fsImpl.existsSync(stateDir)) {
    fsImpl.mkdirSync(stateDir, { recursive: true });
  }
  fsImpl.writeFileSync(
    join(stateDir, file),
    `${JSON.stringify({ atMs, at: new Date(atMs).toISOString() })}\n`,
    'utf8',
  );
}

// Called when a review ACTUALLY posts (a real published review, not an internal
// status flip) to maintain the filesystem fallback baseline. Watcher production
// wiring uses the review DB's posted_at values as the primary baseline, and this
// fallback is consulted only when no primary timestamp is supplied/available. A
// maskable per-PR status flip advances neither baseline.
export function recordPostedReview(
  atMs = Date.now(),
  { stateDir = REVIEW_FRESHNESS_STATE_DIR, fsImpl = defaultFs } = {},
) {
  try {
    _writeMs(stateDir, LAST_POSTED_FILE, atMs, fsImpl);
    return true;
  } catch {
    // Fail-open: a bookkeeping failure must not break the reviewer path.
    return false;
  }
}

export function readLastPostedReviewMs({
  stateDir = REVIEW_FRESHNESS_STATE_DIR,
  fsImpl = defaultFs,
} = {}) {
  return _readMs(stateDir, LAST_POSTED_FILE, fsImpl);
}

// Decide whether to page for a stalled reviewer, and page (debounced) if so.
// Returns a structured result for logging/tests; never throws.
export async function maybeFireReviewStalledAlert({
  deliverAlertFn,
  now = Date.now(),
  pendingReviewCount,
  lastPostedReviewMs,
  stallThresholdMs = REVIEW_STALL_THRESHOLD_MS,
  debounceMs = REVIEW_STALL_ALERT_DEBOUNCE_MS,
  stateDir = REVIEW_FRESHNESS_STATE_DIR,
  fsImpl = defaultFs,
  logger = console,
} = {}) {
  if (typeof deliverAlertFn !== 'function') {
    return { fired: false, reason: 'no deliverAlertFn' };
  }
  if (!(Number.isFinite(pendingReviewCount) && pendingReviewCount > 0)) {
    return { fired: false, reason: 'no PRs awaiting first-pass review' };
  }
  // Watcher passes the DB-derived primary baseline. The filesystem file is the
  // cold-start/test fallback only, so stale per-PR statuses never mask a stall.
  const lastPosted = Number.isFinite(lastPostedReviewMs)
    ? lastPostedReviewMs
    : _readMs(stateDir, LAST_POSTED_FILE, fsImpl);
  if (lastPosted == null) {
    // No baseline yet (cold start / fresh host). Seed it so the NEXT stalled
    // tick can measure age, but never page without a real reference point.
    recordPostedReview(now, { stateDir, fsImpl });
    return { fired: false, reason: 'no posted-review baseline yet; seeded' };
  }
  const ageMs = now - lastPosted;
  if (ageMs < stallThresholdMs) {
    return { fired: false, reason: 'reviews fresh', ageMs };
  }
  const lastAlert = _readMs(stateDir, LAST_ALERT_FILE, fsImpl);
  if (lastAlert != null && now - lastAlert < debounceMs) {
    return { fired: false, reason: 'debounced', ageMs };
  }
  const ageMin = Math.round(ageMs / 60000);
  // Delivery applies the canonical page headline and action. Keep this durable
  // text concise as the incident record, with the evidence in the payload.
  const text =
    `No review posted for ${ageMin}m while ${pendingReviewCount} open PR(s) await ` +
    'first-pass review.';
  try {
    await deliverAlertFn(text, {
      event: 'adversarial_review.reviewer_stalled',
      payload: {
        reason: 'no-posted-review-within-threshold-while-prs-await',
        age_ms: ageMs,
        pending_review_count: pendingReviewCount,
        threshold_ms: stallThresholdMs,
        last_posted_review_at: new Date(lastPosted).toISOString(),
      },
    });
  } catch (err) {
    logger?.warn?.(
      `[watcher] review-freshness alert delivery failed: ${err?.message || err}`,
    );
    // Do not persist the debounce marker if delivery failed — retry next tick.
    return { fired: false, reason: 'delivery-failed', ageMs };
  }
  try {
    _writeMs(stateDir, LAST_ALERT_FILE, now, fsImpl);
  } catch {
    // Fail-open: if we can't persist the debounce marker we may re-page sooner
    // than debounceMs — acceptable; over-paging a real stall beats silence.
  }
  return { fired: true, ageMs, pendingReviewCount };
}
