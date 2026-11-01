// Remediation concurrency-cap resolution (CFG-01 `remediation.max_concurrent_jobs`
// floor + `remediation.max_concurrent_jobs_ceiling`). Extracted from
// follow-up-remediation.mjs (ARC-19 headroom); re-exported there unchanged.
import { loadRoleConfig } from './role-config.mjs';

const REMEDIATION_MAX_CONCURRENT_JOBS_ENV = 'ADVERSARIAL_REMEDIATION_MAX_CONCURRENT_JOBS';
const DEFAULT_REMEDIATION_MAX_CONCURRENT_JOBS = 1;
const MAX_REMEDIATION_MAX_CONCURRENT_JOBS = 8;

function _resolveRemediationCfgCeiling(env = process.env, options = {}) {
  // CFG-01 anchor: `remediation.max_concurrent_jobs_ceiling` promoted
  // 2026-06-09. Default 8 — unchanged from MAX_REMEDIATION_MAX_CONCURRENT_JOBS.
  const cfgValue = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'remediation.max_concurrent_jobs_ceiling',
  }).get(
    'remediation.max_concurrent_jobs_ceiling',
    MAX_REMEDIATION_MAX_CONCURRENT_JOBS
  );
  const parsed = Number(cfgValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return MAX_REMEDIATION_MAX_CONCURRENT_JOBS;
  }
  return parsed;
}

function normalizeMaxConcurrentFollowUpJobs(value, {
  fallback = DEFAULT_REMEDIATION_MAX_CONCURRENT_JOBS,
  max = null,
  env = process.env,
  onClamp = null,
  topPath,
  modulePaths,
  loaderImpl,
} = {}) {
  // `max` resolved at call time so the CFG ceiling is consulted lazily and
  // tests can override via options.max without standing up a config loader.
  const effectiveMax = max ?? _resolveRemediationCfgCeiling(env, { topPath, modulePaths, loaderImpl });
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  if (parsed > effectiveMax) {
    onClamp?.({
      requested: parsed,
      clamped: effectiveMax,
    });
    return effectiveMax;
  }
  return parsed;
}

function resolveRemediationMaxConcurrentJobs(env = process.env, options = {}) {
  // CFG-01 anchor for the floor: `remediation.max_concurrent_jobs`.
  // Legacy env names are resolved by ENV_ALIASES in the loader so
  // canonical-vs-legacy conflicts fail loud before runtime clamping.
  const cfgValue = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'remediation.max_concurrent_jobs',
  }).get('remediation.max_concurrent_jobs', null);
  return normalizeMaxConcurrentFollowUpJobs(
    cfgValue,
    { ...options, env: options.env ?? env }
  );
}

export {
  DEFAULT_REMEDIATION_MAX_CONCURRENT_JOBS,
  MAX_REMEDIATION_MAX_CONCURRENT_JOBS,
  REMEDIATION_MAX_CONCURRENT_JOBS_ENV,
  normalizeMaxConcurrentFollowUpJobs,
  resolveRemediationMaxConcurrentJobs,
};
