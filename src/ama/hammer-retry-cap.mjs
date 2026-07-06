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

// Independent LIFETIME ceiling on total hammer dispatches for a logical PR,
// immune to the fresh-review (jobKey) reset. The per-series cap above resets
// whenever the reviewed head advances — but a hammer that remediates AND earns a
// fresh adversarial review on the head it moved advances the jobKey every cycle,
// resetting the series cap and re-firing unboundedly. Observed 2026-07-06: 4 HAM
// terminal remediations on PR #3200 in 12 minutes, each on a new gemini-reviewed
// head, because the PR could not reach green CI (oss-readiness line-pinning) so
// the AMA merge gate never passed. This ceiling counts total hammer dispatches
// for the PR across ALL series and NEVER resets on a jobKey change, so the loop
// is bounded regardless of review-head churn. Set above the per-series cap so a
// legitimate fresh-review-then-remediate cycle still has room before it trips.
export const HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES = 4;
export const HAMMER_RETRY_CAP_LIFETIME_SUPPRESSION_STATE = 'hammer-retry-cap-lifetime-exhausted-needs-operator';
export const HAMMER_RETRY_CAP_LIFETIME_EXHAUSTED_REASON = 'hammer-retry-cap-lifetime-exhausted';

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

// A synthetic ledger returned when the on-disk ledger exists but cannot be read
// or parsed. It fails CLOSED: `suppressed: true` + `attemptCount` at the cap makes
// `evaluateHammerRetryCap` report `capExhausted` (and, with no `alertedAt`, still
// pages the operator) so a corrupt/truncated file surfaces loudly instead of
// silently resetting the count to 0 and re-arming the quota-burning loop. `jobKey`
// is intentionally null so a genuinely fresh review head can still reset the series
// once the operator repairs or clears the file.
function corruptLedgerSentinel(reason) {
  return Object.freeze({
    __corrupt: true,
    corruptReason: reason,
    suppressed: true,
    attemptCount: HAMMER_RETRY_CAP_TOTAL_DISPATCHES,
    // Fail closed on the lifetime ceiling too: a jobKey change must not let a
    // corrupt ledger re-arm the loop. `lifetimeSuppressed` is immune to the
    // fresh-review reset, so a corrupt file stays suppressed until an operator
    // repairs or clears it.
    lifetimeSuppressed: true,
    lifetimeAttemptCount: HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES,
    jobKey: null,
  });
}

