// RPL-07 — controlled burst reviewer capacity lease.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// The steady-state posture is AGY-first and deliberately cheap: one serialized
// Gemini/AGY reviewer, so provider quota goes to the work that ships code. That
// posture is correct for the 99% case and wrong for the 1% — a demo, an urgent
// active pack, a backlog burn-down — where an operator knowingly wants to spend
// money to make review latency go away for the next half hour.
//
// RSP-01 (`review-queue-depth.mjs`) already added ONE trigger for spending that
// money: queue depth. It is automatic, graded, and deliberately late. This
// module adds the other one the operator asked for: an EXPLICIT, SHORT,
// BOUNDED lease. Same mechanism underneath (spill first-pass review off the
// single cheap class onto an entitled, quota-available fallback class, and give
// those extra reviewers pool slots to run in); different trigger.
//
// ── The five properties that make this safe to hand an operator ──────────────
//   1. DEFAULT OFF. No lease file => `{ active: false, slots: 0 }` and every
//      integration point behaves byte-identically to pre-RPL-07. There is no
//      config key to leave armed; a burst exists only while its lease record
//      does. SPEC §5: "No hidden global concurrency knob that stays elevated
//      after a burst."
//   2. TTL-BOUND AND SELF-DECAYING. Every lease carries an absolute
//      `expiresAt`, clamped to a system max. Expiry is derived on READ, so a
//      dead watcher, a crashed CLI, or a forgotten burst all decay to steady
//      state on their own. Nothing has to run for the burst to end.
//   3. SCOPED. A lease names the repos it may spend in (required — a
//      repo-less burst IS the hidden global knob) and may additionally name
//      active packs. Out-of-scope PRs see no burst at all.
//   4. BUDGETED. Two limbs, because only one of them is always measurable:
//      a hard cap on the NUMBER of burst-bought reviews (always enforceable),
//      and a dollar ceiling checked against observed reviewer spend when that
//      spend is readable. Exhausting either ends the lease.
//   5. AUDITED. Requested / activated / denied / expired / revoked transitions
//      are appended to the lease record and logged, so "why did last Tuesday
//      cost $40" is answerable without grepping a 245 MB watcher log.
//
// ── Where safety is actually enforced ────────────────────────────────────────
// Deliberately in two places, because they can afford different things:
//
//   - AT REQUEST/UPDATE TIME (operator CLI, once): the authoritative check.
//     Quota, posting health, and reviewer health are evaluated together and the
//     lease is REFUSED, or GRANTED WITH FEWER SLOTS than asked for. This is the
//     expensive check and it is fine to be expensive — it runs once per burst.
//   - CONTINUOUSLY (watcher, every routing decision): the cheap checks only.
//     TTL, scope, and budget are pure reads of the lease record. Live quota
//     safety is already enforced downstream and for free: a burst spill still
//     goes through `resolveReviewerWorkerClassWithFallback`, which will not
//     select a fallback class that is not entitled AND quota-available. So a
//     provider that grounds mid-burst stops the spend without this module
//     having to re-probe anything on the hot path.
//
// ── What this module does NOT do ─────────────────────────────────────────────
// It does not raise the Gemini/AGY in-flight cap. AGY reviewers check out from
// a shared, typically single-account credential pool; dispatching more
// concurrent AGY reviewers than there are credentials just makes them contend
// on the checkout lease and lose (see `resolveGeminiDispatchConcurrencyLimit`).
// Burst slots buy capacity for the DECLARED FALLBACK classes, which is what the
// SPEC §1 mockup means by "fallback_allowed: ... only if AGY soft ceiling
// trips". The AGY steady slot is untouched and stays the default.
//
// ── Configuration ────────────────────────────────────────────────────────────
// There are no `config.yaml` keys here, on purpose. A lease is operator STATE,
// not configuration, and every top-level config.yaml key is a review-pipeline
// timebomb until all three strict loaders (Python `_schema_v1`, this repo's
// Node `config-loader.mjs`, and `agent-os-config-loader.sh`) learn it in the
// same change — the documented multi-loader-parity failure that crash-looped
// the watcher on 2026-07-17. The only knobs are the SYSTEM CEILINGS below, read
// from this process's env, which an operator cannot exceed from the CLI.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';

const LEASE_RELATIVE_PATH = ['data', 'reviewer-burst-lease.json'];
const RECORD_SCHEMA_VERSION = 1;
const MAX_RETAINED_EVENTS = 50;
const MAX_RETAINED_HISTORY = 10;

// System ceilings. An operator request is clamped to these; the CLI cannot
// exceed them and says so when it clamps.
export const DEFAULT_BURST_MAX_SLOTS = 4;
export const DEFAULT_BURST_MAX_TTL_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_BURST_MAX_BUDGET_USD = 100;

// Request defaults, used when the operator does not say otherwise.
export const DEFAULT_BURST_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_BURST_SLOTS = 2;
export const DEFAULT_BURST_BUDGET_USD = 20;
// Reviews-per-slot cap. The always-enforceable limb of the budget guard: even
// with no cost telemetry at all, a lease can only buy this many non-primary
// reviews per granted slot before it decays.
export const DEFAULT_BURST_REVIEWS_PER_SLOT = 6;

// The AGY steady-state floor this lease is explicitly NOT allowed to change.
// Named so the operator surface can print "steady_agy_slots: 1" truthfully
// rather than implying burst widened the cheap lane.
export const STEADY_AGY_SLOTS = 1;

// The unit the dollar limb of the budget guard is measured in. Stated once,
// here, because an operator sets a threshold in it — and because a second,
// subtly different definition of "what the burst cost" would give two numbers
// that disagree during exactly the incident where both get read.
export const BURST_SPEND_UNIT =
  'summed reviewer_passes.token_cost_usd for passes STARTED at or after the lease '
  + 'activation timestamp in the lease-scoped repos (all reviewer classes, first-pass '
  + 'and rereview alike) — i.e. what review cost during the burst window in the repos '
  + 'the burst covers, not an attempt to attribute individual passes to the lease';

