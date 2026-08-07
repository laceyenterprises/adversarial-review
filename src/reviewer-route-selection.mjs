import { QUOTA_EXHAUSTED_FAILURE_CLASS, quotaHoldDecision } from './quota-exhaustion.mjs';
import { infraRecoverableFailureClass, reviewPopulationFailureClass } from './reviewer-failure-classification.mjs';
import { resolveGeminiReviewerModeWithSource } from './role-config.mjs';
import { readCascadeState } from './reviewer-cascade.mjs';
import { isCrossModelReviewWaived } from './adapters/subject/github-pr/routing.mjs';
import {
  afhReviewerFallbackDecision,
  applyAfhReviewerFallbackDecision,
  reviewerModelGrounding,
} from './afh-reviewer-fallback.mjs';

// Quota-exhausted fallback backoff, replicated verbatim from watcher.mjs (its
// copy stays for the other watcher call sites); a module-load env read, so both
// resolve identically.
const DEFAULT_QUOTA_EXHAUSTED_BACKOFF_MS = 15 * 60 * 1000;
function resolveQuotaExhaustedBackoffMs(env = process.env) {
  const raw = env.ADVERSARIAL_QUOTA_EXHAUSTED_FALLBACK_BACKOFF_MS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_QUOTA_EXHAUSTED_BACKOFF_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_QUOTA_EXHAUSTED_BACKOFF_MS;
  return Math.floor(parsed);
}
const QUOTA_EXHAUSTED_BACKOFF_MS = resolveQuotaExhaustedBackoffMs();

// Review-population retry config, replicated verbatim from watcher.mjs (its copy
// stays for the other watcher call sites).
const DEFAULT_REVIEW_POPULATION_RETRY_CONFIG = Object.freeze({
  maxAttempts: 1,
  backoffSeconds: 45,
});
function normalizeReviewPopulationRetryConfig(config = {}) {
  const maxAttempts = Number(config.maxAttempts);
  const backoffSeconds = Number(config.backoffSeconds);
  return {
    maxAttempts: Number.isInteger(maxAttempts) && maxAttempts >= 0
      ? maxAttempts
      : DEFAULT_REVIEW_POPULATION_RETRY_CONFIG.maxAttempts,
    backoffSeconds: Number.isFinite(backoffSeconds) && backoffSeconds >= 0
      ? Math.floor(backoffSeconds)
      : DEFAULT_REVIEW_POPULATION_RETRY_CONFIG.backoffSeconds,
  };
}

const REVIEWER_TIMEOUT_FALLBACK_ROUTE_BY_MODEL = {
  claude: {
    reviewerModel: 'claude',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
  },
  codex: {
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  },
  gemini: {
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
  },
};

const DEFAULT_STALE_REVIEWER_RECONCILE_PER_POLL = 3;
const DEFAULT_REVIEWER_TIMEOUT_FALLBACK_THRESHOLD = 2;

export function resolveReviewerTimeoutFallbackThreshold(env = process.env) {
  const raw = env.ADVERSARIAL_REVIEW_TIMEOUT_FALLBACK_THRESHOLD;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_REVIEWER_TIMEOUT_FALLBACK_THRESHOLD;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_REVIEWER_TIMEOUT_FALLBACK_THRESHOLD;
  return parsed;
}

function resolveReviewerTimeoutFallbackModel(env = process.env) {
  const raw = String(env.ADVERSARIAL_REVIEW_TIMEOUT_FALLBACK_MODEL || 'off').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'none') return null;
  if (raw === 'claude' || raw === 'codex' || raw === 'gemini') return raw;
  return null;
}

function normalizeReviewerAttribution(value) {
  return String(value || '').trim().toLowerCase();
}

function rowReviewerMatches(row, expectedReviewerModel) {
  const expected = normalizeReviewerAttribution(expectedReviewerModel);
  if (!expected) return true;
  const candidates = [
    row?.reviewer,
    row?.reviewer_model,
    row?.reviewerModel,
    row?.reviewer_class,
  ].map(normalizeReviewerAttribution).filter(Boolean);
  return candidates.some((candidate) => candidate === expected);
}

