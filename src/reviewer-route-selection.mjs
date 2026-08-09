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

// Raised 3 -> 6 alongside the dead-reviewer fast path in
// reviewer-orphan-reconcile.mjs (shouldReconcileStaleReviewerSession): that fast
// path can now surface a provably-dead reviewer's stuck `reviewing` claim for
// reconcile BEFORE its ~20-min lease expires, so a backlog of such claims (e.g.
// several remediation heads whose reviewers died) must not be starved by too
// tight a per-poll cap. Kept modest so the per-poll GitHub head-probe cost this
// cap exists to bound stays bounded.
const DEFAULT_STALE_REVIEWER_RECONCILE_PER_POLL = 6;
const DEFAULT_REVIEWER_TIMEOUT_FALLBACK_THRESHOLD = 2;
const DEFAULT_REVIEWER_EXEC_FALLBACK_THRESHOLD = 2;
const REVIEWER_EXEC_FALLBACK_FAILURE_CLASSES = Object.freeze([
  'reviewer-timeout',
  'reviewer-command-failed',
  'oauth-broken',
]);

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

export function resolveReviewerExecFallbackThreshold(env = process.env) {
  const raw = env.AGENT_OS_REVIEWER_EXEC_FALLBACK_THRESHOLD
    ?? env.ADVERSARIAL_REVIEWER_EXEC_FALLBACK_THRESHOLD;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_REVIEWER_EXEC_FALLBACK_THRESHOLD;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_REVIEWER_EXEC_FALLBACK_THRESHOLD;
  return parsed;
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

function reviewerRouteForModel(model) {
  const normalized = normalizeReviewerAttribution(model);
  return REVIEWER_TIMEOUT_FALLBACK_ROUTE_BY_MODEL[normalized] || null;
}

function reviewerExecFailureCount(cascadeState, failureClass) {
  return Number(cascadeState?.transientFailureBreakdown?.[failureClass] || 0);
}

function reviewerExecFailureSignal({ cascadeState, currentRow }) {
  const cascadeFailureClass = REVIEWER_EXEC_FALLBACK_FAILURE_CLASSES.includes(cascadeState?.lastFailureClass)
    ? cascadeState.lastFailureClass
    : null;
  const rowFailureClass = REVIEWER_EXEC_FALLBACK_FAILURE_CLASSES.includes(infraRecoverableFailureClass(currentRow))
    ? infraRecoverableFailureClass(currentRow)
    : null;
  const failureClass = cascadeFailureClass || rowFailureClass;
  if (!failureClass) return { failureClass: null, failureCount: 0 };
  const cascadeCount = cascadeFailureClass === failureClass
    ? reviewerExecFailureCount(cascadeState, failureClass)
    : 0;
  // Row-level command failures charge infra_auto_recover_attempts when the
  // retry is claimed, so a row sitting after its first failure has 0, after its
  // second same-head failure has 1. Add one to express actual consecutive
  // failures for the threshold check without falling back on the first failure.
  const rowCount = rowFailureClass === failureClass
    ? Number(currentRow?.infra_auto_recover_attempts || 0) + 1
    : 0;
  return { failureClass, failureCount: Math.max(cascadeCount, rowCount) };
}

function currentRowHeadMatches(row, headSha) {
  if (!row || !headSha) return false;
  return String(row.reviewer_head_sha || '') === String(headSha || '');
}

function modelMayReviewBuilder(model, builderClass) {
  if (normalizeReviewerAttribution(model) === 'gemini') {
    return builderClass !== 'gemini';
  }
  return !isCrossModelReviewWaived(builderClass, model);
}

function candidateReviewerModelsForExecFallback({ baseRoute, builderClass }) {
  const seen = new Set();
  const candidates = [];
  const push = (model) => {
    const normalized = normalizeReviewerAttribution(model);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };
  push(baseRoute?.geminiReviewerSelection?.replacedReviewerModel);
  push(baseRoute?.timeoutFallback?.fromReviewerModel);
  for (const model of ['claude', 'codex', 'gemini']) push(model);
  return candidates.filter((model) => (
    model !== normalizeReviewerAttribution(baseRoute?.reviewerModel) &&
    reviewerRouteForModel(model) &&
    modelMayReviewBuilder(model, builderClass)
  ));
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
  currentRow = null,
  headSha = null,
  env = process.env,
  afhGrounding = null,
}) {
  const cascadeState = readCascadeState(rootDir, { repo: repoPath, prNumber });
  const builderClass = subject?.builderClass || baseRoute.builderClass || null;
  const execThreshold = resolveReviewerExecFallbackThreshold(env);
  const execFailureSignal = reviewerExecFailureSignal({ cascadeState, currentRow });
  if (
    execThreshold > 0 &&
    currentRowHeadMatches(currentRow, headSha) &&
    rowReviewerMatches(currentRow, baseRoute?.reviewerModel) &&
    execFailureSignal.failureClass &&
    execFailureSignal.failureCount >= execThreshold
  ) {
    const attempted = [];
    for (const candidateModel of candidateReviewerModelsForExecFallback({ baseRoute, builderClass })) {
      const fallbackGrounding = reviewerModelGrounding(afhGrounding, candidateModel);
      attempted.push({
        reviewerModel: candidateModel,
        grounded: fallbackGrounding.grounded,
        provider: fallbackGrounding.provider,
        state: fallbackGrounding.state,
      });
      if (fallbackGrounding.grounded) continue;
      const fallbackRoute = reviewerRouteForModel(candidateModel);
      return {
        ...baseRoute,
        reviewerModel: fallbackRoute.reviewerModel,
        botTokenEnv: fallbackRoute.botTokenEnv,
        reviewerModelFallback: {
          event: 'reviewer-model-fallback',
          reason: 'repeated-reviewer-exec-failure',
          fromReviewerModel: baseRoute.reviewerModel,
          toReviewerModel: fallbackRoute.reviewerModel,
          failureClass: execFailureSignal.failureClass,
          failureCount: execFailureSignal.failureCount,
          threshold: execThreshold,
          headSha,
          builderClass,
        },
      };
    }
    return {
      ...baseRoute,
      reviewerModelFallbackSkipped: {
        event: 'reviewer-model-fallback-skipped',
        reason: attempted.length > 0 ? 'no-healthy-alternative' : 'no-eligible-alternative',
        fromReviewerModel: baseRoute.reviewerModel,
        failureClass: execFailureSignal.failureClass,
        failureCount: execFailureSignal.failureCount,
        threshold: execThreshold,
        headSha,
        builderClass,
        attempted,
      },
    };
  }

  const threshold = resolveReviewerTimeoutFallbackThreshold(env);
  if (threshold <= 0) return baseRoute;
  const timeoutFailures = Number(cascadeState?.transientFailureBreakdown?.['reviewer-timeout'] || 0);
  if (cascadeState?.lastFailureClass !== 'reviewer-timeout' || timeoutFailures < threshold) {
    return baseRoute;
  }
  const fallbackModel = resolveReviewerTimeoutFallbackModel(env);
  if (!fallbackModel || fallbackModel === baseRoute?.reviewerModel) return baseRoute;
  const fallbackRoute = reviewerRouteForModel(fallbackModel);
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