const TERMINAL_LEASE_STATES = new Set(['expired', 'revoked', 'denied']);

// ── small parsers ────────────────────────────────────────────────────────────

function positiveIntFromEnv(env, key, fallback) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumberFromEnv(env, key, fallback) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const parsed = Number.parseFloat(String(raw));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * System ceilings for this process. Env-only by design (see the module header's
 * configuration note); absent/malformed values fall back to the constants.
 */
export function resolveBurstSystemLimits(env = process.env) {
  return {
    maxSlots: positiveIntFromEnv(env, 'ADVERSARIAL_REVIEWER_BURST_MAX_SLOTS', DEFAULT_BURST_MAX_SLOTS),
    maxTtlMs: positiveIntFromEnv(env, 'ADVERSARIAL_REVIEWER_BURST_MAX_TTL_MS', DEFAULT_BURST_MAX_TTL_MS),
    maxBudgetUsd: positiveNumberFromEnv(
      env,
      'ADVERSARIAL_REVIEWER_BURST_MAX_BUDGET_USD',
      DEFAULT_BURST_MAX_BUDGET_USD,
    ),
  };
}

export function reviewerBurstLeasePath(rootDir) {
  return join(rootDir, ...LEASE_RELATIVE_PATH);
}

export function normalizeRepoScopeEntry(value) {
  return String(value || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
}

export function normalizePackScopeEntry(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeList(values, normalizer) {
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizer(value);
    if (normalized) seen.add(normalized);
  }
  return [...seen].sort();
}

/** Human "17m42s" for the status surface; null stays null. */
export function formatDurationMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return null;
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

// ── pack scope ───────────────────────────────────────────────────────────────

const TICKET_ID_RE = /\b([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,5})\b/g;

/**
 * The pack tokens a PR carries, from the identifiers the watcher already has at
 * admission time. A lease's `packs` list is matched against this set.
 *
 * A PR is in a pack when ANY of these is true:
 *   - it carries a label equal to the token, or to `pack:<token>` / `pack/<token>`
 *   - its Linear/plan ticket id equals the token (e.g. `rpl-07`)
 *   - the ALPHA PREFIX of that ticket id equals the token (e.g. `rpl`), which is
 *     how a ten-ticket pack is named in practice
 *   - a ticket id in the PR title or head branch satisfies either of the above
 *
 * Everything is lowercased. This is deliberately generous about WHERE the id
 * comes from and strict about WHAT matches: a token only ever matches a whole
 * label or a whole ticket id / ticket prefix, never a substring.
 */
export function packTokensForSubject({
  labels = [],
  linearTicketId = null,
  title = '',
  branch = '',
} = {}) {
  const tokens = new Set();
  for (const label of Array.isArray(labels) ? labels : []) {
    const name = normalizePackScopeEntry(typeof label === 'string' ? label : label?.name);
    if (!name) continue;
    tokens.add(name);
    const scoped = name.match(/^pack[:/](.+)$/);
    if (scoped?.[1]) tokens.add(scoped[1].trim());
  }
  const addTicket = (value) => {
    const ticket = normalizePackScopeEntry(value);
    if (!ticket) return;
    tokens.add(ticket);
    const prefix = ticket.split('-')[0];
    if (prefix && prefix !== ticket) tokens.add(prefix);
  };
  addTicket(linearTicketId);
  for (const source of [title, branch]) {
    for (const match of String(source || '').matchAll(TICKET_ID_RE)) {
      addTicket(`${match[1]}-${match[2]}`);
    }
  }
  tokens.delete('');
  return tokens;
}

// ── record shape ─────────────────────────────────────────────────────────────

function emptyUsage() {
  return {
    burstReviewsGranted: 0,
    byRepo: {},
    byWorkerClass: {},
    spendUsd: null,
    spendReadable: false,
    spendObservedAt: null,
  };
}

export function emptyReviewerBurstRecord() {
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    spendUnit: BURST_SPEND_UNIT,
    lease: null,
    history: [],
    events: [],
    updatedAt: null,
  };
}

function normalizeLease(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const usage = raw.usage && typeof raw.usage === 'object' ? raw.usage : {};
  return {
    leaseId: String(raw.leaseId || ''),
    state: String(raw.state || 'active'),
    reason: raw.reason ? String(raw.reason) : null,
    requestedBy: raw.requestedBy ? String(raw.requestedBy) : null,
    requestedAt: raw.requestedAt || null,
    activatedAt: raw.activatedAt || null,
    expiresAt: raw.expiresAt || null,
    ttlMs: Number(raw.ttlMs) || 0,
    requestedSlots: Number(raw.requestedSlots) || 0,
    slots: Number(raw.slots) || 0,
    repos: normalizeList(raw.repos, normalizeRepoScopeEntry),
    packs: normalizeList(raw.packs, normalizePackScopeEntry),
    budgetUsd: raw.budgetUsd === null || raw.budgetUsd === undefined ? null : Number(raw.budgetUsd),
    maxBurstReviews: Number(raw.maxBurstReviews) || 0,
    degraded: raw.degraded === true,
    degradeReasons: Array.isArray(raw.degradeReasons) ? raw.degradeReasons.map(String) : [],
    safety: raw.safety && typeof raw.safety === 'object' ? raw.safety : null,
    updates: Number(raw.updates) || 0,
    endedAt: raw.endedAt || null,
    endedReason: raw.endedReason ? String(raw.endedReason) : null,
    revokedBy: raw.revokedBy ? String(raw.revokedBy) : null,
    usage: { ...emptyUsage(), ...usage },
  };
}

/**
 * Read the durable lease record. Fails OPEN to "no burst": an unreadable or
 * malformed record must never be interpreted as an active lease, because the
 * failure mode of guessing wrong here is spending money on a burst nobody asked
 * for.
 */
