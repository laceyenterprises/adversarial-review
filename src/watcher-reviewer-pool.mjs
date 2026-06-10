import {
  checkReviewerMemoryAdmission,
  peakReviewerMemoryMbFor,
  readMemoryPressureSample,
} from './watcher-memory-pressure.mjs';
import { getConfig } from './config-loader.mjs';

const DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX = 3;
const DEFAULT_REVIEWER_MEMORY_SAMPLE_TTL_MS = 120_000;

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

function _resolveFirstPassPoolMaxFromCfg() {
  // CFG-01 anchor: `watcher.first_pass_reviewer_pool_max_concurrent_reviewers`
  // promoted 2026-06-09. Legacy `ADVERSARIAL_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT`
  // (and its two earlier aliases) remain honored via ENV_ALIASES, so this CFG
  // branch only takes effect if no env value is set.
  let cfgValue;
  try {
    cfgValue = getConfig('watcher.first_pass_reviewer_pool_max_concurrent_reviewers', null);
  } catch (err) {
    cfgValue = null;
  }
  return cfgValue;
}

function resolveFirstPassReviewerPoolConfig({
  env = process.env,
  watcherConfig = {},
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
  //   1. Legacy env vars (ADVERSARIAL_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT, …)
  //   2. CFG-01 `watcher.first_pass_reviewer_pool_max_concurrent_reviewers`
  //   3. watcherConfig kwarg
  //   4. DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX
  const configuredMax = watcherConfig.maxConcurrentFirstPassReviewers
    ?? watcherConfig.reviewerPoolMaxConcurrent
    ?? DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX;
  const cfgMax = _resolveFirstPassPoolMaxFromCfg();
  const maxConcurrent = parsePositiveInteger(
    env.ADVERSARIAL_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT
      ?? env.ADVERSARIAL_FIRST_PASS_REVIEWER_MAX_CONCURRENT
      ?? env.ADVERSARIAL_REVIEWER_POOL_MAX_CONCURRENT,
    parsePositiveInteger(cfgMax, parsePositiveInteger(configuredMax, DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX))
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
  const values = [
    candidate?.subject?.createdAt,
    candidate?.current?.reviewed_at,
    candidate?.subject?.updatedAt,
  ];
  for (const value of values) {
    const ms = parseSortTimeMs(value);
    if (ms !== null) return ms;
  }
  return 0;
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

function createReviewerMemoryAdmissionSampler({
  readSample = readMemoryPressureSample,
  logger = console,
  sampleTtlMs = DEFAULT_REVIEWER_MEMORY_SAMPLE_TTL_MS,
  now = () => Date.now(),
} = {}) {
  let samplePromise = null;
  let sampledAtMs = 0;
  return async function reviewerMemoryAdmissionSampleForTick() {
    const nowMs = Number(now()) || 0;
    const ttlMs = Math.max(0, Number(sampleTtlMs) || 0);
    if (!samplePromise || (ttlMs > 0 && nowMs - sampledAtMs >= ttlMs)) {
      sampledAtMs = nowMs;
      samplePromise = readSample().catch((err) => {
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
  DEFAULT_REVIEWER_MEMORY_SAMPLE_TTL_MS,
  compareReviewerDispatchCandidates,
  createReviewerMemoryAdmissionSampler,
  reserveReviewerMemoryAdmission,
  resolveFirstPassReviewerPoolConfig,
  runBoundedReviewerDispatchQueue,
  sortReviewerDispatchCandidates,
};
