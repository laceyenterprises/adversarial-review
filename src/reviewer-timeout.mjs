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
const DEFAULT_AGY_PRINT_TIMEOUT_MS = 19.5 * 60 * 1000;

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

function resolveAgyPrintTimeoutMs(env = process.env, options = {}) {
  const cfgValue = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'reviewer.gemini.agy_print_timeout_ms',
  }).get('reviewer.gemini.agy_print_timeout_ms', DEFAULT_AGY_PRINT_TIMEOUT_MS);
  return _resolvePositiveInt(cfgValue, DEFAULT_AGY_PRINT_TIMEOUT_MS);
}

export {
  DEFAULT_AGY_PRINT_TIMEOUT_MS,
  DEFAULT_PROGRESS_TIMEOUT_MS,
  DEFAULT_REVIEWER_TIMEOUT_MS,
  resolveAgyPrintTimeoutMs,
  resolveProgressTimeoutMs,
  resolveReviewerTimeoutMs,
};