export function readReviewerBurstRecord(rootDir, { readFileImpl = readFileSync } = {}) {
  try {
    const parsed = JSON.parse(String(readFileImpl(reviewerBurstLeasePath(rootDir), 'utf8')));
    if (!parsed || typeof parsed !== 'object') return emptyReviewerBurstRecord();
    return {
      ...emptyReviewerBurstRecord(),
      ...parsed,
      spendUnit: BURST_SPEND_UNIT,
      lease: normalizeLease(parsed.lease),
      history: Array.isArray(parsed.history) ? parsed.history : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
    };
  } catch {
    return emptyReviewerBurstRecord();
  }
}

function compactLeaseForHistory(lease) {
  if (!lease) return null;
  return {
    leaseId: lease.leaseId,
    state: lease.state,
    reason: lease.reason,
    requestedBy: lease.requestedBy,
    activatedAt: lease.activatedAt,
    expiresAt: lease.expiresAt,
    endedAt: lease.endedAt,
    endedReason: lease.endedReason,
    slots: lease.slots,
    repos: lease.repos,
    packs: lease.packs,
    budgetUsd: lease.budgetUsd,
    burstReviewsGranted: lease.usage?.burstReviewsGranted || 0,
    spendUsd: lease.usage?.spendUsd ?? null,
  };
}

// ── safety ───────────────────────────────────────────────────────────────────

export const BURST_SAFETY_DEFAULTS = Object.freeze({
  // Posting: a reviewer that runs but cannot land its review on GitHub is the
  // exact failure the pipeline-availability scar is about. Bursting into it
  // multiplies wasted spend without producing a single verdict.
  postingMinAttempts: 3,
  postingUnsafeFailureRatio: 0.5,
  postingDegradedFailureRatio: 0.25,
  // Reviewer health: stuck/impossible slots mean RPL-03 recovery is not keeping
  // up. Extra slots on top of leaked ones is how a "burst" becomes an outage.
  reviewerUnsafeStuckSlots: 2,
  reviewerDegradedStuckSlots: 1,
});

/**
 * Normalize the signals `evaluateBurstSafety` consumes out of a review-pipeline
 * health snapshot plus a fleet-quota reading.
 *
 * Kept PURE over a plain snapshot object (rather than importing the health
 * collector) so `review-pipeline-health.mjs` can import THIS module to surface
 * burst state without an import cycle.
 */
export function normalizeBurstSafetySignals({ healthSnapshot = null, quota = null } = {}) {
  const reviewer = healthSnapshot?.reviewer || null;
  const slotStates = healthSnapshot?.reviewerSlots?.states || null;
  const attempts = Number(reviewer?.total || 0);
  const failures = Number(reviewer?.failed || 0);
  // The health collector returns an all-zero reviewerSlots shape when it could
  // not open reviews.db, which is indistinguishable from a genuinely idle,
  // healthy pool. Tie readability to the LEDGER, not to the shape, so "no
  // ledger" reads as unknown (a burst blocker) rather than as perfect health.
  const ledgerReadable = Boolean(healthSnapshot) && healthSnapshot?.reviewStateLedger?.readable === true;
  const stuckSlots = ledgerReadable && slotStates
    ? Number(slotStates.stale || 0) + Number(slotStates.impossible || 0)
    : null;
  return {
    quota: {
      readable: quota?.readable === true,
      availableClasses: Array.isArray(quota?.availableClasses) ? quota.availableClasses : [],
      groundedClasses: Array.isArray(quota?.groundedClasses) ? quota.groundedClasses : [],
      reason: quota?.reason || null,
    },
    posting: {
      readable: ledgerReadable,
      attempts,
      failures,
      failureRatio: attempts > 0 ? failures / attempts : 0,
      outageActive: healthSnapshot?.outage?.active === true,
      windowMs: Number(healthSnapshot?.config?.reviewerDeathRateWindowMs || 0) || null,
    },
    reviewer: {
      readable: stuckSlots !== null,
      stuckSlots,
      states: slotStates,
    },
  };
}

/**
 * The refuse-or-degrade decision. PURE: every input is a plain object, so the
 * policy is testable without a database, a broker, or a clock.
 *
 * Blockers REFUSE the lease outright. Warnings DEGRADE it — the lease is still
 * granted but with fewer slots than asked for, which is the honest answer to
 * "the pipeline is wobbly but not broken and the operator has a demo in ten
 * minutes".
 */
export function evaluateBurstSafety({
  signals = null,
  requestedSlots = DEFAULT_BURST_SLOTS,
  maxSlots = DEFAULT_BURST_MAX_SLOTS,
  thresholds = BURST_SAFETY_DEFAULTS,
} = {}) {
  const blockers = [];
  const warnings = [];
  const limits = { ...BURST_SAFETY_DEFAULTS, ...(thresholds || {}) };
  const asked = Math.max(0, Math.trunc(Number(requestedSlots) || 0));
  let cap = Math.min(asked, Math.max(0, Math.trunc(Number(maxSlots) || 0)));

  const quota = signals?.quota || null;
  if (!quota || quota.readable !== true) {
    // Fail CLOSED for burst specifically. Unlike the steady-state paths — which
    // fail open to "keep reviewing on the cheap class" — the thing being
    // decided here is whether to START SPENDING. An unreadable quota state is
    // not permission to spend.
    blockers.push('quota-unreadable');
  } else if (quota.availableClasses.length === 0) {
    blockers.push('quota-no-available-burst-reviewer');
  } else if (quota.groundedClasses.length > 0) {
    warnings.push('quota-partially-grounded');
    cap = Math.min(cap, quota.availableClasses.length);
  }

  const posting = signals?.posting || null;
  if (!posting || posting.readable !== true) {
    blockers.push('posting-health-unreadable');
  } else if (posting.outageActive) {
    blockers.push('posting-outage-active');
  } else if (posting.attempts >= limits.postingMinAttempts) {
    if (posting.failureRatio >= limits.postingUnsafeFailureRatio) {
      blockers.push('posting-failure-rate-unsafe');
    } else if (posting.failureRatio >= limits.postingDegradedFailureRatio) {
      warnings.push('posting-failure-rate-degraded');
      cap = Math.min(cap, Math.max(1, Math.floor(cap / 2)));
    }
  }

  const reviewerHealth = signals?.reviewer || null;
  if (!reviewerHealth || reviewerHealth.readable !== true) {
    blockers.push('reviewer-health-unreadable');
  } else if (Number(reviewerHealth.stuckSlots || 0) >= limits.reviewerUnsafeStuckSlots) {
    blockers.push('reviewer-slots-stuck');
  } else if (Number(reviewerHealth.stuckSlots || 0) >= limits.reviewerDegradedStuckSlots) {
    warnings.push('reviewer-slots-degraded');
    cap = Math.min(cap, Math.max(1, Math.floor(cap / 2)));
  }

  if (blockers.length === 0 && cap < 1) blockers.push('no-slots-available');
  const allowedSlots = blockers.length === 0 ? cap : 0;
  return {
    safe: blockers.length === 0,
    degraded: blockers.length === 0 && allowedSlots < asked,
    requestedSlots: asked,
    allowedSlots,
    blockers,
    warnings,
    signals,
  };
}

