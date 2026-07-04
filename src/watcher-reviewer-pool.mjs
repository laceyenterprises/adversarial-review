import {
  checkReviewerMemoryAdmission,
  peakReviewerMemoryMbFor,
  readMemoryPressureSample,
} from './watcher-memory-pressure.mjs';
import { loadRoleConfig } from './role-config.mjs';

const DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX = 6;
const MAX_FIRST_PASS_REVIEWER_POOL_MAX = 12;
const DEFAULT_REVIEWER_MEMORY_SAMPLE_TTL_MS = 120_000;
const DEFAULT_REVIEWER_DISPATCH_WAIT_WARN_MS = 15 * 60 * 1000;
const DEFAULT_REVIEWER_MEMORY_PRESSURE_CONFIG = Object.freeze({
  projectedHeadroomFloorMb: 1024,
  elevatedAvailableMb: 2048,
  criticalAvailableMb: 1024,
  elevatedSwapUsedPct: 85.0,
  criticalSwapUsedPct: 95.0,
  swapPressureAvailableMb: 8192,
});

function parseBooleanFlag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeFirstPassReviewerPoolMax(value, {
  fallback = DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX,
  max = MAX_FIRST_PASS_REVIEWER_POOL_MAX,
  logger = console,
  source = 'watcher.first_pass_reviewer_pool_max_concurrent_reviewers',
} = {}) {
  const parsed = parsePositiveInteger(value, fallback);
  if (parsed > max && logger && typeof logger.warn === 'function') {
    logger.warn(
      `[watcher-reviewer-pool] WARN config key=${source}: requested max_concurrent_reviewers=${parsed} exceeds system_max=${max}; clamping to ${max}`
    );
  }
  return Math.min(parsed, max);
}

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeReviewerMemoryPressureConfig(config = {}) {
  return {
    projectedHeadroomFloorMb: Math.max(
      0,
      Math.trunc(finiteNumber(
        config.projectedHeadroomFloorMb ?? config.projected_headroom_floor_mb,
        DEFAULT_REVIEWER_MEMORY_PRESSURE_CONFIG.projectedHeadroomFloorMb
      ))
    ),
    elevatedAvailableMb: Math.max(
      0,
      Math.trunc(finiteNumber(
        config.elevatedAvailableMb ?? config.elevated_available_mb,
        DEFAULT_REVIEWER_MEMORY_PRESSURE_CONFIG.elevatedAvailableMb
      ))
    ),
    criticalAvailableMb: Math.max(
      0,
      Math.trunc(finiteNumber(
        config.criticalAvailableMb ?? config.critical_available_mb,
        DEFAULT_REVIEWER_MEMORY_PRESSURE_CONFIG.criticalAvailableMb
      ))
    ),
    elevatedSwapUsedPct: finiteNumber(
      config.elevatedSwapUsedPct ?? config.elevated_swap_used_pct,
      DEFAULT_REVIEWER_MEMORY_PRESSURE_CONFIG.elevatedSwapUsedPct
    ),
    criticalSwapUsedPct: finiteNumber(
      config.criticalSwapUsedPct ?? config.critical_swap_used_pct,
      DEFAULT_REVIEWER_MEMORY_PRESSURE_CONFIG.criticalSwapUsedPct
    ),
    swapPressureAvailableMb: Math.max(
      0,
      Math.trunc(finiteNumber(
        config.swapPressureAvailableMb ?? config.swap_pressure_available_mb,
        DEFAULT_REVIEWER_MEMORY_PRESSURE_CONFIG.swapPressureAvailableMb
      ))
    ),
  };
}

function _resolveFirstPassPoolMaxFromCfg(env = process.env, options = {}) {
  // CFG-01 anchor: `watcher.first_pass_reviewer_pool_max_concurrent_reviewers`
  // promoted 2026-06-09. Legacy `ADVERSARIAL_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT`
  // (and its two earlier aliases) remain honored via ENV_ALIASES, so canonical
  // vs legacy conflicts are detected by the loader before runtime parsing.
  return loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'watcher.first_pass_reviewer_pool_max_concurrent_reviewers',
  }).get('watcher.first_pass_reviewer_pool_max_concurrent_reviewers', null);
}

function resolveReviewerMemoryPressureConfig({
  env = process.env,
  topPath,
  modulePaths,
  loaderImpl,
} = {}) {
  const cfg = loadRoleConfig({
    env,
    topPath,
    modulePaths,
    loaderImpl,
    contextKey: 'reviewer.memory.pressure',
  });
  return normalizeReviewerMemoryPressureConfig({
    projectedHeadroomFloorMb: cfg.get('reviewer.memory.pressure.projected_headroom_floor_mb', undefined),
    elevatedAvailableMb: cfg.get('reviewer.memory.pressure.elevated_available_mb', undefined),
    criticalAvailableMb: cfg.get('reviewer.memory.pressure.critical_available_mb', undefined),
    elevatedSwapUsedPct: cfg.get('reviewer.memory.pressure.elevated_swap_used_pct', undefined),
    criticalSwapUsedPct: cfg.get('reviewer.memory.pressure.critical_swap_used_pct', undefined),
    swapPressureAvailableMb: cfg.get('reviewer.memory.pressure.swap_pressure_available_mb', undefined),
  });
}

