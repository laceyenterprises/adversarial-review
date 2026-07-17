// Local-runtime admission layer (v2 app architecture §6.1).
//
// The `os-dispatch` runtime inherits admission, entitlements, model
// allowlists, sandboxing, and token budgets from the worker pool. The `local`
// runtime spawns a native harness CLI directly and so bypasses ALL of that —
// which is exactly why it "keeps its own conservative admission layer". This
// module composes the three existing gates the fleet already trusts:
//
//   1. per-run token/time cap  — a hard, deterministic ceiling on what one
//      local run may request, since nothing else bounds a direct spawn.
//   2. quota-exhaustion hold   — reuses `quotaHoldDecision` so a provider hard
//      usage cap that has not yet reset refuses admission instead of hammering
//      the cap (the dispatch lane's HRR never sees a direct spawn).
//   3. memory-pressure gate    — reuses `checkReviewerMemoryAdmission` so a
//      host already under critical memory pressure does not get another
//      multi-hundred-MB reviewer stacked on top.
//
// Gates run cheapest-first: the deterministic budget cap, then the pure quota
// decision, then the OS-sampling memory probe. The first refusal short-circuits
// so a refused run never pays for the probes behind it.

import { checkReviewerMemoryAdmission } from '../../../watcher-memory-pressure.mjs';
import { DEFAULT_QUOTA_BACKOFF_MS, quotaHoldDecision } from '../../../quota-exhaustion.mjs';

// Conservative per-run ceiling for a direct local spawn. Tunable by the caller
// (domain config / operator) but never silently exceeded.
const DEFAULT_LOCAL_RUN_CAP = Object.freeze({
  maxTokens: 2_000_000,
  maxWallMs: 30 * 60 * 1000,
});

function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Layer 1: per-run token/time cap.
function evaluateBudgetCap(budget = {}, cap = DEFAULT_LOCAL_RUN_CAP) {
  const suppliedTokens = toFiniteNumber(budget?.maxTokens);
  const capTokens = toFiniteNumber(cap?.maxTokens);
  if (suppliedTokens !== null && capTokens !== null && suppliedTokens > capTokens) {
    return {
      admit: false,
      reason: 'budget_token_cap_exceeded',
      layer: 'budget',
      requestedTokens: suppliedTokens,
      capTokens,
    };
  }
  const suppliedWallMs = toFiniteNumber(budget?.maxWallMs);
  const capWallMs = toFiniteNumber(cap?.maxWallMs);
  if (suppliedWallMs !== null && capWallMs !== null && suppliedWallMs > capWallMs) {
    return {
      admit: false,
      reason: 'budget_time_cap_exceeded',
      layer: 'budget',
      requestedWallMs: suppliedWallMs,
      capWallMs,
    };
  }
  return {
    admit: true,
    reason: null,
    layer: 'budget',
    requestedTokens: suppliedTokens ?? capTokens,
    capTokens,
    requestedWallMs: suppliedWallMs ?? capWallMs,
    capWallMs,
  };
}

// Layer 2: quota-exhaustion hold. `quotaState` is a reviewed_prs-shaped row
// (or null when the caller has no recent quota failure to weigh). A hold means
// the provider's cap window has not elapsed, so admission is refused.
function evaluateQuotaHold(quotaState, { nowMs, fallbackBackoffMs } = {}) {
  if (!quotaState) return { admit: true, reason: null, layer: 'quota', quota: null };
  const decision = quotaHoldDecision(quotaState, { nowMs, fallbackBackoffMs });
  if (decision.hold) {
    return {
      admit: false,
      reason: 'quota_exhausted_hold',
      layer: 'quota',
      quota: decision,
      waitUntilMs: decision.waitUntilMs,
      source: decision.source,
    };
  }
  return { admit: true, reason: null, layer: 'quota', quota: decision };
}

// Compose all three gates. Returns a decision `{ admit, reason, layer, ... }`.
// A refusal always carries a stable `reason` slug and the `layer` that refused.
async function evaluateLocalAdmission({
  reviewerModel,
  budget = {},
  cap = DEFAULT_LOCAL_RUN_CAP,
  // Memory gate: pass a pre-computed `memoryAdmission` decision to skip the
  // OS probe (tests, or a caller that already sampled), or let it probe.
  memoryAdmission = null,
  checkMemoryImpl = checkReviewerMemoryAdmission,
  memoryPressureConfig = {},
  reservedMb = 0,
  execFileImpl,
  platform,
  // Quota gate.
  quotaState = null,
  nowMs = Date.now(),
  fallbackBackoffMs = DEFAULT_QUOTA_BACKOFF_MS,
  logger = console,
  // Pass a pre-read memory-pressure `sample` (parsed vm_stat/swapusage) through
  // to the probe. `undefined` means "let the probe sample the OS"; any other
  // value (including null) is forwarded so tests can inject a critical sample.
  sample = undefined,
} = {}) {
  const budgetDecision = evaluateBudgetCap(budget, cap);
  if (!budgetDecision.admit) return budgetDecision;

  const quotaDecision = evaluateQuotaHold(quotaState, { nowMs, fallbackBackoffMs });
  if (!quotaDecision.admit) return quotaDecision;

  const memory = memoryAdmission ?? await checkMemoryImpl({
    reviewerModel,
    reservedMb,
    memoryPressureConfig,
    execFileImpl,
    platform,
    logger,
    ...(sample === undefined ? {} : { sample }),
  });
  if (memory && memory.admit === false) {
    return {
      admit: false,
      reason: memory.reason || 'memory_pressure',
      layer: 'memory',
      memory,
    };
  }

  return {
    admit: true,
    reason: null,
    layer: null,
    budget: budgetDecision,
    quota: quotaDecision,
    memory,
  };
}

export {
  DEFAULT_LOCAL_RUN_CAP,
  evaluateBudgetCap,
  evaluateLocalAdmission,
  evaluateQuotaHold,
};
