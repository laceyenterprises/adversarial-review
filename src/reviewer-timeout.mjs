import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
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
// A multi-megabyte diff can require more than nine 20-minute calls. Permit
// up to seventeen at the default call budget, while keeping a hard bound.
const AGY_CHUNK_TIMEOUT_CAP_MS = 6 * 60 * 60 * 1000;
// Covers snapshot/context preparation and posting outside the chunk loop.
const REVIEWER_PROCESS_SLACK_MS = 5 * 60 * 1000;

function resolveAgyChunkTimeoutCapMs(env = process.env) {
  return loadAwareTimeoutMs(_resolvePositiveInt(env.ADVERSARIAL_REVIEW_AGY_CHUNK_TIMEOUT_CAP_MS, AGY_CHUNK_TIMEOUT_CAP_MS), { maxMs: Infinity });
}

function resolveAgyChunkTimeoutPlan({ chunkCount, promptBytes = null, env = process.env } = {}) {
  if (!Number.isSafeInteger(chunkCount) || chunkCount < 1) throw new TypeError('chunkCount must be a positive integer');
  const perChunkTimeoutMs = resolveAgyReviewerSubprocessTimeoutMs(env);
  const capMs = resolveAgyChunkTimeoutCapMs(env);
  const requiredMs = perChunkTimeoutMs * chunkCount + AGY_CHUNK_TIMEOUT_SLACK_MS;
  const plan = { chunkCount, perChunkTimeoutMs, capMs, requiredMs, timeoutMs: requiredMs, promptBytes };
  if (requiredMs > capMs) throw new ReviewerChunkBudgetExceededError(plan);
  return plan;
}

function resolveGeminiReviewerProcessTimeoutMs(env = process.env) {
  return Math.max(resolveAgyReviewerSubprocessTimeoutMs(env), resolveAgyChunkTimeoutCapMs(env)) + REVIEWER_PROCESS_SLACK_MS;
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

function resolveReviewerTimeoutMs(env = process.env, options = {}) {
  const cfgValue = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'reviewer.timeout_ms',
  }).get('reviewer.timeout_ms', DEFAULT_REVIEWER_TIMEOUT_MS);
  return loadAwareTimeoutMs(_resolvePositiveInt(cfgValue, DEFAULT_REVIEWER_TIMEOUT_MS), { maxMs: Infinity });
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
  return Math.max(
    _resolvePositiveInt(reviewerTimeoutMs, DEFAULT_REVIEWER_TIMEOUT_MS),
    _resolvePositiveInt(printTimeoutMs, DEFAULT_AGY_PRINT_TIMEOUT_MS) + AGY_PRINT_TIMEOUT_SUBPROCESS_SLACK_MS,
  );
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
  resolveReviewerTimeoutMs,
};
