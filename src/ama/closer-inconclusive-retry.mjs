// INCONCLUSIVERETRY-01b: a closer result that cannot conclude is an owned
// retry with backoff. It is never a closer failure, never spends closer budget
// and never ends the PR's automated path.
//
// One classifier and one owned-retry record, shared by the ended-launch
// observation in dispatch-closer and the closure-budget escalation.
//
// - Stop reasons reuse the HAMSELFERRORS-01 origin registry: `closer` and
//   `infrastructure` origins are inconclusive, `world` origins are real.
// - Launch failures the registry cannot see (the worker never started, or a
//   checkout, provision or helper bootstrap failed) are inconclusive.
// - Anything else is real and keeps its existing terminal, counted handling.
//
// The record grants nothing. Every retry is an ordinary closer dispatch, so
// exact-head review, attestation, leases and required checks all run again.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../atomic-write.mjs';
import { hammerStopOrigin } from './hammer-stop-origin.mjs';
import { isHarnessFault } from '../harness-fault.mjs';

export const CLOSER_INCONCLUSIVE_RETRY_OWNER = 'watcher';
export const CLOSER_INCONCLUSIVE_WAIT_CLASS = 'closer-inconclusive';
export const CLOSER_INCONCLUSIVE_BACKOFF_REASON = 'closer-inconclusive-retry-backoff';
export const CLOSER_INCONCLUSIVE_RETRY_DEFAULTS = Object.freeze({
  surfaceAfterAttempts: 3,
  backoffBaseMs: 5 * 60_000,
  backoffMaxMs: 60 * 60_000,
});

// Launch-level failures: no closer helper ran, so no stop reason exists.
// Underscore and hyphen spellings are equivalent.
export const CLOSER_INCONCLUSIVE_LAUNCH_FAILURES = Object.freeze(new Set([
  'spawn-never-registered',
  'worker-never-started',
  'scratch-missing',
  'dispatch-phase-scripts-missing',
  'checkout-failed',
  'provision-failed',
  'endpoint-bootstrap-failed',
  'helper-bootstrap-failed',
]));

// Observation failures outside the stop registry.
const INCONCLUSIVE_OBSERVATIONS = new Set([
  ...CLOSER_INCONCLUSIVE_LAUNCH_FAILURES,
  'github-unreachable',
  'pr-mergeability-unknown',
  'mergeability-unknown',
  'live-pr-probe-failed',
  'live-pr-state-unknown',
  'hammer-outcome-unconfirmed',
]);

const MAX_HEADS = 8;
const MAX_LAUNCHES = 32;

function code(value) {
  return String(value ?? '').trim().split(':')[0].toLowerCase().replace(/_/g, '-');
}

/**
 * @returns {{ kind: 'inconclusive'|'real', reason: string, origin: string }}
 */
export function classifyCloserOutcome({ reason = null, failureClass = null } = {}) {
  const raw = String(reason ?? '').trim();
  if (raw) {
    try {
      const origin = hammerStopOrigin(raw);
      return { kind: origin === 'world' ? 'real' : 'inconclusive', reason: code(raw), origin };
    } catch { /* Not a registered stop reason. */ }
    if (isHarnessFault(raw)) {
      return { kind: 'inconclusive', reason: code(raw), origin: 'infrastructure' };
    }
    if (INCONCLUSIVE_OBSERVATIONS.has(code(raw))) {
      return { kind: 'inconclusive', reason: code(raw), origin: 'infrastructure' };
    }
  }
  if (isHarnessFault(failureClass)) {
    return { kind: 'inconclusive', reason: code(failureClass), origin: 'infrastructure' };
  }
  const launch = code(failureClass);
  if (CLOSER_INCONCLUSIVE_LAUNCH_FAILURES.has(launch)) return { kind: 'inconclusive', reason: launch, origin: 'launch' };
  return { kind: 'real', reason: code(raw) || launch || 'unclassified', origin: 'unknown' };
}

function positiveInt(value, fallback, min) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min ? number : fallback;
}

export function closerInconclusiveRetryPolicy(cfg = null) {
  const source = cfg?.closerInconclusiveRetry || {};
  const defaults = CLOSER_INCONCLUSIVE_RETRY_DEFAULTS;
  const backoffBaseMs = positiveInt(source.backoffBaseMs, defaults.backoffBaseMs, 1000);
  return {
    surfaceAfterAttempts: positiveInt(source.surfaceAfterAttempts, defaults.surfaceAfterAttempts, 1),
    backoffBaseMs,
    backoffMaxMs: Math.max(backoffBaseMs, positiveInt(source.backoffMaxMs, defaults.backoffMaxMs, 1000)),
  };
}

// The first N-1 retries keep the next-pass cadence the HAMSELFERRORS-01
// in-run correction already uses. From attempt N on, the delay doubles.
export function closerInconclusiveRetryDelayMs(attempt, policy = CLOSER_INCONCLUSIVE_RETRY_DEFAULTS) {
  if (attempt < policy.surfaceAfterAttempts) return 0;
  return Math.min(policy.backoffMaxMs, policy.backoffBaseMs * 2 ** (attempt - policy.surfaceAfterAttempts));
}

function safeSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