// ── lease lifecycle ──────────────────────────────────────────────────────────

function nowIso(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value.toISOString() : new Date(value || Date.now()).toISOString();
}

function appendEvent(record, event) {
  record.events = [...(record.events || []), event].slice(-MAX_RETAINED_EVENTS);
  return event;
}

function persistRecord(rootDir, record, { writeFileImpl = writeFileAtomic, logger = console } = {}) {
  if (!rootDir) return false;
  try {
    writeFileImpl(reviewerBurstLeasePath(rootDir), `${JSON.stringify(record, null, 2)}\n`);
    return true;
  } catch (err) {
    logger?.warn?.(
      `[reviewer-burst-lease] lease record write failed: ${err?.message || err}`
    );
    return false;
  }
}

function logEvent(logger, event) {
  const parts = [
    `[reviewer-burst-lease] ${event.event}`,
    `lease_id=${event.leaseId || '-'}`,
    `slots=${event.slots ?? '-'}`,
    `repos=${(event.repos || []).join('|') || '-'}`,
    `packs=${(event.packs || []).join('|') || '*'}`,
    `expires_at=${event.expiresAt || '-'}`,
    `reason="${event.reason || ''}"`,
  ];
  if (event.blockers?.length) parts.push(`blockers=${event.blockers.join(',')}`);
  if (event.warnings?.length) parts.push(`warnings=${event.warnings.join(',')}`);
  if (event.burstReviewsGranted !== undefined) {
    parts.push(`burst_reviews_granted=${event.burstReviewsGranted}`);
  }
  logger?.warn?.(parts.join(' '));
}

function makeLeaseId(atIso) {
  const stamp = String(atIso).replace(/[^0-9]/g, '').slice(0, 14);
  return `burst-${stamp}-${Math.random().toString(16).slice(2, 8)}`;
}

/**
 * Derive the live state of a lease at `nowMs` WITHOUT writing anything.
 *
 * This is the decay guarantee: expiry is a function of the record and the
 * clock, so a burst ends on time even if the watcher is down, the CLI never
 * runs again, and nothing ever writes the `expired` event. The event is an
 * audit nicety; the expiry itself does not depend on it.
 */
export function evaluateLeaseState(lease, { nowMs = Date.now() } = {}) {
  if (!lease) return { active: false, state: 'inactive', lease: null, ttlRemainingMs: null, endReason: null };
  if (TERMINAL_LEASE_STATES.has(lease.state)) {
    return { active: false, state: lease.state, lease, ttlRemainingMs: null, endReason: lease.endedReason };
  }
  const expiresAtMs = Date.parse(lease.expiresAt || '');
  if (!Number.isFinite(expiresAtMs)) {
    // A lease with no readable expiry is not a forever lease. It is a corrupt
    // one, and a corrupt capacity lease decays.
    return { active: false, state: 'expired', lease, ttlRemainingMs: null, endReason: 'unreadable-expiry' };
  }
  if (nowMs >= expiresAtMs) {
    return { active: false, state: 'expired', lease, ttlRemainingMs: 0, endReason: 'ttl-elapsed' };
  }
  if (lease.slots < 1) {
    return { active: false, state: 'expired', lease, ttlRemainingMs: 0, endReason: 'no-slots-granted' };
  }
  const granted = Number(lease.usage?.burstReviewsGranted || 0);
  if (lease.maxBurstReviews > 0 && granted >= lease.maxBurstReviews) {
    return { active: false, state: 'expired', lease, ttlRemainingMs: 0, endReason: 'review-cap-reached' };
  }
  // An UNREADABLE spend is not a number, so it can neither pass nor trip the
  // dollar guard; the review-count cap above carries the bound on its own. The
  // null check is explicit because `Number(null)` is 0, and a `0 >= budget`
  // compare would turn "we don't know" into a spurious budget exhaustion.
  const spend = lease.usage?.spendUsd;
  const spendReadable = spend !== null && spend !== undefined && Number.isFinite(Number(spend));
  if (lease.budgetUsd !== null && spendReadable && Number(spend) >= lease.budgetUsd) {
    return { active: false, state: 'expired', lease, ttlRemainingMs: 0, endReason: 'budget-exhausted' };
  }
  return {
    active: true,
    state: 'active',
    lease,
    ttlRemainingMs: expiresAtMs - nowMs,
    endReason: null,
  };
}

