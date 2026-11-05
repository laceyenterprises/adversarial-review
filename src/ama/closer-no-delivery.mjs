// CLOSERRETRY-01: a closer is not re-dispatched for a failure it already repeated.
//
// A closer attempt that ends with neither a merge nor a push delivered nothing,
// yet every attempt reloads the whole repository context. The per-head dispatch
// record and the per-PR hammer cap already allow one retry after a first failed
// attempt. Several budgets also refund an attempt (exited without closing,
// no-work, label-gate), so one unchanged head could still be dispatched three
// times with the same failure.
//
// This ledger keys terminal no-delivery attempts on `(repo, pr, headSha,
// failureClass)`. The closer is attempted at most twice for a key: the first
// attempt and the one retry the series cap allows. When the retry ended in the
// same failure class, a new closer is not dispatched for it. Eligibility returns
// when:
//   - the PR head changes (a new head is a new key),
//   - the latest failure is a different class that has not yet repeated,
//   - an operator re-drive is observed for the head (the existing operator
//     approval allowance, or `npm run reset-pr`). A re-drive clears the head's
//     attempts, so the re-driven attempt is bounded the same way.
//
// Each skipped repeat is returned to the caller, which logs it and reports the
// existing needs-operator result; the ledger counts entry into the skipped state
// and then at most one skip per interval. No new label.
//
// The file is keyed on the PR, not the head, and prunes old heads, so it stays
// small while a hammer moves the head.

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../atomic-write.mjs';

export const CLOSER_NO_DELIVERY_SCHEMA_VERSION = 1;
// Terminal no-delivery attempts of one class on one head before a repeat is
// skipped: the first attempt plus the series' single retry.
export const CLOSER_NO_DELIVERY_ATTEMPTS_PER_KEY = 2;
export const CLOSER_REPEAT_SKIPPED_REASON = 'closer-repeat-no-delivery-skipped';
export const CLOSER_REPEAT_SKIPPED_EVENT = 'ama_closer.repeat_no_delivery_skipped';
const MAX_HEADS_RETAINED = 8;
const MAX_ATTEMPTS_PER_CLASS = 16;
// A PR held in the skipped state is re-gated on every poll. Its skip is
// persisted when it enters that state, then at most once per interval per key,
// so a stuck PR does not rewrite the ledger every tick. Every skip is logged.
export const CLOSER_REPEAT_SKIP_PERSIST_INTERVAL_MS = 15 * 60 * 1000;
// Shared identity of attempts that carry no launch, dispatch or intent id.
const UNIDENTIFIED_ATTEMPT_KEY = 'unidentified';

// A missing or malformed timestamp sorts as the oldest, never as NaN.
function timestampMs(value) {
  return Date.parse(value) || 0;
}

function ledgerDir(rootDir) {
  return join(rootDir, 'data', 'follow-up-jobs', 'closer-no-delivery');
}

function safeSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

export function closerNoDeliveryFilePath(rootDir, { repo, prNumber } = {}) {
  const safeRepo = safeSegment(String(repo ?? '').replace(/\//g, '__'));
  return join(ledgerDir(rootDir), `${safeRepo}-pr-${Number(prNumber)}.json`);
}

// The class is part of a file key, so keep it a short fixed-charset token.
export function normalizeFailureClass(value) {
  const token = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').slice(0, 64);
  return token || 'unclassified';
}

function emptyLedger(identity) {
  return { schemaVersion: CLOSER_NO_DELIVERY_SCHEMA_VERSION, repo: identity.repo,
    prNumber: Number(identity.prNumber), heads: {} };
}

// An unreadable ledger must not read as "no prior attempts": that would re-arm
// the repeat. It reads as corrupt, which the caller treats as blocking.
export function readCloserNoDeliveryLedger(rootDir, identity) {
  const filePath = closerNoDeliveryFilePath(rootDir, identity);
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyLedger(identity);
    return { ...emptyLedger(identity), __corrupt: true, corruptReason: `read:${error?.code || 'error'}` };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !parsed.heads || typeof parsed.heads !== 'object' || Array.isArray(parsed.heads)) throw new Error('shape');
    return parsed;
  } catch {
    return { ...emptyLedger(identity), __corrupt: true, corruptReason: 'parse' };
  }
}

