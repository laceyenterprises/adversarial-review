// Hammer lifetime cap — a hard, per-PR ceiling on hammer re-dispatch.
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
// The fix: a per-PR attempt ledger keyed on `(repo, prNumber)` — NOT the head.
// The lifetime counter survives both the head churn a hammer causes and fresh
// adversarial-review resets. On the first tick after the configured lifetime
// ceiling is consumed, the closer stops, fails loud via an operator alert, and
// marks the PR suppressed so the watcher stops re-dispatching.

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../atomic-write.mjs';
import {
  DEFAULT_RISK_CLASS,
  DEFAULT_ROUND_BUDGET_BY_RISK,
  HAMMER_SERIES_RETRIES,
  HAMMER_SERIES_TOTAL_DISPATCHES,
  hammerLifetimeDispatchesFor,
} from '../kernel/convergence-budget.mjs';

// One retry: initial hammer + 1 re-dispatch. The cap is expressed as a total
// number of hammer dispatches allowed for a logical PR before suppression.
// Owned by `../kernel/convergence-budget.mjs` so the lifetime ceiling below can be
// floored against it without an import cycle.
export const HAMMER_RETRY_CAP_RETRIES = HAMMER_SERIES_RETRIES;
export const HAMMER_RETRY_CAP_TOTAL_DISPATCHES = HAMMER_SERIES_TOTAL_DISPATCHES; // 2

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
// DERIVED: one full budget of retries on top of one full budget of rounds. At
// the default table this is 6 — the value this constant used to hardcode — and
// it rises automatically when an operator raises the round budget, so the
// "set above the per-series cap" intent above stays true instead of silently
// becoming false the moment the budget moves.
export const HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES = hammerLifetimeDispatchesFor(
  DEFAULT_ROUND_BUDGET_BY_RISK[DEFAULT_RISK_CLASS],
);
export const HAMMER_RETRY_CAP_LIFETIME_SUPPRESSION_STATE = 'hammer-lifetime-ceiling-reached-needs-operator';
export const HAMMER_RETRY_CAP_LIFETIME_EXHAUSTED_REASON = 'hammer-lifetime-ceiling-reached';
export const HAMMER_TARGET_REDRIVE_CAP_SUPPRESSION_STATE = 'hammer-target-redrive-cap-exhausted-needs-operator';
export const HAMMER_TARGET_REDRIVE_CAP_EXHAUSTED_REASON = 'hammer-target-redrive-cap-exhausted';

// HAMBG-02: a hammer that exited `succeeded` without closing its PR never ran
// its close, so re-arming it should not spend the series' one real retry. The
// charged attempt is handed back and `retryable` counts it. The shape follows
// HAMGATE-01's merge-gate refund (#1165), but the two are separate: that one
// lives in the base-branch gate-attempt records under data/merge-leases/ with
// its own `retryable`, and neither budget draws on the other. Only this many exits per series are refunded;
// after that an exit stays charged and the normal cap suppresses and alerts.
// The lifetime count is never refunded, so the lifetime ceiling still bounds
// every PR. CLOSERREUSE-01 refunds a hammer that died of an infrastructure
// cause without pushing from this same budget (src/ama/dead-hammer-rearm.mjs):
// one refund per series, whichever way the hammer ended.
export const HAMMER_EXITED_WITHOUT_CLOSE_RETRY_BUDGET = 1;
const RETRYABLE_LAUNCH_HISTORY = 10;

const HAMMER_RETRY_CAP_SCHEMA_VERSION = 2;

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
export function normalizeHammerLifetimeDispatchCeiling(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES;
  const int = Math.trunc(n);
  return int >= 0 ? int : HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES;
}