export function readHammerRetryCapLedger(rootDir, identity, { logger = console } = {}) {
  const filePath = hammerRetryCapFilePath(rootDir, identity);
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    // Genuinely-absent ledger is the expected first-time path — treat as no prior
    // attempts (count starts at 0). Any OTHER read failure (permissions, I/O) is
    // NOT confirmation of "no prior attempts", so fail closed to protect quota.
    if (err && err.code === 'ENOENT') return null;
    logger?.warn?.(
      `[hammer-retry-cap] failed to read ledger ${filePath} (${err?.code || err?.message || 'unknown'}); `
        + 'failing closed (treating as cap-exhausted) to protect quota',
    );
    return corruptLedgerSentinel(`read:${err?.code || 'error'}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // The file exists but is corrupt/truncated. Do NOT conflate this with a fresh
    // PR — that would silently bypass the cap. Fail closed + surface it loudly.
    logger?.warn?.(
      `[hammer-retry-cap] ledger ${filePath} is corrupt (${err?.message || 'parse error'}); `
        + 'failing closed (treating as cap-exhausted) to protect quota — operator must repair or clear it',
    );
    return corruptLedgerSentinel('parse');
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

// Coerce a persisted ledger count to a non-negative finite integer. An ABSENT
// value (null/undefined) is a legitimate fresh start (0). A PRESENT-but-non-finite
// value — e.g. an operator hand-editing the ledger to `"foo"` to unblock a PR —
// is treated as CORRUPTION and fails CLOSED to the lifetime ceiling, so the loop
// cannot be silently re-armed by `NaN > ceiling` evaluating false.
function sanitizeLifetimeCount(rawValue) {
  if (rawValue === null || rawValue === undefined) return 0;
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES;
  return Math.max(0, Math.trunc(n));
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
  // Lifetime accounting is NEVER reset by a jobKey change — a hammer that keeps
  // earning fresh reviews on the heads it moves must not be able to reset its own
  // total. Legacy ledgers (no lifetimeAttemptCount) seed from attemptCount, a safe
  // lower bound.
  const priorLifetimeCount = ledger
    ? sanitizeLifetimeCount(ledger.lifetimeAttemptCount ?? ledger.attemptCount)
    : 0;
  const nextLifetimeCount = priorLifetimeCount + 1;
  const lifetimeAlreadySuppressed = Boolean(ledger?.lifetimeSuppressed);
  const lifetimeCapExhausted = lifetimeAlreadySuppressed
    || nextLifetimeCount > HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES;
  const capExhausted = alreadySuppressed
    || nextAttemptCount > HAMMER_RETRY_CAP_TOTAL_DISPATCHES
    || lifetimeCapExhausted;
  return {
    jobKeyChanged,
    priorAttemptCount,
    nextAttemptCount,
    priorLifetimeCount,
    nextLifetimeCount,
    alreadySuppressed,
    lifetimeAlreadySuppressed,
    lifetimeCapExhausted,
    capExhausted,
    alertAlreadyEmitted: (alreadySuppressed || lifetimeAlreadySuppressed) && Boolean(ledger?.alertedAt),
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
    jobKey: incomingJobKey || normalizeKey(existing?.jobKey),
    attemptCount: decision.nextAttemptCount,
    // Lifetime count accumulates across fresh-review resets and never rolls back.
    lifetimeAttemptCount: decision.nextLifetimeCount,
    dispatchHeads,
    lastDispatchedHeadSha: head || existing?.lastDispatchedHeadSha || null,
    // A dispatch clears any stale PER-SERIES suppression from a prior series (the
    // reset path). Within the same series we never reach here while suppressed
    // (the closer refuses to dispatch). The LIFETIME suppression is not cleared
    // by a dispatch — but the closer never dispatches once lifetimeCapExhausted,
    // so reaching here always means the lifetime ceiling has not been hit.
    suppressed: false,
    lifetimeSuppressed: false,
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
  lifetime = false,
  now = null,
} = {}) {
  const existing = readHammerRetryCapLedger(rootDir, identity);
  const incomingJobKey = normalizeKey(jobKey);
  const head = normalizeKey(headSha);
  const priorHeads = Array.isArray(existing?.dispatchHeads) ? existing.dispatchHeads : [];
  const dispatchHeads = head && !priorHeads.includes(head) ? [...priorHeads, head] : priorHeads;
  // A lifetime exhaustion (or one already stamped) is immune to the fresh-review
  // reset: `lifetimeSuppressed` is never cleared by a jobKey change, so a hammer
  // cannot re-arm the loop by earning a fresh review on the head it moved.
  const lifetimeSuppressed = Boolean(lifetime) || Boolean(existing?.lifetimeSuppressed);
  const doc = {
    schemaVersion: HAMMER_RETRY_CAP_SCHEMA_VERSION,
    repo: identity.repo,
    prNumber: Number(identity.prNumber),
    jobKey: incomingJobKey || normalizeKey(existing?.jobKey),
    attemptCount: Number.isFinite(Number(attemptCount))
      ? Number(attemptCount)
      : Math.max(0, Number(existing?.attemptCount || 0)),
    lifetimeAttemptCount: sanitizeLifetimeCount(
      existing?.lifetimeAttemptCount ?? existing?.attemptCount,
    ),
    lifetimeSuppressed,
    dispatchHeads,
    lastDispatchedHeadSha: head || existing?.lastDispatchedHeadSha || null,
    suppressed: true,
    suppressionState: lifetimeSuppressed
      ? HAMMER_RETRY_CAP_LIFETIME_SUPPRESSION_STATE
      : HAMMER_RETRY_CAP_SUPPRESSION_STATE,
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
