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
 * support synthetic load inputs. CPU samples and config policy are cached for
 * five seconds; the last good CPU sample survives failures for up to 60 seconds.
 * The default call reads current os.loadavg().
 *
 * @module load-aware-timeout
 */
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { loadRoleConfig } from './role-config.mjs';

/** Multiplier floor — never shrink a nominal timeout. */
export const MIN_MULTIPLIER = 1;
export const MAX_MULTIPLIER = 6;
export const DEFAULT_MAX_TIMEOUT_SECONDS = 3600;
// Node coerces larger setTimeout/setInterval delays to 1 ms.
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** Clamp an already-sized positive delay; never apply another load multiplier. */
export function timerDelayMs(delayMs) {
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(1, Math.ceil(delayMs)));
}
export const CPU_BUSY_THRESHOLD_PERCENT = 85;
const SAMPLE_INTERVAL_MS = 5_000;
// Sampling blocks daemon event loops; failures already have a safe fallback.
const CPU_SAMPLE_TIMEOUT_MS = 1_000;
const LAST_GOOD_CPU_MAX_AGE_MS = 60_000;
const SUBSTITUTION_LOG_INTERVAL_MS = 60_000;
const HOST_CPU_COUNT = os.cpus()?.length || 1;

// Cache failures too: an unreadable ps must not spawn again on every call.
export function createCpuBusySampler({
  execFileSyncImpl = (...args) => execFileSync(...args),
  nowMs = () => performance.now(),
  cpuCount = HOST_CPU_COUNT,
  warn = message => console.warn(message),
} = {}) {
  let sampledAt = -Infinity;
  let cached = null;
  let lastGood = null;
  let lastGoodAt = -Infinity;
  let warnedAt = -Infinity;
  return function sample() {
    let now = nowMs();
    if (now - sampledAt >= SAMPLE_INTERVAL_MS) {
      cached = null;
      try {
        const out = execFileSyncImpl('/bin/ps', ['-A', '-o', '%cpu='], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: CPU_SAMPLE_TIMEOUT_MS,
        });
        let total = 0;
        let seen = false;
        for (const line of out.split(/\r?\n/)) {
          const raw = line.trim().replace(',', '.');
          if (!raw) continue;
          const value = Number(raw);
          if (!Number.isFinite(value)) throw new Error('Invalid CPU sample');
          total += value;
          seen = true;
        }
        const busy = total / cpuCount;
        if (seen && Number.isFinite(busy)) cached = Math.max(0, Math.min(100, busy));
      } catch { /* Reuse fresh evidence, otherwise grant full load-based patience. */ }
      // Cache attempts from completion so a slow failure cannot cause a hot retry loop.
      now = nowMs();
      sampledAt = now;
      if (cached !== null) {
        lastGood = cached;
        lastGoodAt = now;
      }
    }
    if (cached !== null) return cached;
    // Check age on every read: cached failures must not prolong stale evidence.
    const fresh = lastGood !== null && now - lastGoodAt < LAST_GOOD_CPU_MAX_AGE_MS;
    if (now - warnedAt >= SUBSTITUTION_LOG_INTERVAL_MS) {
      warnedAt = now;
      warn(`[load-aware-timeout] CPU sample unavailable; ${fresh
        ? 'reusing last good sample (under 60s old)'
        : 'using full load-based corroboration'}`);
    }
    return fresh ? lastGood : null;
  };
}

let defaultCpuBusySampler = createCpuBusySampler();
export function hostCpuBusyPercent() { return defaultCpuBusySampler(); }

// Tests which mock host readings must not share a real or synthetic sample.
export function resetLoadAwareTimeoutCachesForTesting() {
  defaultCpuBusySampler = createCpuBusySampler();
  policyCache = null;
}

// Use the service's config cascade, including config.local.yaml. Refresh at
// most once per sample interval so timeout sizing has a constant-time hot path.
let policyCache = null;
function timeoutPolicy() {
  const path = process.env.AGENT_OS_CONFIG_PATH;
  const now = performance.now();
  if (policyCache && policyCache.path === path && now - policyCache.at < SAMPLE_INTERVAL_MS) {
    return policyCache.value;
  }
  let value = { enabled: true, maxMultiplier: MAX_MULTIPLIER };
  try {
    const cfg = loadRoleConfig();
    value = {
      enabled: cfg.get('adversarial.reviewer.load_aware.enabled', true),
      maxMultiplier: cfg.get('adversarial.reviewer.load_aware.max_multiplier', MAX_MULTIPLIER),
    };
  } catch {
    // Timeout sizing must remain available when any part of the shared config
    // is invalid. Cache failures too, bounding config reads and diagnostics.
    console.warn('[load-aware-timeout] config unavailable; using default timeout policy for 5s');
  }
  policyCache = { path, at: now, value };
  return value;
}

