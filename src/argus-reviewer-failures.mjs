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
    resetAt: resets.length ? new Date(Math.min(...resets)).toISOString() : null,
    modelAttempts: failures,
  };
}

function quotaOnlyError(error) {
  const text = String(error || '').replace(/^argus review failed after \d+ attempt\(s\): /u, '');
  // Legacy jobs retained only lastError and the terminal error. Separate each
  // model's recorded failure: one quota marker must not hide a real failure.
  const prefix = 'no reviewer model produced a review: ';
  const errors = text.startsWith(prefix) ? text.slice(prefix.length).split(' | ') : [text];
  return errors.length > 0 && errors.every((message) => message
    && classifyReviewerFailure(message, null) === 'quota-exhausted');
}

export function isQuotaOnlyArgusFailure(job) {
  if (job?.status !== 'failed' || job?.drain?.quotaFailureRequeuedAt) return false;
  const history = job?.drain?.attemptHistory;
  if (Array.isArray(history)) {
    if (!history.length || history.length !== job.drain.attempts) return false;
    if (!history.every((attempt) => Array.isArray(attempt.modelAttempts) && attempt.modelAttempts.length
      ? attempt.modelAttempts.every((failure) => failure.failureClass === 'quota-exhausted')
      : quotaOnlyError(attempt.error))) return false;
  }
  const recordedErrors = [job?.drain?.lastError, job?.error].filter(Boolean);
  return recordedErrors.length > 0 && recordedErrors.every(quotaOnlyError);
}
