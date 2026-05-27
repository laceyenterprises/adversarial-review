import {
  checkReviewerMemoryAdmission,
  peakReviewerMemoryMbFor,
  readMemoryPressureSample,
} from './watcher-memory-pressure.mjs';

const DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX = 3;

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
  const configuredMax = watcherConfig.maxConcurrentFirstPassReviewers
    ?? watcherConfig.reviewerPoolMaxConcurrent
    ?? DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX;
  const maxConcurrent = parsePositiveInteger(
    env.ADVERSARIAL_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT
      ?? env.ADVERSARIAL_FIRST_PASS_REVIEWER_MAX_CONCURRENT
      ?? env.ADVERSARIAL_REVIEWER_POOL_MAX_CONCURRENT,
    parsePositiveInteger(configuredMax, DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX)
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
} = {}) {
  let samplePromise = null;
  return async function reviewerMemoryAdmissionSampleForTick() {
    if (!samplePromise) {
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
    throw errors[0];
  }
  return {
    dispatched: started,
    maxObservedConcurrency,
  };
}

export {
  DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX,
  compareReviewerDispatchCandidates,
  createReviewerMemoryAdmissionSampler,
  reserveReviewerMemoryAdmission,
  resolveFirstPassReviewerPoolConfig,
  runBoundedReviewerDispatchQueue,
  sortReviewerDispatchCandidates,
};
