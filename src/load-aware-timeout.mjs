/**
 * Load-aware command-timeout sizing.
 *
 * The hammer wraps changed-surface test suites in a wall-clock alarm before it
 * merges (mandate step 2b). A FIXED alarm mis-fires under fleet contention: a
 * suite that runs in ~T seconds on an idle host can overrun 2-3x when N workers
 * share the CPU, so the hammer times out with NO failures and re-runs the whole
 * suite at a higher cap — doubling the cost for identical code
 * (agent-os#5464: `test_endpoints.py` ran fine at ~5.5m solo but overran a 360s
 * cap under load, forcing a 600s rerun). This helper scales a NOMINAL timeout by
 * observed host CPU load so the FIRST run already carries enough headroom, while
 * an idle host keeps a tight cap (fast hang detection stays intact).
 *
 * The curve mirrors agent-os's fleet-pressure multiplier
 * (`cwp_dispatch/timeout_policy.py`), host-load subset:
 *   loadPerCore = loadAvg1m / cpuCount
 *   factor      = max(0, (loadPerCore - 1) / 2)   // 0 at load<=1, 1.0 at load=3
 *   multiplier  = clamp(1 + factor * 5, 1, 6)     // 1x idle, 6x at load>=3
 *
 * `loadAwareMultiplier` / `loadAwareTimeoutSeconds(base, {loadAvg1m, cpuCount})`
 * are PURE given their inputs (unit-testable, no clock, no randomness); the
 * argless call form reads `os.loadavg()` / `os.cpus()` at call time.
 *
 * @module load-aware-timeout
 */
import os from 'node:os';

/** Multiplier floor — never shrink a nominal timeout. */
export const MIN_MULTIPLIER = 1;
/** Multiplier ceiling — matches agent-os fleet_pressure default cap (6x). */
export const MAX_MULTIPLIER = 6;
/** Absolute clamp so a wild loadavg can never produce an unbounded alarm. */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 3600;

/**
 * Host-load → patience multiplier in `[MIN_MULTIPLIER, MAX_MULTIPLIER]`.
 * @param {number} loadPerCore  1-minute loadavg divided by CPU count.
 * @returns {number}
 */
export function loadAwareMultiplier(loadPerCore) {
  const lpc = Number.isFinite(loadPerCore) ? Math.max(0, loadPerCore) : 0;
  const factor = Math.max(0, (lpc - 1) / 2);
  const multiplier = 1 + factor * 5;
  return Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, multiplier));
}

/**
 * Scale a nominal timeout by current (or supplied) host CPU load.
 *
 * @param {number|string} baseSeconds  Nominal timeout for an idle host (>0).
 * @param {Object} [opts]
 * @param {number} [opts.loadAvg1m]   Override 1m loadavg (else os.loadavg()[0]).
 * @param {number} [opts.cpuCount]    Override CPU count (else os.cpus().length).
 * @param {number} [opts.maxSeconds]  Absolute clamp (default 3600).
 * @returns {number} Effective timeout in whole seconds, never below the nominal.
 * @throws {Error} when baseSeconds is not a positive finite number.
 */
export function loadAwareTimeoutSeconds(baseSeconds, opts = {}) {
  const { loadAvg1m, cpuCount, maxSeconds = DEFAULT_MAX_TIMEOUT_SECONDS } = opts;
  const base = Number(baseSeconds);
  if (!Number.isFinite(base) || base <= 0) {
    throw new Error(
      `load-aware-timeout: baseSeconds must be a positive number, got ${baseSeconds}`,
    );
  }
  const cores = Number.isFinite(cpuCount) && cpuCount > 0
    ? cpuCount
    : (os.cpus()?.length || 1);
  const load = Number.isFinite(loadAvg1m) ? loadAvg1m : (os.loadavg()?.[0] ?? 0);
  const loadPerCore = load / cores;
  const effective = Math.ceil(base * loadAwareMultiplier(loadPerCore));
  // Never below the nominal. The max cap limits load inflation, not the
  // caller's explicit nominal timeout.
  const nominal = Math.ceil(base);
  const cap = Math.max(nominal, maxSeconds);
  return Math.min(cap, Math.max(nominal, effective));
}