function writeLedger(rootDir, identity, doc) {
  mkdirSync(ledgerDir(rootDir), { recursive: true });
  const heads = Object.entries(doc.heads)
    .sort(([, a], [, b]) => timestampMs(b?.updatedAt) - timestampMs(a?.updatedAt))
    .slice(0, MAX_HEADS_RETAINED);
  writeFileAtomic(closerNoDeliveryFilePath(rootDir, identity),
    `${JSON.stringify({ ...doc, heads: Object.fromEntries(heads) }, null, 2)}\n`);
}

function headEntry(ledger, headSha) {
  const entry = ledger.heads?.[headSha];
  return entry && typeof entry === 'object' && entry.classes && typeof entry.classes === 'object'
    ? entry : { classes: {}, latestClass: null, redriveKeys: [], updatedAt: null };
}

/**
 * Stable identity of a closer dispatch record's attempt when its launch request
 * id is absent: the dispatch id, else the dispatch intent key, else the time the
 * attempt was made. None of these change while the record is re-observed.
 */
export function closerNoDeliveryAttemptKey(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.dispatchId) return `dispatch:${record.dispatchId}`;
  if (record.dispatchIdempotencyKey) return `intent:${record.dispatchIdempotencyKey}`;
  const at = record.lastAttemptedAt || record.dispatchedAt;
  return at ? `attempted:${at}` : null;
}

/**
 * Record one terminal no-delivery attempt. Idempotent per attempt: the closer
 * re-observes a terminal launch every poll until it re-dispatches. The attempt
 * is identified by its launch request id, else by `attemptKey` (the dispatch
 * record's dispatch id, intent key or attempt time). An attempt with neither
 * shares one fixed identity, so repeated polls of it can never spend the key's
 * retry; at worst the older per-head bounds stay in charge.
 *
 * @returns {{ recorded: boolean, reason?: string, failureClass?: string }}
 */
export function recordCloserNoDeliveryAttempt(rootDir, identity, {
  headSha, failureClass, launchRequestId = null, attemptKey = null, workerClass = null, now,
} = {}) {
  if (!headSha) return { recorded: false, reason: 'no-head' };
  const ledger = readCloserNoDeliveryLedger(rootDir, identity);
  // Do not overwrite a file we could not read; it keeps blocking until repaired.
  if (ledger.__corrupt) return { recorded: false, reason: 'ledger-corrupt' };
  const klass = normalizeFailureClass(failureClass);
  const observedAt = now || new Date().toISOString();
  const entry = headEntry(ledger, headSha);
  const current = entry.classes[klass] || { attempts: [], skippedCount: 0 };
  const launch = launchRequestId ? String(launchRequestId) : null;
  const key = launch || (attemptKey ? String(attemptKey) : UNIDENTIFIED_ATTEMPT_KEY);
  if (current.attempts.some((attempt) => (attempt.attemptKey || attempt.launchRequestId) === key
    || (launch && attempt.launchRequestId === launch))) {
    return { recorded: false, reason: 'already-recorded', failureClass: klass };
  }
  const attempts = [...current.attempts, { launchRequestId: launch, attemptKey: key, workerClass, observedAt }]
    .slice(-MAX_ATTEMPTS_PER_CLASS);
  writeLedger(rootDir, identity, { ...ledger, heads: { ...ledger.heads, [headSha]: {
    ...entry, latestClass: klass, updatedAt: observedAt,
    classes: { ...entry.classes, [klass]: { ...current, attempts } },
  } } });
  return { recorded: true, failureClass: klass };
}

/**
 * Pure: may a new closer be dispatched for this head?
 *
 * `failureClass` is the class of the latest terminal attempt. It defaults to
 * the ledger's latest recorded class for the head.
 *
 * @returns {{ skip: boolean, reason: string, failureClass: string|null,
 *   priorAttempts: number, lastLaunchRequestId: string|null }}
 */