// Absent until the first refund, so ledgers without one keep their old shape.
function retryableFieldsForSeries(ledger) {
  const retryable = Math.max(0, Math.trunc(Number(ledger?.retryable) || 0));
  const retryableLaunchRequestIds = Array.isArray(ledger?.retryableLaunchRequestIds)
    ? ledger.retryableLaunchRequestIds.map(String).slice(-RETRYABLE_LAUNCH_HISTORY)
    : [];
  if (retryable === 0 && retryableLaunchRequestIds.length === 0) return {};
  return { retryable, retryableLaunchRequestIds };
}

function sanitizeLifetimeCount(rawValue, ceiling = HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES) {
  if (rawValue === null || rawValue === undefined) return 0;
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return normalizeHammerLifetimeDispatchCeiling(ceiling);
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
export function evaluateHammerRetryCap(ledger, {
  jobKey,
  headSha,
  lifetimeDispatchCeiling = HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES,
} = {}) {
  const lifetimeCeiling = normalizeHammerLifetimeDispatchCeiling(lifetimeDispatchCeiling);
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
    ? sanitizeLifetimeCount(ledger.lifetimeAttemptCount ?? ledger.attemptCount, lifetimeCeiling)
    : 0;
  const nextLifetimeCount = priorLifetimeCount + 1;
  const lifetimeAlreadySuppressed = Boolean(ledger?.lifetimeSuppressed);
  const lifetimeCapExhausted = lifetimeAlreadySuppressed
    || nextLifetimeCount > lifetimeCeiling;
  const incomingTargetSha = normalizeKey(headSha);
  const ledgerTargetSha = normalizeKey(ledger?.targetRemediationSha);
  const targetShaChanged = Boolean(
    ledger
      && ledgerTargetSha
      && incomingTargetSha
      && ledgerTargetSha !== incomingTargetSha,
  );
  const priorTargetAttemptCount = (!ledger || targetShaChanged)
    ? 0
    : Math.max(0, Number(ledgerTargetSha ? (ledger.targetAttemptCount ?? 0) : 0));
  const nextTargetAttemptCount = priorTargetAttemptCount + 1;
  const targetAlreadySuppressed = Boolean(ledger?.targetSuppressed) && !targetShaChanged;
  const targetRedriveCapExhausted = targetAlreadySuppressed
    || nextTargetAttemptCount > HAMMER_RETRY_CAP_TOTAL_DISPATCHES;
  const seriesAlertAlreadyEmitted = alreadySuppressed && Boolean(ledger?.alertedAt);
  const lifetimeAlertAlreadyEmitted = lifetimeAlreadySuppressed && Boolean(ledger?.alertedAt);
  const targetAlertAlreadyEmitted = targetAlreadySuppressed && Boolean(ledger?.targetAlertedAt);
  // Three independent stop conditions. The MIDDLE term — the per-series cap of
  // HAMMER_RETRY_CAP_TOTAL_DISPATCHES (2, i.e. 1 hammer + 1 retry per reviewed
  // head) — is load-bearing: without it a PR that never converges on a stable
  // reviewed head (red CI / conflict / gate never green, so no fresh review
  // posts to advance the jobKey) is re-hammered up to the lifetime ceiling of 6
  // instead of 2 — a 3x over-dispatch and quota burn. It was dropped in #532
  // (3514e00), which reintroduced the runaway; do NOT collapse this back to
  // `alreadySuppressed || lifetimeCapExhausted`.
  const capExhausted = alreadySuppressed
    || nextAttemptCount > HAMMER_RETRY_CAP_TOTAL_DISPATCHES
    || targetRedriveCapExhausted
    || lifetimeCapExhausted;
  return {
    jobKeyChanged,
    priorAttemptCount,
    nextAttemptCount,
    priorLifetimeCount,
    nextLifetimeCount,
    priorTargetAttemptCount,
    nextTargetAttemptCount,
    lifetimeDispatchCeiling: lifetimeCeiling,
    alreadySuppressed,
    lifetimeAlreadySuppressed,
    lifetimeCapExhausted,
    targetShaChanged,
    targetAlreadySuppressed,
    targetRedriveCapExhausted,
    capExhausted,
    seriesAlertAlreadyEmitted,
    lifetimeAlertAlreadyEmitted,
    targetAlertAlreadyEmitted,
    alertAlreadyEmitted: seriesAlertAlreadyEmitted
      || lifetimeAlertAlreadyEmitted
      || targetAlertAlreadyEmitted,
    resetFromJobKey: jobKeyChanged ? ledgerJobKey : null,
    headSha: incomingTargetSha,
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
  lifetimeDispatchCeiling = HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES,
  now = null,
} = {}) {
  const existing = readHammerRetryCapLedger(rootDir, identity);
  const decision = evaluateHammerRetryCap(existing, { jobKey, headSha, lifetimeDispatchCeiling });
  const incomingJobKey = normalizeKey(jobKey);
  const head = normalizeKey(headSha);
  const existingTargetSha = normalizeKey(existing?.targetRemediationSha);
  const targetShaChanged = Boolean(existing && existingTargetSha && head && existingTargetSha !== head);
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
    // Lifetime count survives fresh reviews; only bounded deferral refunds reduce it.
    lifetimeAttemptCount: decision.nextLifetimeCount,
    targetRemediationSha: head || existingTargetSha,
    targetAttemptCount: targetShaChanged ? 1 : decision.nextTargetAttemptCount,
    // Refunded exits belong to the series, like attemptCount.
    ...retryableFieldsForSeries(decision.jobKeyChanged ? null : existing),
    ...deferralFieldsForSeries(existing, decision.jobKeyChanged),
    dispatchHeads,
    lastDispatchedHeadSha: head || existing?.lastDispatchedHeadSha || null,
    // A dispatch clears any stale PER-SERIES suppression from a prior series (the
    // reset path). Within the same series we never reach here while suppressed
    // (the closer refuses to dispatch). The LIFETIME suppression is not cleared
    // by a dispatch — but the closer never dispatches once lifetimeCapExhausted,
    // so reaching here always means the lifetime ceiling has not been hit.
    suppressed: false,
    lifetimeSuppressed: false,
    targetSuppressed: false,
    suppressionState: null,
    suppressedJobKey: null,
    suppressedHeadSha: null,
    suppressedAttemptCount: null,
    alertedAt: null,
    targetAlertedAt: null,
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
  target = false,
  now = null,
} = {}) {
  const existing = readHammerRetryCapLedger(rootDir, identity);
  const incomingJobKey = normalizeKey(jobKey);
  const head = normalizeKey(headSha);
  const existingTargetSha = normalizeKey(existing?.targetRemediationSha);
  const targetShaChanged = Boolean(
    existing
      && existingTargetSha
      && head
      && existingTargetSha !== head,
  );
  // Refunds belong to the series: a suppression stamped for a fresh review's
  // job key must not carry the previous series' spent refund into it.
  const existingJobKey = normalizeKey(existing?.jobKey);
  const jobKeyChanged = Boolean(incomingJobKey && existingJobKey && incomingJobKey !== existingJobKey);
  const priorHeads = Array.isArray(existing?.dispatchHeads) ? existing.dispatchHeads : [];
  const dispatchHeads = head && !priorHeads.includes(head) ? [...priorHeads, head] : priorHeads;
  // A lifetime exhaustion (or one already stamped) is immune to the fresh-review
  // reset: `lifetimeSuppressed` is never cleared by a jobKey change, so a hammer
  // cannot re-arm the loop by earning a fresh review on the head it moved.
  const lifetimeSuppressed = Boolean(lifetime) || Boolean(existing?.lifetimeSuppressed);
  const targetSuppressed = Boolean(target) || (Boolean(existing?.targetSuppressed) && !targetShaChanged);
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
    targetRemediationSha: head || existingTargetSha,
    targetAttemptCount: targetShaChanged
      ? 0
      : Math.max(0, Number(existing?.targetAttemptCount ?? existing?.attemptCount ?? 0)),
    lifetimeSuppressed,
    targetSuppressed,
    ...retryableFieldsForSeries(jobKeyChanged ? null : existing),
    ...deferralFieldsForSeries(existing, jobKeyChanged),
    dispatchHeads,
    lastDispatchedHeadSha: head || existing?.lastDispatchedHeadSha || null,
    suppressed: true,
    suppressionState: lifetimeSuppressed
      ? HAMMER_RETRY_CAP_LIFETIME_SUPPRESSION_STATE
      : targetSuppressed
      ? HAMMER_TARGET_REDRIVE_CAP_SUPPRESSION_STATE
      : HAMMER_RETRY_CAP_SUPPRESSION_STATE,
    suppressedJobKey: incomingJobKey || normalizeKey(existing?.jobKey),
    suppressedHeadSha: head || existing?.suppressedHeadSha || null,
    suppressedAttemptCount: Number.isFinite(Number(attemptCount))
      ? Number(attemptCount)
      : Math.max(0, Number(existing?.attemptCount || 0)),
    // Preserve a prior alertedAt so a repeat suppression tick that couldn't send
    // the alert doesn't erase the record that it once succeeded.
    alertedAt: !target && alertEmitted
      ? (now || existing?.alertedAt || null)
      : (existing?.alertedAt || null),
    targetAlertedAt: target && alertEmitted
      ? (now || existing?.targetAlertedAt || null)
      : (targetShaChanged ? null : (existing?.targetAlertedAt || null)),
    createdAt: existing?.createdAt || now || null,
    updatedAt: now || existing?.updatedAt || null,
  };
  writeHammerRetryCapLedger(rootDir, identity, doc);
  return doc;
}

