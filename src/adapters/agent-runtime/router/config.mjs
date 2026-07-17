// Health-router configuration (v2 app architecture §6.2). Every threshold the
// router keys on lives here as an env-tunable default, so nothing downstream
// hardcodes a literal: `k` (probe-failure threshold), the resume hysteresis
// (`m` healthy probes across `w` minutes), the dispatch-acceptance p95 budget,
// SSE-liveness timeout, and the separately-configured OS-run liveness timeout
// (§6.3). Defaults mirror the SPEC: k=3 @ 30s cadence, m=6 over w=5m.

const DEFAULTS = Object.freeze({
  enabled: true,
  probeFailureThreshold: 3, // k — consecutive failed probes before failover
  probeCadenceMs: 30_000, // probe interval; span math uses observed times, not this
  resumeHealthyProbes: 6, // m — consecutive healthy probes required to resume
  resumeWindowMs: 5 * 60 * 1000, // w — minimum span the m healthy probes must cover
  dispatchP95ThresholdMs: 5_000, // rolling dispatch-acceptance p95 ceiling
  dispatchLatencyWindowSize: 20, // rolling sample count feeding the p95
  sseLivenessTimeoutMs: 90_000, // max age of the last SSE event before "not live"
  osRunLivenessTimeoutMs: 90_000, // §6.3 in-flight OS run liveness deadline
  healthzTimeoutMs: 5_000, // per-probe healthz request timeout
});

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return true;
}

// Resolve the router config from the environment, layering explicit overrides on
// top of the SPEC defaults. Accepts an `overrides` object (used by the domain
// config / callers) so a domain can tune thresholds without an env var.
function resolveRouterConfig(env = process.env, overrides = {}) {
  const base = {
    enabled: parseBoolean(env.ADVERSARIAL_ROUTER_AUTOMATIC_FAILOVER, DEFAULTS.enabled),
    probeFailureThreshold: parsePositiveInteger(
      env.ADVERSARIAL_ROUTER_PROBE_FAILURE_THRESHOLD,
      DEFAULTS.probeFailureThreshold,
    ),
    probeCadenceMs: parsePositiveNumber(
      env.ADVERSARIAL_ROUTER_PROBE_CADENCE_MS,
      DEFAULTS.probeCadenceMs,
    ),
    resumeHealthyProbes: parsePositiveInteger(
      env.ADVERSARIAL_ROUTER_RESUME_HEALTHY_PROBES,
      DEFAULTS.resumeHealthyProbes,
    ),
    resumeWindowMs: parsePositiveNumber(
      env.ADVERSARIAL_ROUTER_RESUME_WINDOW_MS,
      DEFAULTS.resumeWindowMs,
    ),
    dispatchP95ThresholdMs: parsePositiveNumber(
      env.ADVERSARIAL_ROUTER_DISPATCH_P95_THRESHOLD_MS,
      DEFAULTS.dispatchP95ThresholdMs,
    ),
    dispatchLatencyWindowSize: parsePositiveInteger(
      env.ADVERSARIAL_ROUTER_DISPATCH_LATENCY_WINDOW,
      DEFAULTS.dispatchLatencyWindowSize,
    ),
    sseLivenessTimeoutMs: parsePositiveNumber(
      env.ADVERSARIAL_ROUTER_SSE_LIVENESS_TIMEOUT_MS,
      DEFAULTS.sseLivenessTimeoutMs,
    ),
    osRunLivenessTimeoutMs: parsePositiveNumber(
      env.ADVERSARIAL_ROUTER_OS_RUN_LIVENESS_TIMEOUT_MS,
      DEFAULTS.osRunLivenessTimeoutMs,
    ),
    healthzTimeoutMs: parsePositiveNumber(
      env.ADVERSARIAL_ROUTER_HEALTHZ_TIMEOUT_MS,
      DEFAULTS.healthzTimeoutMs,
    ),
  };
  // Explicit overrides win over env; invalid overrides fall back to the resolved
  // env/default value rather than corrupting a threshold.
  return {
    ...base,
    enabled: overrides.enabled === undefined ? base.enabled : parseBoolean(overrides.enabled, base.enabled),
    probeFailureThreshold: parsePositiveInteger(overrides.probeFailureThreshold, base.probeFailureThreshold),
    probeCadenceMs: parsePositiveNumber(overrides.probeCadenceMs, base.probeCadenceMs),
    resumeHealthyProbes: parsePositiveInteger(overrides.resumeHealthyProbes, base.resumeHealthyProbes),
    resumeWindowMs: parsePositiveNumber(overrides.resumeWindowMs, base.resumeWindowMs),
    dispatchP95ThresholdMs: parsePositiveNumber(overrides.dispatchP95ThresholdMs, base.dispatchP95ThresholdMs),
    dispatchLatencyWindowSize: parsePositiveInteger(overrides.dispatchLatencyWindowSize, base.dispatchLatencyWindowSize),
    sseLivenessTimeoutMs: parsePositiveNumber(overrides.sseLivenessTimeoutMs, base.sseLivenessTimeoutMs),
    osRunLivenessTimeoutMs: parsePositiveNumber(overrides.osRunLivenessTimeoutMs, base.osRunLivenessTimeoutMs),
    healthzTimeoutMs: parsePositiveNumber(overrides.healthzTimeoutMs, base.healthzTimeoutMs),
  };
}

export {
  DEFAULTS,
  parseBoolean,
  parsePositiveInteger,
  parsePositiveNumber,
  resolveRouterConfig,
};