function endLease(record, lease, { state, endedReason, at, revokedBy = null }) {
  lease.state = state;
  lease.endedAt = at;
  lease.endedReason = endedReason;
  if (revokedBy) lease.revokedBy = revokedBy;
  record.history = [...(record.history || []), compactLeaseForHistory(lease)].slice(-MAX_RETAINED_HISTORY);
  record.lease = lease;
  record.updatedAt = at;
}

/**
 * Settle a lease that has already decayed, writing the one-time `expired`
 * audit event. Safe to call on every read: it only writes on the transition.
 */
export function expireReviewerBurstLeaseIfDue(rootDir, {
  record = null,
  now = () => new Date(),
  readFileImpl = readFileSync,
  writeFileImpl = writeFileAtomic,
  logger = console,
} = {}) {
  const current = record || readReviewerBurstRecord(rootDir, { readFileImpl });
  const lease = current.lease;
  if (!lease || TERMINAL_LEASE_STATES.has(lease.state)) {
    return { record: current, expired: false, state: evaluateLeaseState(lease, { nowMs: Date.parse(nowIso(now)) }) };
  }
  const at = nowIso(now);
  const state = evaluateLeaseState(lease, { nowMs: Date.parse(at) });
  if (state.active) return { record: current, expired: false, state };
  endLease(current, lease, { state: 'expired', endedReason: state.endReason || 'ttl-elapsed', at });
  const event = appendEvent(current, {
    event: 'expired',
    at,
    leaseId: lease.leaseId,
    slots: lease.slots,
    repos: lease.repos,
    packs: lease.packs,
    expiresAt: lease.expiresAt,
    reason: state.endReason || 'ttl-elapsed',
    burstReviewsGranted: lease.usage?.burstReviewsGranted || 0,
    spendUsd: lease.usage?.spendUsd ?? null,
  });
  persistRecord(rootDir, current, { writeFileImpl, logger });
  logEvent(logger, event);
  return { record: current, expired: true, state };
}

/**
 * Request (or update) a burst lease.
 *
 * Duplicate requests while a lease is ACTIVE UPDATE THAT LEASE IN PLACE rather
 * than minting a new one, and the lease keeps its id and its usage ledger. That
 * is deliberate: if a re-request reset the spend counters, "request again just
 * before the budget trips" would be a free and undetectable way around the
 * budget guard.
 */
export function requestReviewerBurstLease({
  rootDir,
  slots = DEFAULT_BURST_SLOTS,
  ttlMs = DEFAULT_BURST_TTL_MS,
  repos = [],
  packs = [],
  budgetUsd = DEFAULT_BURST_BUDGET_USD,
  maxBurstReviews = null,
  reason = null,
  requestedBy = null,
  safety = null,
  env = process.env,
  now = () => new Date(),
  readFileImpl = readFileSync,
  writeFileImpl = writeFileAtomic,
  logger = console,
} = {}) {
  const at = nowIso(now);
  const limits = resolveBurstSystemLimits(env);
  const { record } = expireReviewerBurstLeaseIfDue(rootDir, {
    now: () => new Date(at),
    readFileImpl,
    writeFileImpl,
    logger,
  });
  const scopedRepos = normalizeList(repos, normalizeRepoScopeEntry);
  const scopedPacks = normalizeList(packs, normalizePackScopeEntry);
  const requestedSlots = Math.max(0, Math.trunc(Number(slots) || 0));
  const requestedTtlMs = Math.max(0, Math.trunc(Number(ttlMs) || 0));
  const ttl = Math.min(requestedTtlMs || DEFAULT_BURST_TTL_MS, limits.maxTtlMs);
  const budget = budgetUsd === null || budgetUsd === undefined
    ? null
    : Math.min(Math.max(0, Number(budgetUsd) || 0), limits.maxBudgetUsd);
  const existingState = evaluateLeaseState(record.lease, { nowMs: Date.parse(at) });
  const update = existingState.active === true;
  // An update RE-DECLARES scope rather than unioning it, so an operator always
  // states the whole blast radius. Reported back so the CLI can print the
  // before/after instead of silently widening a pack-scoped burst to repo-wide.
  const previousScope = update
    ? { repos: [...record.lease.repos], packs: [...record.lease.packs] }
    : { repos: [], packs: [] };
  const scopeChanged = update && (
    previousScope.repos.join('|') !== scopedRepos.join('|')
    || previousScope.packs.join('|') !== scopedPacks.join('|')
  );

  const requestedEvent = appendEvent(record, {
    event: 'requested',
    at,
    leaseId: update ? record.lease.leaseId : null,
    slots: requestedSlots,
    repos: scopedRepos,
    packs: scopedPacks,
    reason,
    requestedBy,
    ttlMs: ttl,
    budgetUsd: budget,
    update,
  });
  logEvent(logger, requestedEvent);

  const deny = (blockers, warnings = []) => {
    const denied = appendEvent(record, {
      event: 'denied',
      at,
      leaseId: update ? record.lease.leaseId : null,
      slots: 0,
      repos: scopedRepos,
      packs: scopedPacks,
      reason,
      blockers,
      warnings,
      update,
    });
    record.updatedAt = at;
    persistRecord(rootDir, record, { writeFileImpl, logger });
    logEvent(logger, denied);
    return { ok: false, state: 'denied', blockers, warnings, lease: record.lease, record, update };
  };

  // Scope is a HARD precondition, checked before safety: a repo-less burst is
  // the "hidden global concurrency knob" SPEC §5 forbids, and no amount of
  // pipeline health makes one acceptable.
  if (scopedRepos.length === 0) return deny(['scope-missing-repo']);
  if (!String(reason || '').trim()) return deny(['reason-required']);
  if (requestedSlots < 1) return deny(['slots-must-be-positive']);

  const verdict = evaluateBurstSafety({
    signals: safety,
    requestedSlots,
    maxSlots: limits.maxSlots,
  });
  if (!verdict.safe) return deny(verdict.blockers, verdict.warnings);

  const grantedSlots = verdict.allowedSlots;
  const reviewCap = Number.isFinite(Number(maxBurstReviews)) && Number(maxBurstReviews) > 0
    ? Math.trunc(Number(maxBurstReviews))
    : grantedSlots * DEFAULT_BURST_REVIEWS_PER_SLOT;
  const expiresAt = new Date(Date.parse(at) + ttl).toISOString();
  const lease = update
    ? {
        ...record.lease,
        state: 'active',
        reason: reason ? String(reason) : record.lease.reason,
        requestedBy: requestedBy ? String(requestedBy) : record.lease.requestedBy,
        requestedAt: at,
        expiresAt,
        ttlMs: ttl,
        requestedSlots,
        slots: grantedSlots,
        repos: scopedRepos,
        packs: scopedPacks,
        budgetUsd: budget,
        // The review cap rides with the current grant but never shrinks below
        // what has already been spent plus the new grant, so an update can
        // extend a burst without retroactively terminating it.
        maxBurstReviews: Math.max(
          reviewCap,
          Number(record.lease.usage?.burstReviewsGranted || 0) + grantedSlots,
        ),
        degraded: verdict.degraded,
        degradeReasons: verdict.warnings,
        safety: verdict.signals ? { warnings: verdict.warnings, evaluatedAt: at } : null,
        updates: Number(record.lease.updates || 0) + 1,
        endedAt: null,
        endedReason: null,
      }
    : {
        leaseId: makeLeaseId(at),
        state: 'active',
        reason: reason ? String(reason) : null,
        requestedBy: requestedBy ? String(requestedBy) : null,
        requestedAt: at,
        activatedAt: at,
        expiresAt,
        ttlMs: ttl,
        requestedSlots,
        slots: grantedSlots,
        repos: scopedRepos,
        packs: scopedPacks,
        budgetUsd: budget,
        maxBurstReviews: reviewCap,
        degraded: verdict.degraded,
        degradeReasons: verdict.warnings,
        safety: verdict.signals ? { warnings: verdict.warnings, evaluatedAt: at } : null,
        updates: 0,
        endedAt: null,
        endedReason: null,
        revokedBy: null,
        usage: emptyUsage(),
      };
  record.lease = normalizeLease(lease);
  record.updatedAt = at;
  const activated = appendEvent(record, {
    event: 'activated',
    at,
    leaseId: record.lease.leaseId,
    slots: record.lease.slots,
    requestedSlots,
    repos: scopedRepos,
    packs: scopedPacks,
    expiresAt,
    reason,
    warnings: verdict.warnings,
    degraded: verdict.degraded,
    maxBurstReviews: record.lease.maxBurstReviews,
    budgetUsd: budget,
    update,
  });
  if (!persistRecord(rootDir, record, { writeFileImpl, logger })) {
    return {
      ok: false,
      state: 'write-failed',
      blockers: ['lease-write-failed'],
      warnings: verdict.warnings,
      lease: null,
      record,
      update,
    };
  }
  logEvent(logger, activated);
  return {
    ok: true,
    state: 'active',
    lease: record.lease,
    record,
    update,
    previousScope,
    scopeChanged,
    degraded: verdict.degraded,
    warnings: verdict.warnings,
    blockers: [],
  };
}