/**
 * HAMBG-02: refund the charged dispatch of a hammer that exited without
 * closing its PR, or (CLOSERREUSE-01) that died of an infrastructure cause
 * without pushing (see HAMMER_EXITED_WITHOUT_CLOSE_RETRY_BUDGET). `attemptCount`
 * (and `targetAttemptCount` for the same target head) goes down by one and
 * `retryable` goes up by one. A launch is refunded at most
 * once, however many ticks observe it. The lifetime count is not touched.
 *
 * Refuses when the ledger is absent or corrupt, the series moved on (new
 * jobKey), the series is suppressed, nothing is charged, or the budget is spent.
 * Those cases leave the attempt charged, which is the safe direction.
 *
 * @returns {{ refunded: boolean, reason: string, retryable: number }}
 */
export function refundHammerRetryDispatch(rootDir, identity, {
  jobKey,
  headSha,
  launchRequestId,
  budget = HAMMER_EXITED_WITHOUT_CLOSE_RETRY_BUDGET,
  now = null,
} = {}) {
  const existing = readHammerRetryCapLedger(rootDir, identity);
  const series = retryableFieldsForSeries(existing);
  const retryable = series.retryable || 0;
  const refundedLaunches = series.retryableLaunchRequestIds || [];
  const launch = normalizeKey(launchRequestId);
  const refuse = (reason) => ({ refunded: false, reason, retryable });
  if (!existing || existing.__corrupt) return refuse('no-ledger');
  const ledgerJobKey = normalizeKey(existing.jobKey);
  const incomingJobKey = normalizeKey(jobKey);
  if (ledgerJobKey && incomingJobKey && ledgerJobKey !== incomingJobKey) return refuse('series-changed');
  if (launch && (refundedLaunches.includes(launch) || existing.deferralLaunches?.includes(launch))) return refuse('already-refunded');
  if (existing.suppressed || existing.lifetimeSuppressed || existing.targetSuppressed) return refuse('suppressed');
  const attemptCount = Math.max(0, Math.trunc(Number(existing.attemptCount) || 0));
  if (attemptCount === 0) return refuse('no-charged-attempt');
  if (retryable >= Math.max(0, Math.trunc(Number(budget) || 0))) return refuse('retry-budget-exhausted');
  const head = normalizeKey(headSha);
  const targetMatches = Boolean(head) && normalizeKey(existing.targetRemediationSha) === head;
  const doc = {
    ...existing,
    attemptCount: attemptCount - 1,
    targetAttemptCount: targetMatches
      ? Math.max(0, Math.trunc(Number(existing.targetAttemptCount) || 0) - 1)
      : existing.targetAttemptCount,
    retryable: retryable + 1,
    retryableLaunchRequestIds: [...refundedLaunches, launch].filter(Boolean).slice(-RETRYABLE_LAUNCH_HISTORY),
    updatedAt: now || existing.updatedAt || null,
  };
  writeHammerRetryCapLedger(rootDir, identity, doc);
  return { refunded: true, reason: 'hammer-exited-without-close', retryable: retryable + 1 };
}