function resolveFirstPassReviewerPoolConfig({
  env = process.env,
  watcherConfig = {},
  topPath,
  modulePaths,
  loaderImpl,
  logger = console,
} = {}) {
  const configuredEnabled = watcherConfig.firstPassReviewerPoolEnabled
    ?? watcherConfig.reviewerPoolEnabled
    ?? true;
  const enabled = parseBooleanFlag(
    env.ADVERSARIAL_FIRST_PASS_REVIEWER_POOL_ENABLED
      ?? env.ADVERSARIAL_REVIEWER_POOL_ENABLED,
    Boolean(configuredEnabled)
  );
  // Precedence (highest → lowest):
  //   1. Loader-resolved CFG/env value, including canonical + legacy aliases
  //      and their conflict checks.
  //   2. watcherConfig kwarg
  //   3. DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX
  const configuredMax = watcherConfig.maxConcurrentFirstPassReviewers
    ?? watcherConfig.reviewerPoolMaxConcurrent
    ?? DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX;
  const cfgMax = _resolveFirstPassPoolMaxFromCfg(env, { topPath, modulePaths, loaderImpl });
  const maxConcurrent = normalizeFirstPassReviewerPoolMax(
    cfgMax,
    {
      fallback: parsePositiveInteger(configuredMax, DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX),
      logger,
    }
  );
  return {
    enabled,
    maxConcurrent: enabled ? maxConcurrent : 1,
  };
}

function parseSortTimeMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function reviewerDispatchSortTimeMs(candidate) {
  return parseSortTimeMs(candidate?.subject?.createdAt) ?? Number.MAX_SAFE_INTEGER;
}

function compareReviewerDispatchCandidates(a, b) {
  const timeDelta = reviewerDispatchSortTimeMs(a) - reviewerDispatchSortTimeMs(b);
  if (timeDelta !== 0) return timeDelta;
  const repoDelta = String(a?.repoPath || '').localeCompare(String(b?.repoPath || ''));
  if (repoDelta !== 0) return repoDelta;
  return Number(a?.prNumber || 0) - Number(b?.prNumber || 0);
}

function sortReviewerDispatchCandidates(candidates) {
  return [...candidates].sort(compareReviewerDispatchCandidates);
}

function reviewerDispatchAgeMs(candidate, nowMs = Date.now()) {
  const createdAtMs = parseSortTimeMs(candidate?.subject?.createdAt);
  if (createdAtMs === null) return null;
  return Math.max(0, nowMs - createdAtMs);
}

function reviewerDispatchWaitMs(candidate, nowMs = Date.now()) {
  if (
    typeof candidate?.enqueuedAtMs === 'number'
    && Number.isFinite(candidate.enqueuedAtMs)
  ) {
    return Math.max(0, nowMs - candidate.enqueuedAtMs);
  }
  const enqueuedAt = parseSortTimeMs(candidate?.enqueuedAt);
  return enqueuedAt === null ? null : Math.max(0, nowMs - enqueuedAt);
}

function logReviewerDispatchWait(candidate, {
  logger = console,
  nowMs = Date.now(),
  waitWarnMs = DEFAULT_REVIEWER_DISPATCH_WAIT_WARN_MS,
} = {}) {
  const waitMs = reviewerDispatchWaitMs(candidate, nowMs);
  const ageMs = reviewerDispatchAgeMs(candidate, nowMs);
  const waitText = waitMs === null ? 'unknown' : String(Math.round(waitMs));
  const ageText = ageMs === null ? 'unknown' : String(Math.round(ageMs));
  const passKind = candidate?.current?.rereview_requested_at ? 'rereview' : 'first-pass';
  const message =
    `[watcher] reviewer dispatch wait ${candidate?.repoPath || 'unknown'}#${candidate?.prNumber || 'unknown'}: ` +
    `wait_ms=${waitText} pr_age_ms=${ageText} pass_kind=${passKind}`;
  logger?.log?.(message);
  if (waitMs !== null && waitMs >= waitWarnMs) {
    logger?.warn?.(
      `[watcher] reviewer dispatch wait exceeded threshold ` +
      `${candidate?.repoPath || 'unknown'}#${candidate?.prNumber || 'unknown'}: ` +
      `wait_ms=${Math.round(waitMs)} threshold_ms=${Math.round(waitWarnMs)} pr_age_ms=${ageText} pass_kind=${passKind}`
    );
  }
}

