import { loadRoleConfig } from './role-config.mjs';

const DEFAULT_IDLE_TIMEOUT_SECONDS = 600;
const DEFAULT_CEILING_BASE_SECONDS = 1800;
const DEFAULT_CEILING_MAX_SECONDS = 10800;
const SECONDS_PER_CHANGED_LINE = 60;

function configSeconds(key, fallback, env = process.env, options = {}) {
  const raw = loadRoleConfig({ env, ...options, contextKey: key }).get(key, fallback);
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function resolveReviewerIdleTimeoutSeconds(env = process.env, options = {}) {
  return configSeconds('reviewer.idle_timeout_seconds', DEFAULT_IDLE_TIMEOUT_SECONDS, env, options);
}

function resolveReviewerCeilingConfig(env = process.env, options = {}) {
  const base = configSeconds('reviewer.ceiling_base_seconds', DEFAULT_CEILING_BASE_SECONDS, env, options);
  const max = configSeconds('reviewer.ceiling_max_seconds', DEFAULT_CEILING_MAX_SECONDS, env, options);
  return { base, max };
}

function calculateReviewerCeilingSeconds({ changedLines = 0, effort = 'high', base, max } = {}) {
  const lines = Number.isFinite(Number(changedLines)) ? Math.max(0, Math.floor(Number(changedLines))) : 0;
  return Math.min(max, Math.ceil((base + lines * SECONDS_PER_CHANGED_LINE) * (effort === 'xhigh' ? 1.5 : 1)));
}

function resolveReviewerCeilingSeconds({ changedLines = 0, effort = 'high', env = process.env, options = {} } = {}) {
  return calculateReviewerCeilingSeconds({ changedLines, effort, ...resolveReviewerCeilingConfig(env, options) });
}

function countChangedLines(diff) {
  return String(diff || '').split('\n').filter((line) =>
    (line.startsWith('+') && !line.startsWith('+++ ')) ||
    (line.startsWith('-') && !line.startsWith('--- '))).length;
}

export {
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  DEFAULT_CEILING_BASE_SECONDS,
  DEFAULT_CEILING_MAX_SECONDS,
  countChangedLines,
  calculateReviewerCeilingSeconds,
  resolveReviewerCeilingConfig,
  resolveReviewerIdleTimeoutSeconds,
  resolveReviewerCeilingSeconds,
};