// LEASEPARK-01: lifetime refund budget survives fresh reviews, bounding the
// total extra launches even if every launch pushes and changes the job key.
const LIFETIME_DEFERRAL_REFUND_BUDGET = 12;
function deferralFieldsForSeries(existing, jobKeyChanged = false) {
  const launches = Array.isArray(existing?.deferralLaunches) ? existing.deferralLaunches : [];
  // Legacy ledgers cannot prove how many earlier series refunded lifetime
  // charges. Refuse further lifetime refunds until an operator reconciles them.
  const raw = existing?.lifetimeDeferralRefundCount ?? (existing ? LIFETIME_DEFERRAL_REFUND_BUDGET : 0);
  const lifetimeDeferralRefundCount = Number.isSafeInteger(raw) && raw >= 0
    ? Math.min(LIFETIME_DEFERRAL_REFUND_BUDGET, raw) : LIFETIME_DEFERRAL_REFUND_BUDGET;
  return {
    deferralLaunches: jobKeyChanged ? [] : launches,
    deferralStartedAt: jobKeyChanged ? null : existing?.deferralStartedAt || null,
    deferralNextAt: jobKeyChanged ? null : existing?.deferralNextAt || null,
    lifetimeDeferralRefundCount,
  };
}

// Contention has its own bounded history, separate from ordinary retry refunds.
export function deferHammerRetryDispatch(rootDir, identity, { jobKey, launchRequestId, headSha, now } = {}) {
  const ledger = readHammerRetryCapLedger(rootDir, identity);
  if (!ledger || ledger.__corrupt || ledger.jobKey !== jobKey || !launchRequestId) return null;
  const fields = deferralFieldsForSeries(ledger);
  const launches = fields.deferralLaunches;
  if (launches.includes(launchRequestId)) return ledger;
  const alreadyRefunded = ledger.retryableLaunchRequestIds?.includes(launchRequestId) === true;
  const refund = !alreadyRefunded && launches.length < 12 && ledger.attemptCount > 0;
  const lifetimeRefund = refund && fields.lifetimeDeferralRefundCount < LIFETIME_DEFERRAL_REFUND_BUDGET;
  const deferredAt = now || new Date().toISOString();
  const count = launches.length + 1;
  const doc = { ...ledger, ...fields,
    attemptCount: refund ? Math.max(0, ledger.attemptCount - 1) : ledger.attemptCount,
    lifetimeAttemptCount: lifetimeRefund ? Math.max(0, ledger.lifetimeAttemptCount - 1) : ledger.lifetimeAttemptCount,
    lifetimeDeferralRefundCount: fields.lifetimeDeferralRefundCount + (lifetimeRefund ? 1 : 0),
    targetAttemptCount: refund && ledger.targetRemediationSha === headSha
      ? Math.max(0, ledger.targetAttemptCount - 1) : ledger.targetAttemptCount,
    deferralLaunches: [...launches, launchRequestId],
    deferralStartedAt: ledger.deferralStartedAt || deferredAt,
    deferralNextAt: new Date(Date.parse(deferredAt) + Math.min(1800, 60 * 2 ** Math.min(count, 5)) * 1000).toISOString(),
    updatedAt: deferredAt,
  };
  writeHammerRetryCapLedger(rootDir, identity, doc);
  return doc;
}
