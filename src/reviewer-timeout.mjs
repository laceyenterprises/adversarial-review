// Shared subprocess timeout for both reviewer paths (claude + codex). Raised
// from 10 minutes -> 20 minutes on 2026-05-10 after PR #331's first review
// attempt hit the 10-minute wall on a substantive spec diff and got
// classified as `reviewer-timeout`. The separate no-output progress watchdog
// is intentionally 15 minutes for streaming subprocesses; non-streaming
// cli-direct reviewer commands disable it and rely on the hard deadline.
//
// CFG promotion 2026-06-09: these are now CFG-01 knobs at
// `reviewer.timeout_ms` and `reviewer.no_progress_timeout_ms`. The legacy
// env names (`ADVERSARIAL_REVIEWER_TIMEOUT_MS`, `ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS`)
// remain honored as aliases via the config-loader's ENV_ALIASES registry.
import { loadRoleConfig } from './role-config.mjs';

const DEFAULT_REVIEWER_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_PROGRESS_TIMEOUT_MS = 15 * 60 * 1000;
// DISABLED by default, and that is the contract, not an oversight.
// `claude --print --output-format json` emits a single JSON document at the END
// of the turn, so ANY first-output deadline — even a correct one-shot one — caps
// a healthy review at that value rather than bounding a wedged launch. The
// governing SPEC records this: cli-direct reviewer subprocesses are non-streaming
// and rely on the hard reviewer timeout for bounding runtime.
// Enabling this (reviewer.first_output_timeout_ms > 0) is only safe for a reviewer
// launched with a streaming output format, where silence genuinely means wedged.
// Wedged non-streaming invocations are observed instead by the reviewer-silence
// health signal plus the hard `reviewer.timeout_ms`.
const DEFAULT_FIRST_OUTPUT_TIMEOUT_MS = 0;
const DEFAULT_AGY_PRINT_TIMEOUT_MS = 19 * 60 * 1000;
const AGY_PRINT_TIMEOUT_SUBPROCESS_SLACK_MS = 30 * 1000;

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
  return _resolvePositiveInt(cfgValue, DEFAULT_REVIEWER_TIMEOUT_MS);
}

function resolveProgressTimeoutMs(env = process.env, options = {}) {
  const cfgValue = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'reviewer.no_progress_timeout_ms',
  }).get('reviewer.no_progress_timeout_ms', DEFAULT_PROGRESS_TIMEOUT_MS);
  return _resolvePositiveInt(cfgValue, DEFAULT_PROGRESS_TIMEOUT_MS);
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
  return _resolvePositiveInt(cfgValue, DEFAULT_FIRST_OUTPUT_TIMEOUT_MS);
}

function resolveAgyPrintTimeoutMs(env = process.env, options = {}) {
  const cfgValue = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'reviewer.gemini.antigravity.print_timeout_ms',
  }).get('reviewer.gemini.antigravity.print_timeout_ms', DEFAULT_AGY_PRINT_TIMEOUT_MS);
  return _resolvePositiveInt(cfgValue, DEFAULT_AGY_PRINT_TIMEOUT_MS);
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
