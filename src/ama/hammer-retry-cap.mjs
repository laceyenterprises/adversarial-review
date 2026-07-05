// Hammer retry cap — a hard, per-PR ceiling on hammer re-dispatch.
//
// Why this exists (confirmed incident, 2026-07-05):
//   The AMA closer re-dispatched a terminal-remediation *hammer* on the SAME
//   logical PR over and over — 189 hammer worker dispatches in one day, with
//   individual PRs hammered 5-10 times (#3116 ×10, #3120 ×7, #3137/#3124/#3114
//   ×5). Each hammer is a full codex worker doing terminal remediation, so the
//   loop burned the ENTIRE weekly Codex quota in a day. Root pattern: the hammer
//   remediates + moves the PR head but does NOT close → `stale-review-head` →
//   the watcher re-dispatches against the new head → repeat, unbounded.
//
// The existing per-head redispatch bound (AMA_CLOSER_REDISPATCH_BOUND) could not
// stop this: its dispatch record is keyed on the HEAD sha, so a hammer that moves
// the head creates a brand-new record with retryCount=0 — the hammer resets its
// own counter every loop. MSM-01 fixes the merge-itself behavior; this module is
// the independent safety cap so a future regression can never silently burn quota
// again.
//
// The fix: a per-PR attempt ledger keyed on `(repo, prNumber)` — NOT the head —
// with a stable *job key* (the reviewed head sha) so the counter survives the
// head churn a hammer causes. A hammer that moves the head keeps the same job key
// (no fresh adversarial review posted while the cycle is exhausted), so it can't
// reset its own counter. A genuinely fresh review head (a human push that earns a
// new adversarial review) advances the job key and legitimately resets the count.
//
// Cap = ONE retry: the initial hammer + at most 1 re-dispatch = 2 total hammer
// dispatches for a given PR. On the 2nd failing outcome the closer stops, fails
// loud via a GBI operator alert, and marks the PR suppressed so the watcher stops
// re-dispatching.

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../atomic-write.mjs';

// One retry: initial hammer + 1 re-dispatch. The cap is expressed as a total
// number of hammer dispatches allowed for a logical PR before suppression.
export const HAMMER_RETRY_CAP_RETRIES = 1;
export const HAMMER_RETRY_CAP_TOTAL_DISPATCHES = HAMMER_RETRY_CAP_RETRIES + 1; // 2

// The suppression state stamped on the ledger when the cap is exhausted. It is
// PR-scoped (anchored to the stable job key, not the churning head) so head churn
// the hammer itself causes cannot clear it — only a genuinely fresh review head
// (new job key) resets the series.
export const HAMMER_RETRY_CAP_SUPPRESSION_STATE = 'hammer-retry-cap-exhausted-needs-operator';
export const HAMMER_RETRY_CAP_EXHAUSTED_REASON = 'hammer-retry-cap-exhausted';

const HAMMER_RETRY_CAP_SCHEMA_VERSION = 1;

function hammerRetryCapDir(rootDir) {
  return join(rootDir, 'data', 'follow-up-jobs', 'hammer-retry-cap');
}

function sanitizePathSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