/** Operator break-glass: end an active lease immediately. */
export function revokeReviewerBurstLease({
  rootDir,
  reason = 'operator-revoked',
  revokedBy = null,
  now = () => new Date(),
  readFileImpl = readFileSync,
  writeFileImpl = writeFileAtomic,
  logger = console,
} = {}) {
  const at = nowIso(now);
  const { record } = expireReviewerBurstLeaseIfDue(rootDir, {
    now: () => new Date(at),
    readFileImpl,
    writeFileImpl,
    logger,
  });
  const lease = record.lease;
  if (!lease || TERMINAL_LEASE_STATES.has(lease.state)) {
    return { ok: false, state: lease ? lease.state : 'inactive', reason: 'no-active-lease', record };
  }
  endLease(record, lease, { state: 'revoked', endedReason: String(reason || 'operator-revoked'), at, revokedBy });
  const event = appendEvent(record, {
    event: 'revoked',
    at,
    leaseId: lease.leaseId,
    slots: lease.slots,
    repos: lease.repos,
    packs: lease.packs,
    reason: String(reason || 'operator-revoked'),
    revokedBy,
    burstReviewsGranted: lease.usage?.burstReviewsGranted || 0,
    spendUsd: lease.usage?.spendUsd ?? null,
  });
  if (!persistRecord(rootDir, record, { writeFileImpl, logger })) {
    return { ok: false, state: 'write-failed', reason: 'lease-write-failed', record };
  }
  logEvent(logger, event);
  return { ok: true, state: 'revoked', lease, record };
}

// ── status surface ───────────────────────────────────────────────────────────

/**
 * The operator-facing burst status. Shaped to answer the SPEC §1 mockup
 * directly, and safe to call against a live deployed tree (pure reads).
 */
