import { classifyReviewerFailure } from './adapters/reviewer-runtime/cli-direct/classification.mjs';
import { parseReviewerQuotaExhaustion } from './reviewer-quota-signal.mjs';
import { resolveQuotaResetIso } from './quota-exhaustion.mjs';

// Classify the complete diagnostic before the stored message is bounded.
export function argusReviewerFailure(error, { nowMs = Date.now() } = {}) {
  const diagnostic = [error?.message || String(error), error?.stderr].filter(Boolean).join('\n');
  const failureClass = classifyReviewerFailure(diagnostic, error?.exitCode ?? null, error?.code, error);
  const signal = failureClass === 'quota-exhausted'
    ? parseReviewerQuotaExhaustion({ error, nowMs }) : null;
  return {
    error: String(error?.message || error).slice(0, 500),
    failureClass,
    resetAt: signal?.resetAt || (signal ? resolveQuotaResetIso(diagnostic, { nowMs }) : null)
      || (failureClass === 'agy-identity-unavailable' ? error?.resetAt : null) || null,
  };
}

export function argusFailureDefers(failure) {
  return ['quota-exhausted', 'agy-identity-unavailable'].includes(failure?.failureClass);
}

export function argusReviewerDeferral({ failures = [], resetAt = null, nowMs = Date.now() } = {}) {
  const resets = [resetAt, ...failures.map((failure) => failure.resetAt)]
    .map((reset) => Date.parse(reset)).filter((reset) => Number.isFinite(reset) && reset > nowMs);
  return {
    kind: 'defer',
    reason: 'no-reviewer-model-available',
    retryAfterMs: resets.length ? Math.min(...resets) - nowMs : 15 * 60 * 1000,
    modelAttempts: failures,
  };
}
