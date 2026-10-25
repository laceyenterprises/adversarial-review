import { loadAwareTimeoutMs, timerDelayMs } from './load-aware-timeout.mjs';
// Legacy reviewer timeout, still used for non-streaming paths. Streamed Claude
// and Codex reviews use the idle watchdog and scaled ceiling in
// reviewer-timeout-model.mjs.
//
// CFG promotion 2026-06-09: these are now CFG-01 knobs at
// `reviewer.timeout_ms` and `reviewer.no_progress_timeout_ms`. The legacy
// env names (`ADVERSARIAL_REVIEWER_TIMEOUT_MS`, `ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS`)
// remain honored as aliases via the config-loader's ENV_ALIASES registry.
import { loadRoleConfig } from './role-config.mjs';
import { ReviewerChunkBudgetExceededError } from './reviewer-outcomes.mjs';

const DEFAULT_REVIEWER_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_PROGRESS_TIMEOUT_MS = 15 * 60 * 1000;
// Retained for callers with non-streaming CLI output. Streamed reviewers use
// resolveReviewerIdleTimeoutSeconds and do not arm a first-output timer.
const DEFAULT_FIRST_OUTPUT_TIMEOUT_MS = 0;
const DEFAULT_AGY_PRINT_TIMEOUT_MS = 19 * 60 * 1000;
const AGY_PRINT_TIMEOUT_SUBPROCESS_SLACK_MS = 30 * 1000;
const AGY_CHUNK_TIMEOUT_SLACK_MS = 2 * 60 * 1000;
// Fixed aggregate envelope, including chunk and process slack. Load can grow
// requested call budgets, but never this ceiling.
const AGY_CHUNK_TIMEOUT_CAP_MS = 6 * 60 * 60 * 1000;
// Covers snapshot/context preparation and posting outside the chunk loop.
const REVIEWER_PROCESS_SLACK_MS = 5 * 60 * 1000;

function resolveAgyChunkTimeoutCapMs(env = process.env) {
  return timerDelayMs(_resolvePositiveInt(env.ADVERSARIAL_REVIEW_AGY_CHUNK_TIMEOUT_CAP_MS, AGY_CHUNK_TIMEOUT_CAP_MS));
}

function resolveAgyChunkTimeoutPlan({ chunkCount, promptBytes = null, env = process.env } = {}) {
  if (!Number.isSafeInteger(chunkCount) || chunkCount < 1) throw new TypeError('chunkCount must be a positive integer');
  const requestedPerChunkTimeoutMs = resolveAgyReviewerSubprocessTimeoutMs(env);
  const capMs = resolveAgyChunkTimeoutCapMs(env);
  // These inputs have already been load-scaled. Retain the unconstrained
  // sizing diagnostic, then divide the available envelope across all calls.
  // Reserve both slacks so the parent does not clip a saturated chunk plan.
  const requiredMs = requestedPerChunkTimeoutMs * chunkCount + AGY_CHUNK_TIMEOUT_SLACK_MS;
  const availableMs = capMs - REVIEWER_PROCESS_SLACK_MS - AGY_CHUNK_TIMEOUT_SLACK_MS;
  const perChunkTimeoutMs = Math.max(0, Math.min(requestedPerChunkTimeoutMs, Math.floor(availableMs / chunkCount)));
  const timeoutMs = perChunkTimeoutMs * chunkCount + AGY_CHUNK_TIMEOUT_SLACK_MS;
  const minimumCapMs = chunkCount + AGY_CHUNK_TIMEOUT_SLACK_MS + REVIEWER_PROCESS_SLACK_MS;
  const plan = { chunkCount, requestedPerChunkTimeoutMs, perChunkTimeoutMs, capMs, requiredMs, timeoutMs, minimumCapMs, promptBytes };
  // Never let timerDelayMs turn an impossible allocation into a 1ms timer.
  if (perChunkTimeoutMs < 1) throw new ReviewerChunkBudgetExceededError(plan);
  return plan;
}

function resolveGeminiReviewerProcessTimeoutMs(env = process.env, { plan = null } = {}) {
  // Per-call budgets are already load-scaled. Compose them once; the aggregate
  // cap is never load-scaled or used as the nominal process deadline.
  const workMs = plan?.timeoutMs ?? resolveAgyReviewerSubprocessTimeoutMs(env);
  return timerDelayMs(Math.min(workMs + REVIEWER_PROCESS_SLACK_MS, resolveAgyChunkTimeoutCapMs(env)));
}