// GMW-02 fallback signal. `reviewer.gemini.mode=fallback` selects gemini only
// when the assigned primary reviewer is quota-capped. We reuse the HRR
// quota-exhaustion signal, but only when the failed row is attributed to the
// primary reviewer Gemini would replace. If Gemini already handled a retry and
// then hit quota, the row must remain on the normal quota hold instead of
// recursively selecting Gemini again.
export function primaryReviewerQuotaCappedForRow(row, { nowMs = null, expectedReviewerModel = null } = {}) {
  if (!row || row.review_status !== 'failed') return false;
  if (!rowReviewerMatches(row, expectedReviewerModel)) return false;
  if (infraRecoverableFailureClass(row) !== QUOTA_EXHAUSTED_FAILURE_CLASS) return false;
  return quotaHoldDecision(row, {
    nowMs,
    fallbackBackoffMs: QUOTA_EXHAUSTED_BACKOFF_MS,
  }).hold;
}

export function shouldBypassPrimaryReviewerQuotaHold(route, row = null) {
  if (row && !rowReviewerMatches(row, route?.geminiReviewerSelection?.replacedReviewerModel)) {
    return false;
  }
  const reason = route?.geminiReviewerSelection?.reason;
  return (
    route?.reviewerModel === 'gemini'
    && route?.botTokenEnv === 'GH_GEMINI_REVIEWER_TOKEN'
    && (
      (
        route?.geminiReviewerSelection?.mode === 'fallback'
        && reason === 'primary-reviewer-quota-capped'
      )
      || (
        route?.geminiReviewerSelection?.mode === 'always-on'
        && reason === 'always-on-third-reviewer'
      )
    )
  );
}

export function reviewPopulationRetryDecision(row, {
  config = DEFAULT_REVIEW_POPULATION_RETRY_CONFIG,
  headSha = null,
  nowMs = Date.now(),
} = {}) {
  const failureClass = reviewPopulationFailureClass(row);
  if (!row || row.review_status !== 'failed' || !failureClass) {
    return { matched: false, retryable: false, action: 'not-population-failure', failureClass: null };
  }
  const normalized = normalizeReviewPopulationRetryConfig(config);
  const storedHead = row.review_population_retry_head_sha || null;
  const sameHead = String(storedHead || '') === String(headSha || '');
  const attempts = sameHead ? Number(row.review_population_retry_attempts || 0) : 0;
  if (normalized.maxAttempts <= 0) {
    return {
      matched: true,
      retryable: false,
      action: 'exhausted',
      failureClass,
      attempts,
      maxAttempts: normalized.maxAttempts,
      backoffSeconds: normalized.backoffSeconds,
    };
  }
  if (attempts >= normalized.maxAttempts) {
    return {
      matched: true,
      retryable: false,
      action: 'exhausted',
      failureClass,
      attempts,
      maxAttempts: normalized.maxAttempts,
      backoffSeconds: normalized.backoffSeconds,
    };
  }
  const backoffMs = normalized.backoffSeconds * 1000;
  const anchorMs = Date.parse(row.failed_at || row.last_attempted_at || '');
  const waitUntilMs = Number.isFinite(anchorMs) ? anchorMs + backoffMs : nowMs;
  if (backoffMs > 0 && waitUntilMs > nowMs) {
    return {
      matched: true,
      retryable: false,
      action: 'wait',
      failureClass,
      attempts,
      maxAttempts: normalized.maxAttempts,
      backoffSeconds: normalized.backoffSeconds,
      waitUntilMs,
    };
  }
  return {
    matched: true,
    retryable: true,
    action: 'retry',
    failureClass,
    attempts,
    maxAttempts: normalized.maxAttempts,
    backoffSeconds: normalized.backoffSeconds,
  };
}