export function collectReviewerBurstStatus(rootDir, {
  now = () => new Date(),
  env = process.env,
  readFileImpl = readFileSync,
} = {}) {
  const at = nowIso(now);
  const record = readReviewerBurstRecord(rootDir, { readFileImpl });
  const state = evaluateLeaseState(record.lease, { nowMs: Date.parse(at) });
  const lease = record.lease;
  return {
    observedAt: at,
    leasePath: reviewerBurstLeasePath(rootDir),
    spendUnit: BURST_SPEND_UNIT,
    systemLimits: resolveBurstSystemLimits(env),
    // `state` is the LIVE state, derived from the clock — not the string last
    // written to disk. A lease whose TTL elapsed while nothing was running
    // reads as expired here even before the `expired` event is recorded.
    state: state.active ? 'active' : (lease ? state.state : 'inactive'),
    active: state.active,
    steadyAgySlots: STEADY_AGY_SLOTS,
    burstSlots: state.active ? lease.slots : 0,
    autoDecay: 'enabled',
    ttlRemainingMs: state.ttlRemainingMs,
    ttlRemaining: formatDurationMs(state.ttlRemainingMs),
    endReason: state.endReason,
    lease: lease
      ? {
          leaseId: lease.leaseId,
          reason: lease.reason,
          requestedBy: lease.requestedBy,
          requestedAt: lease.requestedAt,
          activatedAt: lease.activatedAt,
          expiresAt: lease.expiresAt,
          requestedSlots: lease.requestedSlots,
          slots: lease.slots,
          repos: lease.repos,
          packs: lease.packs,
          budgetUsd: lease.budgetUsd,
          maxBurstReviews: lease.maxBurstReviews,
          degraded: lease.degraded,
          degradeReasons: lease.degradeReasons,
          updates: lease.updates,
          state: lease.state,
          endedAt: lease.endedAt,
          endedReason: lease.endedReason,
          revokedBy: lease.revokedBy,
          usage: lease.usage,
        }
      : null,
    events: record.events.slice(-10),
    history: record.history.slice(-MAX_RETAINED_HISTORY),
  };
}