function createReviewerMemoryAdmissionSampler({
  readSample = readMemoryPressureSample,
  logger = console,
  sampleTtlMs = DEFAULT_REVIEWER_MEMORY_SAMPLE_TTL_MS,
  memoryPressureConfig = {},
  now = () => Date.now(),
} = {}) {
  let samplePromise = null;
  let sampledAtMs = 0;
  return async function reviewerMemoryAdmissionSampleForTick() {
    const nowMs = Number(now()) || 0;
    const ttlMs = Math.max(0, Number(sampleTtlMs) || 0);
    if (!samplePromise || (ttlMs > 0 && nowMs - sampledAtMs >= ttlMs)) {
      sampledAtMs = nowMs;
      samplePromise = readSample({ memoryPressureConfig }).catch((err) => {
        logger?.warn?.(
          `[watcher] memory pressure gate unavailable; admitting by legacy policy: ${err?.message || err}`
        );
        return null;
      });
    }
    return samplePromise;
  };
}

async function reserveReviewerMemoryAdmission({
  reviewerModel,
  reservationState,
  checkAdmission = checkReviewerMemoryAdmission,
  getMemoryPressureSample = null,
  memoryPressureConfig = {},
  logger = console,
} = {}) {
  const estimatedReviewerRssMb = peakReviewerMemoryMbFor(reviewerModel);
  reservationState.reservedMb += estimatedReviewerRssMb;
  const reservedMbBeforeAdmission = Math.max(0, reservationState.reservedMb - estimatedReviewerRssMb);
  try {
    const admissionOptions = {
      reviewerModel,
      reservedMb: reservedMbBeforeAdmission,
      logger,
      memoryPressureConfig,
    };
    if (getMemoryPressureSample) {
      admissionOptions.sample = await getMemoryPressureSample();
    }
    const memoryDecision = await checkAdmission({
      ...admissionOptions,
    });
    if (!memoryDecision.admit) {
      reservationState.reservedMb = Math.max(0, reservationState.reservedMb - estimatedReviewerRssMb);
      return {
        admit: false,
        estimatedReviewerRssMb,
        reservedMbBeforeAdmission,
        memoryDecision,
      };
    }
    let released = false;
    return {
      admit: true,
      estimatedReviewerRssMb,
      reservedMbBeforeAdmission,
      memoryDecision,
      release() {
        if (released) return;
        released = true;
        reservationState.reservedMb = Math.max(0, reservationState.reservedMb - estimatedReviewerRssMb);
      },
    };
  } catch (err) {
    reservationState.reservedMb = Math.max(0, reservationState.reservedMb - estimatedReviewerRssMb);
    throw err;
  }
}

async function runBoundedReviewerDispatchQueue(candidates, {
  maxConcurrent = DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX,
  maxThrownFailures = 1,
  logger = console,
  now = () => Date.now(),
  waitWarnMs = DEFAULT_REVIEWER_DISPATCH_WAIT_WARN_MS,
} = {}) {
  const concurrencyLimit = Math.max(1, Number.parseInt(String(maxConcurrent), 10) || 0);
  const thrownFailureLimit = Math.max(1, Number.parseInt(String(maxThrownFailures), 10) || 0);
  const queue = sortReviewerDispatchCandidates(candidates);
  const active = new Set();
  const errors = [];
  let nextIndex = 0;
  let maxObservedConcurrency = 0;
  let started = 0;

  async function start(candidate) {
    const currentNowMs = Number(now());
    const resolvedNowMs = Number.isFinite(currentNowMs) ? currentNowMs : Date.now();
    logReviewerDispatchWait(candidate, { logger, nowMs: resolvedNowMs, waitWarnMs });
    try {
      await candidate.run();
    } catch (err) {
      errors.push(err);
      logger?.error?.(
        `[watcher] reviewer dispatch task failed for ${candidate.repoPath}#${candidate.prNumber}:`,
        err?.message || err
      );
    }
  }

  while ((nextIndex < queue.length && errors.length < thrownFailureLimit) || active.size > 0) {
    while (
      nextIndex < queue.length
      && errors.length < thrownFailureLimit
      && active.size < concurrencyLimit
    ) {
      const promise = start(queue[nextIndex]);
      nextIndex += 1;
      started += 1;
      active.add(promise);
      promise.finally(() => active.delete(promise));
      maxObservedConcurrency = Math.max(maxObservedConcurrency, active.size);
    }
    if (active.size > 0) {
      await Promise.race(active);
    }
  }

  if (errors.length > 0) {
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, `${errors.length} reviewer dispatch tasks failed`);
  }
  return {
    dispatched: started,
    maxObservedConcurrency,
  };
}

export {
  DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX,
  DEFAULT_REVIEWER_DISPATCH_WAIT_WARN_MS,
  MAX_FIRST_PASS_REVIEWER_POOL_MAX,
  DEFAULT_REVIEWER_MEMORY_SAMPLE_TTL_MS,
  compareReviewerDispatchCandidates,
  createReviewerMemoryAdmissionSampler,
  logReviewerDispatchWait,
  reserveReviewerMemoryAdmission,
  resolveReviewerMemoryPressureConfig,
  resolveFirstPassReviewerPoolConfig,
  runBoundedReviewerDispatchQueue,
  sortReviewerDispatchCandidates,
};