export function resolveGeminiReviewerModeForWatcher({
  env = process.env,
  resolver = resolveGeminiReviewerModeWithSource,
} = {}) {
  try {
    const resolved = resolver({ env });
    if (typeof resolved === 'string') {
      return {
        mode: resolved,
        error: null,
        source: 'unknown',
        sourceDetail: null,
        rawValue: resolved,
        topPath: null,
      };
    }
    return { ...resolved, error: null };
  } catch (err) {
    return {
      mode: 'off',
      error: err,
      source: 'default',
      sourceDetail: 'fail-closed',
      rawValue: 'off',
      topPath: null,
    };
  }
}

// AFH-04 — apply the ordered codex → gemini → claude(last-resort) reviewer
// fallback on top of an already-resolved (gemini-layered) route. Pure: the
// caller supplies the AFH-02 grounding snapshot; a null/unavailable snapshot
// returns `baseRoute` untouched, which is the fail-open contract.
export function applyAfhReviewerRouteForAttempt({
  subject = null,
  baseRoute,
  grounding = null,
  geminiReviewerMode = null,
  routeTable = baseRoute?.routeTable,
} = {}) {
  const decision = afhReviewerFallbackDecision({
    builderClass: subject?.builderClass || baseRoute?.builderClass || null,
    baseRoute,
    grounding,
    geminiReviewerMode,
    ...(routeTable ? { routeTable } : {}),
  });
  return { decision, route: applyAfhReviewerFallbackDecision(baseRoute, decision) };
}

export function selectReviewerRouteForAttempt({
  subject,
  baseRoute,
  rootDir,
  repoPath,
  prNumber,
  env = process.env,
  afhGrounding = null,
}) {
  const threshold = resolveReviewerTimeoutFallbackThreshold(env);
  if (threshold <= 0) return baseRoute;
  const cascadeState = readCascadeState(rootDir, { repo: repoPath, prNumber });
  const timeoutFailures = Number(cascadeState?.transientFailureBreakdown?.['reviewer-timeout'] || 0);
  if (cascadeState?.lastFailureClass !== 'reviewer-timeout' || timeoutFailures < threshold) {
    return baseRoute;
  }
  const fallbackModel = resolveReviewerTimeoutFallbackModel(env);
  if (!fallbackModel || fallbackModel === baseRoute?.reviewerModel) return baseRoute;
  const fallbackRoute = REVIEWER_TIMEOUT_FALLBACK_ROUTE_BY_MODEL[fallbackModel];
  if (!fallbackRoute) return baseRoute;
  // AFH-04: never switch the timeout fallback onto a reviewer whose provider is
  // authoritatively grounded (hard or AFH-02 soft) — that trades a slow reviewer
  // for one that cannot spawn at all. No signal → unchanged behavior.
  const fallbackGrounding = reviewerModelGrounding(afhGrounding, fallbackModel);
  if (fallbackGrounding.grounded) {
    return {
      ...baseRoute,
      afhTimeoutFallbackSkipped: {
        candidateReviewerModel: fallbackModel,
        provider: fallbackGrounding.provider,
        state: fallbackGrounding.state,
        hardGrounded: fallbackGrounding.hardGrounded,
        softGrounded: fallbackGrounding.softGrounded,
      },
    };
  }
  const builderClass = subject?.builderClass || baseRoute.builderClass || null;
  return {
    ...baseRoute,
    reviewerModel: fallbackRoute.reviewerModel,
    botTokenEnv: fallbackRoute.botTokenEnv,
    timeoutFallback: {
      fromReviewerModel: baseRoute.reviewerModel,
      toReviewerModel: fallbackRoute.reviewerModel,
      timeoutFailures,
      threshold,
      builderClass,
      sameModelAsBuilder: isCrossModelReviewWaived(builderClass, fallbackRoute.reviewerModel),
    },
  };
}

export function resolveStaleReviewerReconcilePerPoll(env = process.env) {
  const raw = env.ADVERSARIAL_STALE_REVIEWER_RECONCILE_PER_POLL;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_STALE_REVIEWER_RECONCILE_PER_POLL;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_STALE_REVIEWER_RECONCILE_PER_POLL;
  return parsed;
}
