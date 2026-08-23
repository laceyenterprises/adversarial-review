// Single source of truth for the convergence budget: how many remediation
// rounds a subject gets, and every downstream bound that MUST move with it.
//
// Why this module exists (2026-08-22): the remediation round budget was
// duplicated verbatim in `follow-up-jobs.mjs` (`ROUND_BUDGET_BY_RISK_CLASS`)
// and `kernel/pipeline.mjs` (`DEFAULT_ROUND_BUDGET_BY_RISK`), and three further
// convergence bounds were pinned as independent literals whose comments
// *described* a derivation and then hardcoded the result:
//
//   AMA_RETAIN_LOOP_CAP = 3                       // == the medium budget
//   HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES = 6 // "set above the per-series cap"
//   DEFAULT_REMEDIATION_CEILING_CAP = 8            // "admits two critical stages (4 + 4)"
//
// That meant raising `medium` from 2 to 3 changed how many remediation rounds
// ran but left the AMA retain cap, the hammer lifetime ceiling, and the
// subject ceiling pinned to the old policy — the pipeline stopped agreeing with
// itself. Live evidence at the time: 64 jobs stopped `max-rounds-reached`, and
// 8 of those recorded a self-contradictory `round=3/5` / `round=4/6` state whose
// stop reason still quoted the superseded cap ("Reached max remediation rounds
// (2/2)").
//
// Every bound below is now a named function of the round budget, so an operator
// moves ONE number (per risk class, via domain `riskClasses.<risk>.maxRemediationRounds`)
// and the whole pipeline follows. The defaults here reproduce the previously
// hardcoded values exactly, so adopting this module is behavior-neutral until
// the knob is actually moved.
//
// This module is a leaf: it imports nothing, so both the kernel and the v1
// follow-up path can depend on it without a cycle.

/** @typedef {'low'|'medium'|'high'|'critical'} RiskClass */

export const RISK_CLASSES = Object.freeze(['low', 'medium', 'high', 'critical']);

export const DEFAULT_RISK_CLASS = 'medium';

// Higher-risk subjects get more remediation rounds before operator escalation.
// This is the ONE table. Do not mirror it; import it.
export const DEFAULT_ROUND_BUDGET_BY_RISK = Object.freeze({
  low: 1,
  medium: 3,
  high: 3,
  critical: 4,
});

// One retry: initial hammer + 1 re-dispatch. Expressed as a total number of
// hammer dispatches allowed for a logical PR before per-series suppression.
// This is convergence policy, so it is owned here alongside the budget it must
// stay consistent with.
export const HAMMER_SERIES_RETRIES = 1;
export const HAMMER_SERIES_TOTAL_DISPATCHES = HAMMER_SERIES_RETRIES + 1;

// The hammer lifetime ceiling must sit strictly above the per-series cap so a
// legitimate review-then-remediate cycle still has room before it trips, while
// staying bounded when a PR cannot reach green CI. One full budget of retries
// on top of one full budget of rounds.
const HAMMER_LIFETIME_BUDGET_MULTIPLE = 2;

// The subject-level ceiling admits two full-budget stages before escalation.
const REMEDIATION_CEILING_BUDGET_MULTIPLE = 2;

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * Coerce an arbitrary round-budget input to a positive integer, falling back to
 * the medium default. Shared by every derivation so a malformed budget can
 * never silently produce a zero or negative bound.
 *
 * @param {unknown} maxRounds
 * @param {number} [fallback]
 * @returns {number}
 */
export function normalizeRoundBudget(
  maxRounds,
  fallback = DEFAULT_ROUND_BUDGET_BY_RISK[DEFAULT_RISK_CLASS],
) {
  const parsed = Number(maxRounds);
  if (isPositiveInt(parsed)) return parsed;
  return isPositiveInt(fallback) ? fallback : DEFAULT_ROUND_BUDGET_BY_RISK[DEFAULT_RISK_CLASS];
}

