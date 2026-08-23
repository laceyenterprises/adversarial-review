/**
 * Per-PR transient-failure ("cascade") backoff state for reviewer spawns.
 *
 * "Cascade" is the LiteLLM/upstream-provider failure class ("all upstream
 * attempts failed"); the module now tracks EVERY transient reviewer failure
 * class (oauth-broken, reviewer-timeout, launchctl-bootstrap, quota-exhausted,
 * broker-unavailable, github-unavailable, deploy-wedge, provider-overloaded,
 * reviewer-empty-output) under the original name. The contract that makes this state matter:
 * transient failures must NOT burn `reviewed_prs.review_attempts` — the row
 * settles to `pending-upstream` and this file-backed gate
 * (`shouldBackoffReviewerSpawn`, consulted by pollOnce before the claim CAS)
 * decides when the watcher may re-attempt.
 *
 * Why files under data/cascade-state/ and not SQLite or memory: the state
 * must survive watcher restarts (a crash-looping watcher must not hammer a
 * struggling provider from a fresh counter), and the atomic
 * tmp+fsync+rename write below keeps a crashed writer from ever leaving a
 * torn JSON that would (fail-closed) park the PR.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROVIDER_OVERLOADED_FAILURE_CLASS,
  REVIEWER_EMPTY_OUTPUT_FAILURE_CLASS,
  classifyReviewerFailure,
  isReviewerSubprocessTimeout,
} from './adapters/reviewer-runtime/cli-direct/classification.mjs';

// Backoff schedule indexed by (consecutive transient failures - 1). Roughly
// exponential but deliberately PLATEAUS at 15 minutes instead of doubling
// unbounded: upstream provider outages resolve on the minutes-to-an-hour
// scale, and an unbounded exponent would leave PRs parked for hours after
// the provider recovered. The counter is clamped to CASCADE_FAILURE_CAP, so
// the last entry is the permanent steady-state retry cadence.
const CASCADE_BACKOFF_MINUTES = [1, 2, 4, 8, 15];
// Clamp for consecutiveTransientFailures (keeps the counter from growing
// unbounded across a long outage). Doubles as a threshold elsewhere: the
// watcher's reviewer-timeout exhaustion handoff fires when the
// `transientFailureBreakdown['reviewer-timeout']` count reaches this cap
// (see isReviewerTimeoutExhaustedRow in watcher.mjs) — so raising it also
// delays that escalation.
const CASCADE_FAILURE_CAP = 5;
const CASCADE_STATE_DIR = ['data', 'cascade-state'];

function getCascadeStateDir(rootDir) {
  return join(rootDir, ...CASCADE_STATE_DIR);
}

function getCascadeStatePath(rootDir, { repo, prNumber }) {
  const normalizedPrNumber = Number(prNumber);
  if (!Number.isInteger(normalizedPrNumber) || normalizedPrNumber <= 0) {
    throw new TypeError(`Invalid PR number for cascade state: ${prNumber}`);
  }

  const normalizedRepo = String(repo || '').trim();
  if (!normalizedRepo) {
    throw new TypeError('Repo slug is required for cascade state');
  }

  return join(
    getCascadeStateDir(rootDir),
    `${encodeURIComponent(normalizedRepo)}__${normalizedPrNumber}.json`
  );
}

function readCascadeState(rootDir, { repo, prNumber }) {
  const path = getCascadeStatePath(rootDir, { repo, prNumber });
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeCascadeState(rootDir, { repo, prNumber }, state) {
  mkdirSync(getCascadeStateDir(rootDir), { recursive: true });
  const path = getCascadeStatePath(rootDir, { repo, prNumber });
  const tmpPath = `${path}.tmp`;
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const tmpFd = openSync(tmpPath, 'w');
  try {
    writeFileSync(tmpFd, payload, 'utf8');
    fsyncSync(tmpFd);
  } finally {
    closeSync(tmpFd);
  }
  renameSync(tmpPath, path);
  return state;
}

function clearCascadeState(rootDir, { repo, prNumber }) {
  rmSync(getCascadeStatePath(rootDir, { repo, prNumber }), { force: true });
}

function resolveCascadeBackoffMinutes(consecutiveCascadeFailures) {
  const index = Math.max(
    0,
    Math.min(CASCADE_BACKOFF_MINUTES.length - 1, Number(consecutiveCascadeFailures || 1) - 1)
  );
  return CASCADE_BACKOFF_MINUTES[index];
}

function normalizeTransientFailureClass(failureClass) {
  const value = String(failureClass || '').trim();
  if (
    value === 'cascade' ||
    value === 'oauth-broken' ||
    value === 'reviewer-timeout' ||
    value === 'launchctl-bootstrap' ||
    value === 'quota-exhausted' ||
    value === 'broker-unavailable' ||
    value === 'github-unavailable' ||
    value === 'deploy-wedge' ||
    value === 'reviewer-output' ||
    value === REVIEWER_EMPTY_OUTPUT_FAILURE_CLASS ||
    value === PROVIDER_OVERLOADED_FAILURE_CLASS
  ) {
    return value;
  }
  return 'cascade';
}

function formatTransientFailureBreakdown(breakdown = {}) {
  return Object.entries(breakdown)
    .filter(([, count]) => Number(count) > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([failureClass, count]) => `${failureClass}=${Number(count)}`)
    .join(', ');
}

function recordCascadeFailure(rootDir, {
  repo,
  prNumber,
  failedAt = new Date().toISOString(),
  failureClass = 'cascade',
  nextRetryAfter = null,
} = {}) {
  const previous = readCascadeState(rootDir, { repo, prNumber });
  // SCHEMA SHIM — do not remove while any data/cascade-state/*.json written
  // before the multi-class rename can still exist on a host. Older state
  // files carry `consecutiveCascadeFailures` (cascade was the only tracked
  // class); newer files carry `consecutiveTransientFailures` plus a per-class
  // `transientFailureBreakdown`. Reading new-then-old here means an in-place
  // watcher upgrade continues an in-progress backoff instead of resetting the
  // counter to 0 mid-outage (which would collapse the backoff back to 1m and
  // hammer the still-down provider).
  const previousCount = Number(
    previous?.consecutiveTransientFailures ?? previous?.consecutiveCascadeFailures ?? 0
  );
  const consecutiveTransientFailures = Math.min(previousCount + 1, CASCADE_FAILURE_CAP);
  const backoffMinutes = resolveCascadeBackoffMinutes(consecutiveTransientFailures);
  const parsedFailedAtMs = Date.parse(failedAt);
  // Anchor on `now` when the caller hands us an unparseable timestamp: this
  // value feeds a `new Date(...).toISOString()` that would otherwise throw
  // RangeError inside the watcher's failure-settle path -- i.e. a bad
  // timestamp would crash the very code trying to record a failure.
  const failedAtMs = Number.isFinite(parsedFailedAtMs) ? parsedFailedAtMs : Date.now();
  // The PR-level hold is ALWAYS the backoff this function just computed. A
  // caller-supplied `nextRetryAfter` (a provider quota reset) is a hint about
  // one PROVIDER; this state is reviewer-AGNOSTIC and holds the PR against
  // EVERY eligible reviewer, so letting it set the hold is wrong in both
  // directions:
  //
  //   too long  -- observed 2026-08-23: the codex weekly cap wrote
  //                nextRetryAfter=2026-08-27T04:38Z onto agent-os#5715 and
  //                adversarial-review#892 while backoffMinutes was 2. Both PRs
  //                were held for FOUR DAYS against gemini, which was uncapped
  //                and idle; the review lane went silent and the merge backlog
  //                froze.
  //   too short -- a provider that reports a near-immediate reset (or a stale
  //                one already in the past) would drop the hold below the
  //                exponential schedule, so `consecutiveTransientFailures`
  //                would climb while the PR tight-loops against the reviewer
  //                network -- exactly what the backoff exists to prevent.
  //
  // Provider outages already have their own, correct gate: the provider
  // suspension surfaced by `hq fleet quota status`, which blocks only the
  // capped classes and leaves the rest serving. The provider's own estimate is
  // kept as `providerRetryAfter` for diagnosis and never gates.
  const backoffRetryAfterMs = failedAtMs + (backoffMinutes * 60_000);
  const retryAfter = new Date(backoffRetryAfterMs).toISOString();
  const normalizedFailureClass = normalizeTransientFailureClass(failureClass);
  const transientFailureBreakdown = previous?.transientFailureBreakdown
    ? { ...previous.transientFailureBreakdown }
    : {};
  // Second half of the shim: fold a legacy cascade-only count into the
  // breakdown map exactly once (only when no breakdown exists yet), so the
  // per-class totals — including the reviewer-timeout count that gates the
  // watcher's exhaustion handoff — stay monotonic across the schema change.
  if (!previous?.transientFailureBreakdown && Number(previous?.consecutiveCascadeFailures) > 0) {
    transientFailureBreakdown.cascade = Number(previous.consecutiveCascadeFailures);
  }
  transientFailureBreakdown[normalizedFailureClass] = Number(
    transientFailureBreakdown[normalizedFailureClass] || 0
  ) + 1;
  return writeCascadeState(rootDir, { repo, prNumber }, {
    consecutiveTransientFailures,
    transientFailureBreakdown,
    lastFailureClass: normalizedFailureClass,
    lastFailureAt: failedAt,
    nextRetryAfter: retryAfter,
    // Diagnostic only -- never gates. Preserved so an operator can still see
    // when the provider itself said it would recover.
    ...(nextRetryAfter && nextRetryAfter !== retryAfter
      ? { providerRetryAfter: nextRetryAfter }
      : {}),
    backoffMinutes,
  });
}

function shouldBackoffReviewerSpawn(rootDir, { repo, prNumber, now = new Date().toISOString() }) {
  const state = readCascadeState(rootDir, { repo, prNumber });
  if (!state?.nextRetryAfter) {
    return { shouldBackoff: false, state: null };
  }

  const nowMs = Date.parse(now);
  const nextRetryMs = Date.parse(state.nextRetryAfter);
  if (!Number.isFinite(nowMs) || !Number.isFinite(nextRetryMs)) {
    return { shouldBackoff: true, state };
  }

  if (nowMs >= nextRetryMs) {
    return { shouldBackoff: false, state };
  }

  return { shouldBackoff: true, state };
}

export {
  CASCADE_FAILURE_CAP,
  PROVIDER_OVERLOADED_FAILURE_CLASS,
  REVIEWER_EMPTY_OUTPUT_FAILURE_CLASS,
  classifyReviewerFailure,
  clearCascadeState,
  formatTransientFailureBreakdown,
  getCascadeStatePath,
  isReviewerSubprocessTimeout,
  readCascadeState,
  recordCascadeFailure,
  resolveCascadeBackoffMinutes,
  shouldBackoffReviewerSpawn,
};
