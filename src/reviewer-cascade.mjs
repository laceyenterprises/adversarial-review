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

// `new Date(ms)` is Invalid Date -- and `.toISOString()` on it throws
// RangeError -- outside +/-8.64e15 ms of the epoch.
const MAX_REPRESENTABLE_INSTANT_MS = 8_640_000_000_000_000;

function isRepresentableInstant(ms) {
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_REPRESENTABLE_INSTANT_MS;
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
  failureReason = null,
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
  // Accept BOTH shapes of failure timestamp. Callers in this repo pass a
  // canonical ISO string, but epoch milliseconds is the conventional JS
  // timestamp, and `Date.parse(1755000000000)` stringifies its argument first
  // and returns NaN -- so a future caller handing us `Date.now()` directly
  // would have its explicit timestamp silently discarded and the backoff
  // re-anchored to processing time.
  const parsedFailedAtMs = typeof failedAt === 'number' ? failedAt : Date.parse(failedAt);
  const backoffWindowMs = backoffMinutes * 60_000;
  // Anchor on `now` when the caller hands us a timestamp we cannot turn into a
  // hold: both this value and the hold derived from it feed a
  // `new Date(...).toISOString()` that would otherwise throw RangeError inside
  // the watcher's failure-settle path -- i.e. a bad timestamp would crash the
  // very code trying to record a failure. `Date.parse` already rejects
  // out-of-range date STRINGS, but a numeric caller can hand us a finite value
  // past the +/-8.64e15ms Date range (or one that only overflows once the
  // backoff is added), so both instants are range-checked here.
  const failedAtUsable =
    isRepresentableInstant(parsedFailedAtMs)
    && isRepresentableInstant(parsedFailedAtMs + backoffWindowMs);
  const failedAtMs = failedAtUsable ? parsedFailedAtMs : Date.now();
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
  const backoffRetryAfterMs = failedAtMs + backoffWindowMs;
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
    lastFailureReason: typeof failureReason === 'string' && failureReason.trim()
      ? failureReason.trim()
      : null,
    // Normalized against the SAME anchor `retryAfter` was derived from. When
    // the caller hands us an unusable (or null) timestamp we already fall back
    // to `Date.now()` above; writing the raw value here instead would put a
    // non-ISO string -- or drop the key entirely -- into durable state that
    // `review-pipeline-health` republishes verbatim as the `since` field, and
    // would make `since` disagree with the `retryAfter` computed beside it.
    // A usable numeric timestamp is honored for the hold but still rendered as
    // ISO here, for the same reason: `since` must stay a parseable timestamp
    // STRING for those consumers. Only a usable string is passed through
    // byte-for-byte, so good input is never rewritten.
    lastFailureAt: failedAtUsable && typeof failedAt === 'string'
      ? failedAt
      : new Date(failedAtMs).toISOString(),
    nextRetryAfter: retryAfter,
    // Diagnostic only -- never gates. Preserved so an operator can still see
    // when the provider itself said it would recover. Omitting the key CLEARS
    // it: this object is the complete next state and `writeCascadeState`
    // replaces the whole file, so a later failure with no provider hint cannot
    // inherit an earlier failure's window. Do not turn this write into a merge
    // over `previous` -- that would attribute a stale quota reset to an
    // unrelated failure class. Only the fields explicitly carried forward
    // above (the counters and breakdown) survive across failures.
    //
    // Recorded whenever the caller supplied a hint, INCLUDING when it happens
    // to equal the computed hold. Suppressing the redundant case saved a few
    // bytes but made the key's absence ambiguous: an operator checking
    // `providerRetryAfter` to confirm the provider reported a reset would find
    // it mysteriously missing on the one failure where the two clocks agreed.
    // Absence means exactly one thing -- the caller passed no provider hint.
    ...(nextRetryAfter ? { providerRetryAfter: nextRetryAfter } : {}),
    backoffMinutes,
  });
}

function markCascadeCapExhaustedAlerted(rootDir, {
  repo,
  prNumber,
  alertedAt = new Date().toISOString(),
  failureClass = null,
  attempts = null,
  cap = null,
  reason = null,
} = {}) {
  const previous = readCascadeState(rootDir, { repo, prNumber }) || {};
  if (previous.capExhaustedAlertedAt) {
    return { marked: false, state: previous };
  }
  const state = {
    ...previous,
    capExhaustedAlertedAt: alertedAt,
    capExhaustedAlert: {
      failureClass: failureClass || previous.lastFailureClass || null,
      attempts: Number.isFinite(Number(attempts)) ? Number(attempts) : null,
      cap: Number.isFinite(Number(cap)) ? Number(cap) : null,
      reason: reason || previous.lastFailureReason || null,
    },
  };
  return { marked: true, state: writeCascadeState(rootDir, { repo, prNumber }, state) };
}

function markOperatorDecisionRequiredAlerted(rootDir, {
  repo,
  prNumber,
  headSha,
  alertedAt = new Date().toISOString(),
  reason = null,
} = {}) {
  // Keyed on head sha: a PR that lands in `remediation-stopped` alerts ONCE per
  // head, and a fresh push re-arms it. Without the key an operator gets one
  // alert for the lifetime of the PR no matter how many times it is revised;
  // with no dedupe at all the watcher pages on every poll.
  const previous = readCascadeState(rootDir, { repo, prNumber }) || {};
  if (headSha && previous.operatorDecisionAlertedHeadSha === headSha) {
    return { marked: false, state: previous };
  }
  const state = {
    ...previous,
    operatorDecisionAlertedHeadSha: headSha || null,
    operatorDecisionAlertedAt: alertedAt,
    operatorDecisionAlert: { reason: reason || null },
  };
  return { marked: true, state: writeCascadeState(rootDir, { repo, prNumber }, state) };
}

function hasOperatorDecisionRequiredAlerted(rootDir, {
  repo,
  prNumber,
  headSha,
} = {}) {
  const state = readCascadeState(rootDir, { repo, prNumber }) || {};
  return Boolean(headSha && state.operatorDecisionAlertedHeadSha === headSha);
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
  hasOperatorDecisionRequiredAlerted,
  markCascadeCapExhaustedAlerted,
  markOperatorDecisionRequiredAlerted,
  isReviewerSubprocessTimeout,
  readCascadeState,
  recordCascadeFailure,
  resolveCascadeBackoffMinutes,
  shouldBackoffReviewerSpawn,
};