/**
 * Host-load → patience multiplier in `[MIN_MULTIPLIER, maxMultiplier]`.
 * @param {number} loadPerCore  1-minute loadavg divided by CPU count.
 * @param {number} [maxMultiplier=6]  Configured cap (1..20 inclusive).
 * @returns {number}
 */
export function loadAwareMultiplier(loadPerCore, maxMultiplier = MAX_MULTIPLIER) {
  const lpc = Number.isFinite(loadPerCore) ? Math.max(0, loadPerCore) : 0;
  const factor = Math.max(0, (lpc - 1) / 2);
  const multiplier = 1 + factor * 5;
  return Math.min(Math.max(MIN_MULTIPLIER, maxMultiplier), Math.max(MIN_MULTIPLIER, multiplier));
}

/** Pure load-aware multiplier; unavailable CPU readings grant full corroboration. */
export function corroboratedLoadAwareMultiplier(
  loadPerCore,
  cpuBusyPercent,
  maxMultiplier = MAX_MULTIPLIER,
  enabled = true,
) {
  if (enabled === false) return MIN_MULTIPLIER;
  const rawMultiplier = loadAwareMultiplier(loadPerCore, maxMultiplier);
  const corroboration = Number.isFinite(cpuBusyPercent)
    ? Math.min(1, Math.max(0, cpuBusyPercent / CPU_BUSY_THRESHOLD_PERCENT))
    : 1;
  return MIN_MULTIPLIER + (rawMultiplier - MIN_MULTIPLIER) * corroboration;
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
 * @returns {number} Effective timeout (policy caps never shrink the nominal).
 * @throws {Error} when baseSeconds is not a positive finite number.
 */
function scaledTimeout(baseValue, opts, maxValue) {
  const {
    loadAvg1m,
    cpuCount,
    cpuBusyPercent,
  } = opts;
  const base = Number(baseValue);
  if (!Number.isFinite(base) || base <= 0) {
    throw new Error(
      `load-aware-timeout: base timeout must be a positive number, got ${baseValue}`,
    );
  }
  const policy = opts.enabled !== undefined && opts.maxMultiplier !== undefined
    ? opts : { ...timeoutPolicy(), ...opts };
  if (policy.enabled === false) return Math.ceil(base);
  const cores = Number.isFinite(cpuCount) && cpuCount > 0
    ? cpuCount
    : HOST_CPU_COUNT;
  const load = Number.isFinite(loadAvg1m) ? loadAvg1m : (os.loadavg()?.[0] ?? 0);
  if (load <= cores) return Math.ceil(base);
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
  // full multiplier still applies. If CPU evidence is unavailable, the sampler
  // reuses a fresh successful sample; without one, use the full load curve.
  const multiplier = corroboratedLoadAwareMultiplier(
    loadPerCore, busy, policy.maxMultiplier, policy.enabled,
  );
  const effective = Math.ceil(base * multiplier);
  // Never below the nominal. The max cap limits load inflation, not the
  // caller's explicit nominal timeout.
  const nominal = Math.ceil(base);
  const cap = Math.max(nominal, maxValue);
  return Math.min(cap, Math.max(nominal, effective));
}

/**
 * Scale a NOMINAL timeout exactly once. Do not pass an already-scaled timeout
 * or a deadline composed from scaled inputs back through either load helper.
 * Policy caps never shrink the nominal; the platform timer limit always wins,
 * even when scaling is disabled or maxSeconds/maxMs is Infinity. Whole seconds
 * are capped below that limit so conversion to milliseconds remains safe.
 */
export function loadAwareTimeoutSeconds(baseSeconds, opts = {}) {
  return Math.min(Math.floor(MAX_TIMER_DELAY_MS / 1000),
    scaledTimeout(baseSeconds, opts, opts.maxSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS));
}

/** Same scale-once/platform-bound contract, rounded up to whole milliseconds. */
export function loadAwareTimeoutMs(baseMs, opts = {}) {
  return timerDelayMs(scaledTimeout(baseMs, opts, opts.maxMs ?? DEFAULT_MAX_TIMEOUT_SECONDS * 1000));
}