export function evaluateCloserNoDeliveryGate(ledger, { headSha, failureClass = null } = {}) {
  const none = { skip: false, reason: 'no-prior-attempt', failureClass: null, priorAttempts: 0,
    lastLaunchRequestId: null };
  // Fail closed on an unreadable ledger, like the hammer retry cap ledger.
  if (ledger?.__corrupt) return { ...none, skip: true, reason: 'ledger-corrupt' };
  const entry = headSha ? headEntry(ledger || {}, headSha) : null;
  if (!entry) return none;
  const klass = normalizeFailureClass(failureClass ?? entry.latestClass);
  const attempts = entry.classes[klass]?.attempts || [];
  if (!attempts.length) return { ...none, failureClass: klass };
  if (attempts.length < CLOSER_NO_DELIVERY_ATTEMPTS_PER_KEY) {
    return { ...none, reason: 'retry-within-key-bound', failureClass: klass, priorAttempts: attempts.length,
      lastLaunchRequestId: attempts.at(-1)?.launchRequestId || null };
  }
  return { skip: true, reason: 'repeated-no-delivery-same-head-and-class', failureClass: klass,
    priorAttempts: attempts.length, lastLaunchRequestId: attempts.at(-1)?.launchRequestId || null };
}

/**
 * An operator re-drive resets the head's attempts once. `redriveKey` names the
 * grant (for the approval allowance, its `grantedAt`), so the same grant seen
 * on later polls cannot clear a newer failure.
 *
 * @returns {{ reset: boolean, reason: string }}
 */
export function applyCloserOperatorRedrive(rootDir, identity, { headSha, redriveKey, now } = {}) {
  if (!headSha || !redriveKey) return { reset: false, reason: 'no-redrive' };
  const ledger = readCloserNoDeliveryLedger(rootDir, identity);
  if (ledger.__corrupt) {
    // An operator re-drive is the explicit repair for an unreadable file.
    writeLedger(rootDir, identity, { ...emptyLedger(identity), heads: { [headSha]: {
      classes: {}, latestClass: null, redriveKeys: [String(redriveKey)], updatedAt: now || new Date().toISOString() } } });
    return { reset: true, reason: 'ledger-repaired' };
  }
  const entry = headEntry(ledger, headSha);
  if (entry.redriveKeys?.includes(String(redriveKey))) return { reset: false, reason: 'redrive-already-applied' };
  writeLedger(rootDir, identity, { ...ledger, heads: { ...ledger.heads, [headSha]: {
    classes: {}, latestClass: null, updatedAt: now || new Date().toISOString(),
    redriveKeys: [...(entry.redriveKeys || []), String(redriveKey)].slice(-8),
  } } });
  return { reset: true, reason: 'operator-redrive' };
}

/**
 * Count a skipped repeat on its key so a stuck PR is visible in the ledger as
 * well as the decision log. The first skip is always persisted; later skips are
 * persisted at most once per CLOSER_REPEAT_SKIP_PERSIST_INTERVAL_MS, so
 * `skippedCount` counts persisted skips and `lastSkippedAt` the latest of them.
 *
 * @returns {{ skippedCount: number|null, persisted: boolean }}
 */
export function recordCloserRepeatSkipped(rootDir, identity, { headSha, failureClass, now } = {}) {
  const ledger = readCloserNoDeliveryLedger(rootDir, identity);
  if (ledger.__corrupt || !headSha) return { skippedCount: null, persisted: false };
  const klass = normalizeFailureClass(failureClass);
  const entry = headEntry(ledger, headSha);
  const current = entry.classes[klass];
  if (!current) return { skippedCount: null, persisted: false };
  const skippedAt = now || new Date().toISOString();
  const priorCount = Number(current.skippedCount || 0);
  const lastMs = timestampMs(current.lastSkippedAt);
  // A clock that moved backwards (or an unreadable timestamp) persists rather
  // than suppressing the record indefinitely.
  const elapsedMs = timestampMs(skippedAt) - lastMs;
  if (priorCount > 0 && lastMs > 0 && elapsedMs >= 0 && elapsedMs < CLOSER_REPEAT_SKIP_PERSIST_INTERVAL_MS) {
    return { skippedCount: priorCount, persisted: false };
  }
  const skippedCount = priorCount + 1;
  writeLedger(rootDir, identity, { ...ledger, heads: { ...ledger.heads, [headSha]: {
    ...entry, updatedAt: skippedAt,
    classes: { ...entry.classes, [klass]: { ...current, skippedCount,
      firstSkippedAt: current.firstSkippedAt || skippedAt, lastSkippedAt: skippedAt } },
  } } });
  return { skippedCount, persisted: true };
}
