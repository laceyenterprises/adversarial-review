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
 *   cpuBusy    >= 85%
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
import { execFileSync } from 'node:child_process';

/** Multiplier floor — never shrink a nominal timeout. */
export const MIN_MULTIPLIER = 1;
/** Multiplier ceiling — matches agent-os fleet_pressure default cap (6x). */
export const MAX_MULTIPLIER = 6;
/** Absolute clamp so a wild loadavg can never produce an unbounded alarm. */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 3600;
/** Corroborating CPU-busy threshold required before loadavg can inflate a timeout. */
export const CPU_BUSY_THRESHOLD_PERCENT = 85;

export function hostCpuBusyPercent() {
  try {
    const out = execFileSync('/bin/ps', ['-A', '-o', '%cpu='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    });
    let total = 0;
    let seen = false;
    for (const line of out.split(/\r?\n/)) {
      const raw = line.trim().replace(',', '.');
      if (!raw) continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) return null;
      total += value;
      seen = true;
    }
    if (!seen) return null;
    const cores = os.cpus()?.length || 1;
    return Math.max(0, Math.min(100, total / cores));
  } catch {
    return null;
  }
}

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
 * @param {number} [opts.cpuBusyPercent] Override CPU busy percent (else sampled from ps).
 * @param {number} [opts.maxSeconds]  Absolute clamp (default 3600).
 * @returns {number} Effective timeout in whole seconds, never below the nominal.
 * @throws {Error} when baseSeconds is not a positive finite number.
 */
export function loadAwareTimeoutSeconds(baseSeconds, opts = {}) {
  const {
    loadAvg1m,
    cpuCount,
    cpuBusyPercent,
    maxSeconds = DEFAULT_MAX_TIMEOUT_SECONDS,
  } = opts;
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
  const hasBusyOverride = Object.prototype.hasOwnProperty.call(opts, 'cpuBusyPercent');
  const busy = hasBusyOverride ? cpuBusyPercent : hostCpuBusyPercent();
  const loadPerCore = load / cores;
  // Graded corroboration, not an all-or-nothing gate.
  //
  // The hard `busy >= 85%` gate was borrowed from admission control, where
  // acting on an uncorroborated loadavg ADDS load and can harm the host. A
  // timeout is the opposite trade: extending it costs only delayed hang
  // detection, while cutting it short costs a full redundant re-run of the
  // work that timed out.
  //
  // On an I/O-bound host that asymmetry bites. Measured 2026-09-05:
  // loadavg/core 2.51 (raw multiplier 4.78x) at 22.9% CPU busy, so the gate
  // suppressed the entire extension and reviewers died at their nominal
  // timeout -- each failure forcing a full re-review (observed attempt=2/4 and
  // 3/4 across four PRs while the merge queue backed up). This host never
  // reaches 85% because it is blocked on disk, not CPU.
  //
  // So scale the extension by how far CPU has actually climbed toward the
  // threshold. Both endpoints are unchanged: at or above the threshold the
  // full multiplier still applies, and an unreadable CPU still yields no
  // extension at all.
  const rawMultiplier = loadAwareMultiplier(loadPerCore);
  const corroboration = Number.isFinite(busy)
    ? Math.min(1, Math.max(0, busy / CPU_BUSY_THRESHOLD_PERCENT))
    : 0;
  const multiplier = MIN_MULTIPLIER + (rawMultiplier - MIN_MULTIPLIER) * corroboration;
  const effective = Math.ceil(base * multiplier);
  // Never below the nominal. The max cap limits load inflation, not the
  // caller's explicit nominal timeout.
  const nominal = Math.ceil(base);
  const cap = Math.max(nominal, maxSeconds);
  return Math.min(cap, Math.max(nominal, effective));
}