/**
 * How many consecutive `not-eligible` AMA retains on the SAME head are tolerated
 * before routing to AWAIT_OPERATOR_ACTION. A PR that cannot self-resolve within
 * its own remediation budget will not resolve with more retains on a frozen
 * head, so this tracks the budget exactly.
 *
 * @param {unknown} maxRounds
 * @returns {number}
 */
export function amaRetainLoopCapFor(maxRounds) {
  return normalizeRoundBudget(maxRounds);
}

/**
 * Lifetime ceiling on total hammer dispatches for a logical PR, across all
 * series and immune to the fresh-review (jobKey) reset.
 *
 * @param {unknown} maxRounds
 * @returns {number}
 */
export function hammerLifetimeDispatchesFor(maxRounds) {
  const derived = normalizeRoundBudget(maxRounds) * HAMMER_LIFETIME_BUDGET_MULTIPLE;
  // Floored strictly above the per-series cap. Without this, a low-risk budget
  // of 1 derives a lifetime of 2 — exactly the per-series cap — which collapses
  // the headroom the lifetime ceiling exists to provide and would suppress the
  // hammer at the same point the series cap already does. The previously
  // hardcoded 6 hid this because it could not track the budget down.
  return Math.max(derived, HAMMER_SERIES_TOTAL_DISPATCHES + 1);
}

/**
 * Subject-level remediation ceiling: the cap on summed per-stage budgets so a
 * many-stage pipeline cannot multiply hammer cycles without bound. Derived from
 * the LARGEST per-risk budget, because the ceiling has to admit the most
 * expensive stage pairing the operator has declared.
 *
 * @param {Record<string, number>} [budgetByRisk]
 * @returns {number}
 */
export function remediationCeilingCapFor(budgetByRisk = DEFAULT_ROUND_BUDGET_BY_RISK) {
  const values = RISK_CLASSES.map(
    (risk) => convergenceBudgetForRiskClass(risk, budgetByRisk).remediationRounds,
  );
  const widest = Math.max(...values);
  return widest * REMEDIATION_CEILING_BUDGET_MULTIPLE;
}

/**
 * Every convergence bound implied by one round budget, as a single frozen
 * object. Use this when a call site needs more than one bound so the values
 * cannot drift apart at the point of use.
 *
 * @param {unknown} maxRounds
 * @returns {Readonly<{remediationRounds:number, amaRetainLoopCap:number, hammerLifetimeDispatches:number}>}
 */
export function convergenceBudget(maxRounds) {
  const rounds = normalizeRoundBudget(maxRounds);
  return Object.freeze({
    remediationRounds: rounds,
    amaRetainLoopCap: amaRetainLoopCapFor(rounds),
    hammerLifetimeDispatches: hammerLifetimeDispatchesFor(rounds),
  });
}

/**
 * Normalize an arbitrary risk-class input to a known class.
 *
 * @param {unknown} riskClass
 * @param {RiskClass} [fallback]
 * @returns {RiskClass}
 */
export function normalizeRiskClassName(riskClass, fallback = DEFAULT_RISK_CLASS) {
  const normalized = String(riskClass ?? '').trim().toLowerCase();
  return RISK_CLASSES.includes(normalized) ? normalized : fallback;
}

/**
 * The convergence budget for a risk class under a (possibly operator-declared)
 * budget table.
 *
 * @param {unknown} riskClass
 * @param {Record<string, number>} [budgetByRisk]
 */
export function convergenceBudgetForRiskClass(
  riskClass,
  budgetByRisk = DEFAULT_ROUND_BUDGET_BY_RISK,
) {
  const risk = normalizeRiskClassName(riskClass);
  const declared = budgetByRisk?.[risk];
  return convergenceBudget(
    isPositiveInt(Number(declared))
      ? Number(declared)
      : DEFAULT_ROUND_BUDGET_BY_RISK[risk],
  );
}