export function closerInconclusiveRetryFilePath(rootDir, { repo, prNumber } = {}) {
  return join(rootDir, 'data', 'follow-up-jobs', 'closer-inconclusive-retries',
    `${safeSegment(String(repo ?? '').replace(/\//g, '__'))}-pr-${Number(prNumber)}.json`);
}

function emptyRecord(identity) {
  return { schemaVersion: 1, repo: identity?.repo, prNumber: Number(identity?.prNumber),
    owner: CLOSER_INCONCLUSIVE_RETRY_OWNER, heads: {} };
}

export function readCloserInconclusiveRetries(rootDir, identity) {
  let raw;
  try { raw = readFileSync(closerInconclusiveRetryFilePath(rootDir, identity), 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return emptyRecord(identity);
    return { ...emptyRecord(identity), __corrupt: true };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !parsed.heads || typeof parsed.heads !== 'object' || Array.isArray(parsed.heads)) throw new Error('shape');
    return parsed;
  } catch { return { ...emptyRecord(identity), __corrupt: true }; }
}

function writeRecord(rootDir, identity, doc) {
  const file = closerInconclusiveRetryFilePath(rootDir, identity);
  mkdirSync(join(file, '..'), { recursive: true });
  const heads = Object.entries(doc.heads)
    .sort(([, a], [, b]) => (Date.parse(b?.lastAttemptAt) || 0) - (Date.parse(a?.lastAttemptAt) || 0))
    .slice(0, MAX_HEADS);
  writeFileAtomic(file, `${JSON.stringify({ ...doc, heads: Object.fromEntries(heads) }, null, 2)}\n`);
}

/**
 * Record one inconclusive ended launch. Idempotent per launch: the closer
 * re-observes an ended launch on every pass until it is replaced.
 * A corrupt record is repaired from scratch: it only ever delays a retry.
 */
export function recordCloserInconclusiveRetry(rootDir, identity, {
  headSha, launchRequestId, reason, now = new Date().toISOString(), policy = CLOSER_INCONCLUSIVE_RETRY_DEFAULTS,
} = {}) {
  if (!headSha || !launchRequestId) return { recorded: false, reason: 'identity-missing', entry: null };
  const current = readCloserInconclusiveRetries(rootDir, identity);
  const doc = current.__corrupt ? emptyRecord(identity) : current;
  const prior = doc.heads[headSha];
  const launches = Array.isArray(prior?.launches) ? prior.launches : [];
  if (launches.some(launch => launch?.launchRequestId === launchRequestId)) {
    return { recorded: false, reason: 'already-recorded', entry: prior };
  }
  const attempt = Number(prior?.attempt || 0) + 1;
  const nextAttemptAt = new Date(Date.parse(now) + closerInconclusiveRetryDelayMs(attempt, policy)).toISOString();
  const entry = {
    owner: CLOSER_INCONCLUSIVE_RETRY_OWNER, attempt, reason, lastAttemptAt: now, nextAttemptAt,
    // The owner must act again by this time; a retry is due, never a park.
    deadline: nextAttemptAt,
    surfaceAfterAttempts: policy.surfaceAfterAttempts,
    surfacedAt: prior?.surfacedAt || null,
    launches: [...launches, { launchRequestId, reason, at: now }].slice(-MAX_LAUNCHES),
  };
  writeRecord(rootDir, identity, { ...doc, heads: { ...doc.heads, [headSha]: entry } });
  return { recorded: true, entry };
}

export function markCloserInconclusiveRetrySurfaced(rootDir, identity, { headSha, now }) {
  const doc = readCloserInconclusiveRetries(rootDir, identity);
  const entry = doc.heads?.[headSha];
  if (doc.__corrupt || !entry || entry.surfacedAt) return entry || null;
  const surfaced = { ...entry, surfacedAt: now };
  writeRecord(rootDir, identity, { ...doc, heads: { ...doc.heads, [headSha]: surfaced } });
  return surfaced;
}

/** Pure: must the next closer dispatch for this head wait for its backoff? */
export function evaluateCloserInconclusiveRetryGate(doc, { headSha, now }) {
  const entry = doc?.heads?.[headSha] || null;
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const retryAfterMs = entry ? Date.parse(entry.nextAttemptAt) - nowMs : NaN;
  return { wait: Number.isFinite(retryAfterMs) && retryAfterMs > 0, retryAfterMs: Math.max(0, retryAfterMs || 0), entry };
}

/** Every launch this PR's owner classified as inconclusive, across heads. */
export function closerInconclusiveLaunchIds(doc) {
  return new Set(Object.values(doc?.heads || {}).flatMap(entry =>
    (Array.isArray(entry?.launches) ? entry.launches : []).map(launch => launch?.launchRequestId).filter(Boolean)));
}

export function closerInconclusiveNotice({ entry, owner = CLOSER_INCONCLUSIVE_RETRY_OWNER }) {
  return `closer could not conclude ${entry.attempt} times (last: ${entry.reason}); `
    + `owner ${owner} retries at ${entry.nextAttemptAt}; no closer budget was spent; `
    + 'recommended next action: repair the named infrastructure fault, the owned retry then proceeds through every merge check';
}