export function renderReviewerBurstStatus(status) {
  const lease = status.lease;
  const lines = [
    `state: ${status.state}`,
    `reason: ${lease?.reason || '-'}`,
    `ttl_remaining: ${status.ttlRemaining || '-'}`,
    `steady_agy_slots: ${status.steadyAgySlots}`,
    `burst_slots: ${status.burstSlots}`,
    `repo_scope: ${lease?.repos?.length ? lease.repos.join(', ') : '-'}`,
    `pack_scope: ${lease?.packs?.length ? lease.packs.join(', ') : '(whole repo scope)'}`,
    `fallback_allowed: entitled + quota-available review fallback classes only, and only when the AGY slot is saturated`,
    `token_budget: ${lease?.budgetUsd === null || lease?.budgetUsd === undefined ? '-' : `$${lease.budgetUsd}`} equivalent`,
    `burst_reviews: ${lease?.usage?.burstReviewsGranted ?? 0}/${lease?.maxBurstReviews ?? 0}`,
    `observed_spend: ${lease?.usage?.spendReadable ? `$${Number(lease.usage.spendUsd).toFixed(2)}` : 'unreadable (review-count cap still applies)'}`,
    `auto_decay: ${status.autoDecay}`,
  ];
  if (lease?.degraded) lines.push(`degraded: ${lease.degradeReasons.join(', ') || 'yes'}`);
  if (!status.active && status.endReason) lines.push(`end_reason: ${status.endReason}`);
  lines.push(`lease_record: ${status.leasePath}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Compact projection for the review-pipeline health snapshot. Kept tiny and
 * allocation-cheap because the health collector runs on a schedule.
 */
export function summarizeReviewerBurst(rootDir, {
  nowMs = Date.now(),
  readFileImpl = readFileSync,
} = {}) {
  const record = readReviewerBurstRecord(rootDir, { readFileImpl });
  const state = evaluateLeaseState(record.lease, { nowMs });
  const lease = record.lease;
  return {
    active: state.active,
    state: state.active ? 'active' : (lease ? state.state : 'inactive'),
    leaseId: lease?.leaseId || null,
    reason: lease?.reason || null,
    requestedBy: lease?.requestedBy || null,
    slots: state.active ? lease.slots : 0,
    steadyAgySlots: STEADY_AGY_SLOTS,
    repos: lease?.repos || [],
    packs: lease?.packs || [],
    expiresAt: lease?.expiresAt || null,
    ttlRemainingMs: state.ttlRemainingMs,
    budgetUsd: lease?.budgetUsd ?? null,
    maxBurstReviews: lease?.maxBurstReviews ?? 0,
    burstReviewsGranted: lease?.usage?.burstReviewsGranted || 0,
    spendUsd: lease?.usage?.spendUsd ?? null,
    spendReadable: lease?.usage?.spendReadable === true,
    degraded: lease?.degraded === true,
    degradeReasons: lease?.degradeReasons || [],
    endReason: state.endReason,
    lastEvent: record.events.length ? record.events[record.events.length - 1] : null,
  };
}

// ── per-tick controller ──────────────────────────────────────────────────────

/**
 * Per-watcher-tick burst controller, created once at the composition root and
 * threaded through ctx — the same shape as the RSP-01 spillover controller it
 * sits beside, so the two levers read the same way at the call site.
 *
 * Every method is fail-safe toward NOT bursting: any error, any unreadable
 * record, any out-of-scope subject leaves the pipeline on its steady-state
 * AGY-first path.
 */
export function createReviewerBurstController({
  rootDir,
  logger = console,
  now = () => new Date(),
  readFileImpl = readFileSync,
  writeFileImpl = writeFileAtomic,
  // Injected at the composition root: reads observed reviewer spend in
  // BURST_SPEND_UNIT for the active lease. Absent/throwing => the dollar limb
  // of the budget guard is reported unreadable and the review-count cap carries
  // the guarantee on its own.
  readSpendUsd = null,
} = {}) {
  let evaluated = null;
  let record = null;

  function evaluate() {
    if (evaluated) return evaluated;
    const at = nowIso(now);
    const nowMs = Date.parse(at);
    try {
      const settled = expireReviewerBurstLeaseIfDue(rootDir, {
        now: () => new Date(at),
        readFileImpl,
        writeFileImpl,
        logger,
      });
      record = settled.record;
      let state = settled.state;
      if (state.active && typeof readSpendUsd === 'function') {
        // Refresh the observed-spend limb once per tick, then re-derive: a
        // lease that has burned its dollars must stop THIS tick, not after the
        // TTL runs out.
        const lease = record.lease;
        let spend = null;
        try {
          const value = Number(readSpendUsd({ lease }));
          spend = Number.isFinite(value) && value >= 0 ? value : null;
        } catch (err) {
          logger?.warn?.(
            `[reviewer-burst-lease] observed-spend read failed; review-count cap still applies: ${err?.message || err}`
          );
          spend = null;
        }
        lease.usage.spendUsd = spend;
        lease.usage.spendReadable = spend !== null;
        lease.usage.spendObservedAt = at;
        state = evaluateLeaseState(lease, { nowMs });
        if (!state.active) {
          const expiry = expireReviewerBurstLeaseIfDue(rootDir, {
            record,
            now: () => new Date(at),
            readFileImpl,
            writeFileImpl,
            logger,
          });
          record = expiry.record;
          state = expiry.state;
        } else {
          if (!persistRecord(rootDir, record, { writeFileImpl, logger })) {
            throw new Error('lease-write-failed');
          }
        }
      }
      evaluated = { at, nowMs, state, lease: state.active ? record.lease : null };
    } catch (err) {
      logger?.warn?.(
        `[reviewer-burst-lease] lease evaluation failed; staying on steady-state capacity: ${err?.message || err}`
      );
      evaluated = { at, nowMs, state: { active: false, state: 'inactive', ttlRemainingMs: null, endReason: null }, lease: null };
    }
    return evaluated;
  }

  return {
    /** Live lease (null when no burst is active). */
    lease() {
      return evaluate().lease;
    },
    /** Additional first-pass pool slots this lease grants; 0 when inactive. */
    slots() {
      const current = evaluate();
      return current.lease ? Math.max(0, Number(current.lease.slots) || 0) : 0;
    },
    /** Operator status projection for this tick. */
    status() {
      const current = evaluate();
      return {
        active: Boolean(current.lease),
        state: current.state.state,
        leaseId: current.lease?.leaseId || null,
        slots: current.lease?.slots || 0,
        ttlRemainingMs: current.state.ttlRemainingMs,
      };
    },
    /**
     * Snapshot handed to `resolveReviewerWorkerClassWithFallback`, mirroring
     * RSP-01's `depthPressure()`. `engaged: false` whenever there is no lease,
     * the subject is out of scope, or the budget is spent — in all of which the
     * resolver takes its pre-RPL-07 path unchanged.
     */
    pressure({ repo = null, packTokens = null } = {}) {
      const current = evaluate();
      const lease = current.lease;
      if (!lease) return { engaged: false, reason: 'no-active-lease' };
      const normalizedRepo = normalizeRepoScopeEntry(repo);
      if (!normalizedRepo || !lease.repos.includes(normalizedRepo)) {
        return { engaged: false, reason: 'repo-out-of-scope', leaseId: lease.leaseId };
      }
      if (lease.packs.length > 0) {
        // `packTokens` may be a thunk. Deriving a subject's pack tokens means
        // scanning its title and branch, and the overwhelmingly common case is
        // NO LEASE AT ALL — so the call site hands us a function and we only
        // call it on the rare path that actually needs the answer.
        const resolved = typeof packTokens === 'function' ? packTokens() : packTokens;
        const tokens = resolved instanceof Set
          ? resolved
          : new Set(Array.isArray(resolved) ? resolved.map(normalizePackScopeEntry) : []);
        if (!lease.packs.some((pack) => tokens.has(pack))) {
          return { engaged: false, reason: 'pack-out-of-scope', leaseId: lease.leaseId };
        }
      }
      const granted = Number(lease.usage?.burstReviewsGranted || 0);
      const remainingReviews = lease.maxBurstReviews > 0
        ? Math.max(0, lease.maxBurstReviews - granted)
        : Number.POSITIVE_INFINITY;
      if (remainingReviews <= 0) {
        return { engaged: false, reason: 'review-cap-reached', leaseId: lease.leaseId };
      }
      return {
        engaged: true,
        reason: 'burst-lease-active',
        leaseId: lease.leaseId,
        slots: lease.slots,
        packs: lease.packs,
        repos: lease.repos,
        ttlRemainingMs: current.state.ttlRemainingMs,
        remainingReviews: Number.isFinite(remainingReviews) ? remainingReviews : null,
      };
    },
    /**
     * Charge the lease for a burst-bought review. Call ONLY once a burst-driven
     * fallback has actually been applied to a route — the operator is owed the
     * number of non-primary reviews the lease BOUGHT, not the number it
     * attempted.
     */
    recordBurstAdmission({ repo = null, prNumber = null, fromWorkerClass = null, toWorkerClass = null } = {}) {
      const current = evaluate();
      const lease = current.lease;
      if (!lease) return false;
      const granted = Number(lease.usage?.burstReviewsGranted || 0);
      if (lease.maxBurstReviews > 0 && granted >= lease.maxBurstReviews) return false;
      const to = normalizePackScopeEntry(toWorkerClass) || 'unknown';
      const repoKey = normalizeRepoScopeEntry(repo) || 'unknown';
      lease.usage.burstReviewsGranted = granted + 1;
      lease.usage.byRepo[repoKey] = Number(lease.usage.byRepo[repoKey] || 0) + 1;
      lease.usage.byWorkerClass[to] = Number(lease.usage.byWorkerClass[to] || 0) + 1;
      record.updatedAt = current.at;
      if (!persistRecord(rootDir, record, { writeFileImpl, logger })) {
        logger?.error?.(
          `[reviewer-burst-lease] CRITICAL: burst admission cannot be charged; refusing unaccounted review repo=${repo} pr=${prNumber}`
        );
        throw new Error('lease-write-failed: burst admission was not recorded');
      }
      logger?.warn?.(
        `[reviewer-burst-lease] burst-admission lease_id=${lease.leaseId} repo=${repo} pr=${prNumber} `
        + `from=${fromWorkerClass} to=${to} `
        + `burst_reviews_granted=${lease.usage.burstReviewsGranted}/${lease.maxBurstReviews} `
        + `slots=${lease.slots}`
      );
      return true;
    },
  };
}