export function hammerRetryCapFilePath(rootDir, { repo, prNumber } = {}) {
  const safeRepo = sanitizePathSegment(String(repo ?? '').replace(/\//g, '__'));
  // NOTE: intentionally NOT keyed on head sha — this is the per-PR ledger that
  // must survive the head moves a hammer causes.
  return join(hammerRetryCapDir(rootDir), `${safeRepo}-pr-${Number(prNumber)}.json`);
}

export function readHammerRetryCapLedger(rootDir, identity) {
  try {
    return JSON.parse(readFileSync(hammerRetryCapFilePath(rootDir, identity), 'utf8'));
  } catch {
    return null;
  }
}

function writeHammerRetryCapLedger(rootDir, identity, doc) {
  mkdirSync(hammerRetryCapDir(rootDir), { recursive: true });
  const filePath = hammerRetryCapFilePath(rootDir, identity);
  writeFileAtomic(filePath, `${JSON.stringify(doc, null, 2)}\n`);
  return filePath;
}

function normalizeKey(value) {
  const str = String(value ?? '').trim();
  return str.length ? str : null;
}

/**
 * Decide, without writing anything, whether a hammer dispatch for this PR is
 * within the retry cap.
 *
 * The `jobKey` is the STABLE per-PR anchor — the reviewed head sha. It does NOT
 * change when a hammer moves the PR head (no fresh adversarial review is posted
 * while the review cycle is exhausted), so counting under it is robust across the
 * head churn a hammer causes. A genuinely fresh review head advances the jobKey
 * and resets the series.
 *
 * @returns {{
 *   jobKeyChanged: boolean,       // the fresh-review reset trigger fired
 *   priorAttemptCount: number,    // completed hammer dispatches counted so far
 *   nextAttemptCount: number,     // what the count becomes if we dispatch now
 *   alreadySuppressed: boolean,   // ledger already in the exhausted state (same series)
 *   capExhausted: boolean,        // dispatching now would exceed the cap → suppress instead
 *   alertAlreadyEmitted: boolean, // an operator alert already went out for this suppression
 *   resetFromJobKey: (string|null),
 * }}
 */
export function evaluateHammerRetryCap(ledger, { jobKey, headSha } = {}) {
  const incomingJobKey = normalizeKey(jobKey);
  const ledgerJobKey = normalizeKey(ledger?.jobKey);
  // A job-key change is the fresh-review reset. Only counts as a change when both
  // sides are known AND differ — an unknown incoming jobKey never resets a live
  // series (fail toward keeping the cap in force / protecting quota).
  const jobKeyChanged = Boolean(
    ledger
      && ledgerJobKey
      && incomingJobKey
      && ledgerJobKey !== incomingJobKey,
  );
  // The ledger only ever counts CONFIRMED hammer launches (the closer increments
  // on the success path, never pre-exec), so an interrupted-mid-launch dispatch
  // never bumped it — there is no phantom increment to reclaim. A deploy bounce
  // during a launch simply never counted, which is the correct fail-safe.
  const priorAttemptCount = (!ledger || jobKeyChanged)
    ? 0
    : Math.max(0, Number(ledger.attemptCount || 0));
  const alreadySuppressed = Boolean(ledger?.suppressed) && !jobKeyChanged;
  const nextAttemptCount = priorAttemptCount + 1;
  const capExhausted = alreadySuppressed || nextAttemptCount > HAMMER_RETRY_CAP_TOTAL_DISPATCHES;
  return {
    jobKeyChanged,
    priorAttemptCount,
    nextAttemptCount,
    alreadySuppressed,
    capExhausted,
    alertAlreadyEmitted: alreadySuppressed && Boolean(ledger?.alertedAt),
    resetFromJobKey: jobKeyChanged ? ledgerJobKey : null,
    headSha: normalizeKey(headSha),
  };
}

/**
 * Record a hammer dispatch against the per-PR ledger, applying the fresh-review
 * reset when the job key advanced. Increments the attempt counter and appends the
 * dispatched head for observability. Returns the persisted ledger.
 */
export function recordHammerRetryDispatch(rootDir, identity, {
  jobKey,
  headSha,
  now = null,
} = {}) {
  const existing = readHammerRetryCapLedger(rootDir, identity);
  const decision = evaluateHammerRetryCap(existing, { jobKey, headSha });
  const incomingJobKey = normalizeKey(jobKey);
  const head = normalizeKey(headSha);
  // On a fresh-review reset the head history restarts; otherwise accumulate.
  const priorHeads = (!existing || decision.jobKeyChanged)
    ? []
    : (Array.isArray(existing.dispatchHeads) ? existing.dispatchHeads : []);
  const dispatchHeads = head && !priorHeads.includes(head)
    ? [...priorHeads, head]
    : priorHeads;
  const doc = {
    schemaVersion: HAMMER_RETRY_CAP_SCHEMA_VERSION,
    repo: identity.repo,
    prNumber: Number(identity.prNumber),
    jobKey: incomingJobKey,
    attemptCount: decision.nextAttemptCount,
    dispatchHeads,
    lastDispatchedHeadSha: head || existing?.lastDispatchedHeadSha || null,
    // A dispatch clears any stale suppression from a PRIOR series (the reset
    // path). Within the same series we never reach here while suppressed (the
    // closer refuses to dispatch), so this is always the un-suppressed state.
    suppressed: false,
    suppressionState: null,
    suppressedJobKey: null,
    suppressedHeadSha: null,
    suppressedAttemptCount: null,
    alertedAt: null,
    createdAt: existing?.createdAt || now || null,
    updatedAt: now || existing?.updatedAt || null,
  };
  writeHammerRetryCapLedger(rootDir, identity, doc);
  return doc;
}

/**
 * Stamp the per-PR ledger with the cap-exhausted suppression state. Head-churn
 * cannot clear it — it is anchored to the stable job key. `alertEmitted` records
 * whether the operator alert went out so subsequent suppressed ticks don't
 * re-alert (the alert transport being down leaves `alertEmitted=false`, which is
 * how a later tick retries the alert — fail-open, never crash).
 */
export function markHammerRetryCapExhausted(rootDir, identity, {
  jobKey,
  headSha,
  attemptCount,
  alertEmitted = false,
  now = null,
} = {}) {
  const existing = readHammerRetryCapLedger(rootDir, identity);
  const incomingJobKey = normalizeKey(jobKey);
  const head = normalizeKey(headSha);
  const priorHeads = Array.isArray(existing?.dispatchHeads) ? existing.dispatchHeads : [];
  const dispatchHeads = head && !priorHeads.includes(head) ? [...priorHeads, head] : priorHeads;
  const doc = {
    schemaVersion: HAMMER_RETRY_CAP_SCHEMA_VERSION,
    repo: identity.repo,
    prNumber: Number(identity.prNumber),
    jobKey: incomingJobKey || normalizeKey(existing?.jobKey),
    attemptCount: Number.isFinite(Number(attemptCount))
      ? Number(attemptCount)
      : Math.max(0, Number(existing?.attemptCount || 0)),
    dispatchHeads,
    lastDispatchedHeadSha: head || existing?.lastDispatchedHeadSha || null,
    suppressed: true,
    suppressionState: HAMMER_RETRY_CAP_SUPPRESSION_STATE,
    suppressedJobKey: incomingJobKey || normalizeKey(existing?.jobKey),
    suppressedHeadSha: head || existing?.suppressedHeadSha || null,
    suppressedAttemptCount: Number.isFinite(Number(attemptCount))
      ? Number(attemptCount)
      : Math.max(0, Number(existing?.attemptCount || 0)),
    // Preserve a prior alertedAt so a repeat suppression tick that couldn't send
    // the alert doesn't erase the record that it once succeeded.
    alertedAt: alertEmitted ? (now || existing?.alertedAt || null) : (existing?.alertedAt || null),
    createdAt: existing?.createdAt || now || null,
    updatedAt: now || existing?.updatedAt || null,
  };
  writeHammerRetryCapLedger(rootDir, identity, doc);
  return doc;
}
