// OVERLOADDEFER-01 wire adapter for agent_os_core.overload_deferral (v1).
import { getConfig } from './config-loader.mjs';

// Keep the independent/offline review runtime free of Python subprocesses.
export const OVERLOAD_DEFERRED = 'overload-deferred';
export const MAX_OVERLOAD_DEFERRALS = 5;

function minimumOverloadMultiplier() {
  try {
    const value = Number(getConfig('worker_pool.overload_deferral.minimum_multiplier', 2));
    if (Number.isFinite(value) && value >= 2 && value <= 20) return value;
  } catch { /* Rolling config/read failures retain the documented default. */ }
  return 2;
}

export function isLoadTimeout({ timedOut, deadlineSeconds, scaledBudgetSeconds, loadMultiplier = 1 }) {
  return timedOut === true
    && [deadlineSeconds, scaledBudgetSeconds, loadMultiplier].every(value => Number.isFinite(value) && value > 0)
    && loadMultiplier >= minimumOverloadMultiplier();
}

export function deferOverload(owner, evidence, previous, nowSeconds) {
  if (!owner || !isLoadTimeout({ timedOut: true, deadlineSeconds: evidence.deadline_seconds,
    scaledBudgetSeconds: evidence.scaled_budget_seconds, loadMultiplier: evidence.load_multiplier })
    || (previous && previous.owner !== owner)) throw new TypeError('invalid overload deferral');
  const count = Math.min(MAX_OVERLOAD_DEFERRALS, (previous?.deferralCount || 0) + 1);
  const exhausted = count >= MAX_OVERLOAD_DEFERRALS;
  return { schemaVersion: 1, outcome: OVERLOAD_DEFERRED, owner, deferralCount: count,
    maxDeferrals: MAX_OVERLOAD_DEFERRALS, evidence,
    nextRetryAt: exhausted ? null : nowSeconds + Math.min(600, 30 * 2 ** (count - 1)),
    overloadAlert: exhausted, alertKey: 'host-overload' };
}