function _resolvePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

// The configured reviewer timeout before host-load scaling. The reviewer token
// handoff floor keeps this part whole and caps only the load-scaled excess.
function resolveNominalReviewerTimeoutMs(env = process.env, options = {}) {
  const cfgValue = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'reviewer.timeout_ms',
  }).get('reviewer.timeout_ms', DEFAULT_REVIEWER_TIMEOUT_MS);
  return _resolvePositiveInt(cfgValue, DEFAULT_REVIEWER_TIMEOUT_MS);
}

function resolveReviewerTimeoutMs(env = process.env, options = {}) {
  return loadAwareTimeoutMs(resolveNominalReviewerTimeoutMs(env, options), { maxMs: Infinity });
}

function resolveProgressTimeoutMs(env = process.env, options = {}) {
  const cfgValue = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'reviewer.no_progress_timeout_ms',
  }).get('reviewer.no_progress_timeout_ms', DEFAULT_PROGRESS_TIMEOUT_MS);
  return loadAwareTimeoutMs(_resolvePositiveInt(cfgValue, DEFAULT_PROGRESS_TIMEOUT_MS), { maxMs: Infinity });
}

function resolveFirstOutputTimeoutMs(env = process.env, options = {}) {
  const cfgValue = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'reviewer.first_output_timeout_ms',
  }).get('reviewer.first_output_timeout_ms', DEFAULT_FIRST_OUTPUT_TIMEOUT_MS);
  // 0 is a meaningful value here (deadline disabled), so it must survive the
  // positive-int guard that the other resolvers use to reject junk.
  const parsed = Number(cfgValue);
  if (Number.isFinite(parsed) && parsed === 0) return 0;
  const baseMs = _resolvePositiveInt(cfgValue, DEFAULT_FIRST_OUTPUT_TIMEOUT_MS);
  return baseMs > 0 ? loadAwareTimeoutMs(baseMs, { maxMs: Infinity }) : 0;
}

function resolveAgyPrintTimeoutMs(env = process.env, options = {}) {
  const cfgValue = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'reviewer.gemini.antigravity.print_timeout_ms',
  }).get('reviewer.gemini.antigravity.print_timeout_ms', DEFAULT_AGY_PRINT_TIMEOUT_MS);
  return loadAwareTimeoutMs(_resolvePositiveInt(cfgValue, DEFAULT_AGY_PRINT_TIMEOUT_MS), { maxMs: Infinity });
}

function resolveAgyReviewerSubprocessTimeoutMs(env = process.env, options = {}) {
  const reviewerTimeoutMs = options.reviewerTimeoutMs ?? resolveReviewerTimeoutMs(env, options);
  const printTimeoutMs = options.printTimeoutMs ?? resolveAgyPrintTimeoutMs(env, options);
  // These inputs are already scaled. Slack can exceed the platform limit even
  // when each input fits, so clamp the composition without scaling it again.
  return timerDelayMs(Math.max(
    _resolvePositiveInt(reviewerTimeoutMs, DEFAULT_REVIEWER_TIMEOUT_MS),
    _resolvePositiveInt(printTimeoutMs, DEFAULT_AGY_PRINT_TIMEOUT_MS) + AGY_PRINT_TIMEOUT_SUBPROCESS_SLACK_MS,
  ));
}

export {
  AGY_CHUNK_TIMEOUT_SLACK_MS,
  AGY_CHUNK_TIMEOUT_CAP_MS,
  REVIEWER_PROCESS_SLACK_MS,
  resolveAgyChunkTimeoutCapMs,
  resolveAgyChunkTimeoutPlan,
  resolveGeminiReviewerProcessTimeoutMs,
  AGY_PRINT_TIMEOUT_SUBPROCESS_SLACK_MS,
  DEFAULT_AGY_PRINT_TIMEOUT_MS,
  DEFAULT_PROGRESS_TIMEOUT_MS,
  DEFAULT_FIRST_OUTPUT_TIMEOUT_MS,
  DEFAULT_REVIEWER_TIMEOUT_MS,
  resolveAgyPrintTimeoutMs,
  resolveAgyReviewerSubprocessTimeoutMs,
  resolveProgressTimeoutMs,
  resolveFirstOutputTimeoutMs,
  resolveNominalReviewerTimeoutMs,
  resolveReviewerTimeoutMs,
};
