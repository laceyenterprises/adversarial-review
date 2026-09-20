import {
  checkReviewerMemoryAdmission,
  peakReviewerMemoryMbFor,
  readMemoryPressureSample,
} from './watcher-memory-pressure.mjs';
import { loadRoleConfig } from './role-config.mjs';

const DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX = 6;
const MAX_FIRST_PASS_REVIEWER_POOL_MAX = 12;
const DEFAULT_REVIEW_LANE_FIRST_PASS_BURST_LIMIT = 2;
const DEFAULT_REVIEW_LANE_MIN_SHARE = 0.25;
const DEFAULT_REVIEW_LANE_FIRST_PASS_URGENT_AGE_MS = 5 * 60 * 1000;
const DEFAULT_REVIEWER_MEMORY_SAMPLE_TTL_MS = 120_000;
const DEFAULT_REVIEWER_DISPATCH_WAIT_WARN_MS = 15 * 60 * 1000;
const DEFAULT_SINGLE_WAVE_SETTLE_GRACE_MS = 1000;
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

function parseBoundedFloat(value, fallback, { min = 0, max = 1 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parsePositiveIntegerWithSource(value, fallback, valueSource, fallbackSource) {
  if (value === undefined || value === null || value === '') {
    return { value: fallback, source: fallbackSource };
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0
    ? { value: parsed, source: valueSource }
    : { value: fallback, source: fallbackSource };
}

function normalizeFirstPassReviewerPoolMax(value, {
  fallback = DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX,
  max = MAX_FIRST_PASS_REVIEWER_POOL_MAX,
  logger = console,
  source = 'watcher.first_pass_reviewer_pool_max_concurrent_reviewers',
  fallbackSource = 'watcherConfig.maxConcurrentFirstPassReviewers',
} = {}) {
  const { value: parsed, source: parsedSource } = parsePositiveIntegerWithSource(
    value,
    fallback,
    source,
    fallbackSource
  );
  if (parsed > max && logger && typeof logger.warn === 'function') {
    logger.warn(
      `[watcher-reviewer-pool] WARN config key=${parsedSource}: requested max_concurrent_reviewers=${parsed} exceeds system_max=${max}; clamping to ${max}`
    );
  }
  return Math.min(parsed, max);
}

function resolveReviewerCredentialConcurrencyLimit({
  poolSlots,
  availableCredentials = null,
} = {}) {
  const parsedPoolSlots = Math.max(1, Number.parseInt(String(poolSlots), 10) || 0);
  if (availableCredentials === null || availableCredentials === undefined || availableCredentials === '') {
    return parsedPoolSlots;
  }
  const parsedAvailableCredentials = Number.parseInt(String(availableCredentials), 10);
  if (Number.isNaN(parsedAvailableCredentials)) {
    return parsedPoolSlots;
  }
  const parsedCredentials = Math.max(0, parsedAvailableCredentials);
  return Math.min(parsedPoolSlots, parsedCredentials);
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
  let configuredMax = DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX;
  let configuredMaxSource = 'internal default';
  if (
    watcherConfig.maxConcurrentFirstPassReviewers !== undefined
    && watcherConfig.maxConcurrentFirstPassReviewers !== null
  ) {
    configuredMax = watcherConfig.maxConcurrentFirstPassReviewers;
    configuredMaxSource = 'watcherConfig.maxConcurrentFirstPassReviewers';
  } else if (
    watcherConfig.reviewerPoolMaxConcurrent !== undefined
    && watcherConfig.reviewerPoolMaxConcurrent !== null
  ) {
    configuredMax = watcherConfig.reviewerPoolMaxConcurrent;
    configuredMaxSource = 'watcherConfig.reviewerPoolMaxConcurrent';
  }
  const cfgMax = _resolveFirstPassPoolMaxFromCfg(env, { topPath, modulePaths, loaderImpl });
  const maxConcurrent = normalizeFirstPassReviewerPoolMax(
    cfgMax,
    {
      fallback: parsePositiveInteger(configuredMax, DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX),
      fallbackSource: configuredMaxSource,
      logger,
    }
  );
  return {
    enabled,
    maxConcurrent: enabled ? maxConcurrent : 1,
  };
}

function resolveReviewLaneConfig({
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
    contextKey: 'watcher.review_lane_min_share',
  });
  const burstRaw = cfg.get(
    'watcher.review_lane_first_pass_burst_limit',
    DEFAULT_REVIEW_LANE_FIRST_PASS_BURST_LIMIT,
  );
  const shareRaw = cfg.get('watcher.review_lane_min_share', DEFAULT_REVIEW_LANE_MIN_SHARE);
  const urgentRaw = cfg.get(
    'watcher.review_lane_first_pass_urgent_age_ms',
    DEFAULT_REVIEW_LANE_FIRST_PASS_URGENT_AGE_MS,
  );
  return {
    firstPassBurstLimit: parsePositiveInteger(burstRaw, DEFAULT_REVIEW_LANE_FIRST_PASS_BURST_LIMIT),
    minShare: parseBoundedFloat(shareRaw, DEFAULT_REVIEW_LANE_MIN_SHARE, { min: 0, max: 0.5 }),
    firstPassUrgentAgeMs: parsePositiveInteger(urgentRaw, DEFAULT_REVIEW_LANE_FIRST_PASS_URGENT_AGE_MS),
  };
}

function parseSortTimeMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function reviewerDispatchSortTimeMs(candidate) {
  return parseSortTimeMs(candidate?.subject?.createdAt) ?? Number.MAX_SAFE_INTEGER;
}

// A PR that has never had a review posted outranks one that already has.
//
// The queue was previously ordered by PR createdAt alone. With a bounded pool
// (6 slots) and re-reviews re-entering the queue every poll, the oldest PRs win
// every cycle -- and the oldest PRs are exactly the ones already carrying the
// most review attempts. A newly opened PR sorts to the BACK by construction and
// waits for every older PR to be serviced first.
//
// Measured on 2026-09-04 with 14 open PRs: median time-to-first-review 36.1
// minutes, max 51.5, and the three newest PRs had no review at all while two
// older PRs had accumulated 8 review attempts each. That is starvation, not
// load: first-pass work is the scarce, latency-sensitive product, and re-review
// churn was crowding it out.
//
// Ordering first-pass ahead of re-review is a bounded priority change: nothing
// is dropped, and within each tier the previous oldest-first fairness is
// preserved exactly. When persistent lane state is enabled,
// watcher.review_lane_first_pass_burst_limit gives rereviews a floor after the
// configured number of real first-pass dispatches.
function reviewerDispatchIsFirstPass(candidate) {
  const current = candidate?.current;
  if (!current) return true;
  // Rereview requests clear posted_at while waiting for the next reviewer pass,
  // so rereview_requested_at owns the lane decision for those pending rows.
  if (current.rereview_requested_at) return false;
  // A non-rereview row can exist before anything is posted (claimed, retrying,
  // failed). `posted_at` is what marks a first-pass review as delivered.
  return !current.posted_at;
}

function reviewerDispatchTierRank(candidate) {
  if (candidate?.wakePriority === true) return 0;
  return reviewerDispatchIsFirstPass(candidate) ? 1 : 2;
}

function compareReviewerDispatchCandidates(a, b) {
  const tierDelta = reviewerDispatchTierRank(a) - reviewerDispatchTierRank(b);
  if (tierDelta !== 0) return tierDelta;
  const timeDelta = reviewerDispatchSortTimeMs(a) - reviewerDispatchSortTimeMs(b);
  if (timeDelta !== 0) return timeDelta;
  const repoDelta = String(a?.repoPath || '').localeCompare(String(b?.repoPath || ''));
  if (repoDelta !== 0) return repoDelta;
  return Number(a?.prNumber || 0) - Number(b?.prNumber || 0);
}

function sortReviewerDispatchCandidates(candidates) {
  return [...candidates].sort(compareReviewerDispatchCandidates);
}

function createReviewerLaneState({
  firstPassBurstLimit = DEFAULT_REVIEW_LANE_FIRST_PASS_BURST_LIMIT,
  minShare = DEFAULT_REVIEW_LANE_MIN_SHARE,
  firstPassUrgentAgeMs = DEFAULT_REVIEW_LANE_FIRST_PASS_URGENT_AGE_MS,
} = {}) {
  return {
    firstPassBurstLimit: parsePositiveInteger(
      firstPassBurstLimit,
      DEFAULT_REVIEW_LANE_FIRST_PASS_BURST_LIMIT,
    ),
    minShare: parseBoundedFloat(minShare, DEFAULT_REVIEW_LANE_MIN_SHARE, { min: 0, max: 0.5 }),
    firstPassUrgentAgeMs: parsePositiveInteger(
      firstPassUrgentAgeMs,
      DEFAULT_REVIEW_LANE_FIRST_PASS_URGENT_AGE_MS,
    ),
    firstPassStartsSinceRereview: 0,
  };
}

const PERSISTENT_REVIEWER_LANE_STATE = createReviewerLaneState();

function refreshPersistentReviewerLaneState() {
  const reviewerLaneConfig = resolveReviewLaneConfig();
  PERSISTENT_REVIEWER_LANE_STATE.firstPassBurstLimit = reviewerLaneConfig.firstPassBurstLimit;
  PERSISTENT_REVIEWER_LANE_STATE.minShare = reviewerLaneConfig.minShare;
  PERSISTENT_REVIEWER_LANE_STATE.firstPassUrgentAgeMs = reviewerLaneConfig.firstPassUrgentAgeMs;
  return PERSISTENT_REVIEWER_LANE_STATE;
}

function reviewerDispatchPassKind(candidate) {
  return reviewerDispatchIsFirstPass(candidate) ? 'first-pass' : 'rereview';
}

function pendingLaneCounts(entries) {
  let firstPass = 0;
  let rereview = 0;
  for (const entry of entries) {
    if (entry.started) continue;
    if (reviewerDispatchIsFirstPass(entry.candidate)) firstPass += 1;
    else rereview += 1;
  }
  return { firstPass, rereview };
}

function reviewerLaneFloor({
  concurrencyLimit,
  minShare,
} = {}) {
  const slots = Math.max(1, Number.parseInt(String(concurrencyLimit), 10) || 0);
  const share = parseBoundedFloat(minShare, DEFAULT_REVIEW_LANE_MIN_SHARE, { min: 0, max: 0.5 });
  if (share <= 0) return 0;
  return Math.max(1, Math.min(slots, Math.ceil(slots * share)));
}

function oldestFirstPassAgeMs(entries, nowMs = Date.now()) {
  let oldest = null;
  for (const entry of entries) {
    if (entry.started || !reviewerDispatchIsFirstPass(entry.candidate)) continue;
    const age = reviewerDispatchPendingAgeMs(entry.candidate, nowMs)
      ?? reviewerDispatchAgeMs(entry.candidate, nowMs);
    if (age === null) continue;
    oldest = oldest === null ? age : Math.max(oldest, age);
  }
  return oldest;
}

function laneFairnessPreference({
  a,
  b,
  laneState = null,
  laneCounts = null,
  laneStarts = null,
  concurrencyLimit = DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX,
  pendingFirstPassAgeMs = null,
} = {}) {
  const counts = laneCounts || { firstPass: 0, rereview: 0 };
  if (!(counts.firstPass > 0 && counts.rereview > 0)) return 0;
  const aFirst = reviewerDispatchIsFirstPass(a.candidate);
  const bFirst = reviewerDispatchIsFirstPass(b.candidate);
  if (aFirst === bFirst) return 0;

  const minShare = parseBoundedFloat(
    laneState?.minShare,
    DEFAULT_REVIEW_LANE_MIN_SHARE,
    { min: 0, max: 0.5 },
  );
  const baseFloor = reviewerLaneFloor({ concurrencyLimit, minShare });
  if (baseFloor > 0) {
    const starts = laneStarts || { firstPass: 0, rereview: 0 };
    const urgentAgeMs = parsePositiveInteger(
      laneState?.firstPassUrgentAgeMs,
      DEFAULT_REVIEW_LANE_FIRST_PASS_URGENT_AGE_MS,
    );
    const firstPassAgeMs = Number.isFinite(Number(pendingFirstPassAgeMs))
      ? Number(pendingFirstPassAgeMs)
      : null;
    const firstPassFloor = firstPassAgeMs !== null && firstPassAgeMs >= urgentAgeMs
      ? Math.min(concurrencyLimit, Math.max(baseFloor, Math.ceil(concurrencyLimit / 2)))
      : baseFloor;
    if (starts.firstPass < firstPassFloor && starts.rereview >= baseFloor) {
      return aFirst ? -1 : 1;
    }
    if (starts.rereview < baseFloor && starts.firstPass >= firstPassFloor) {
      const burstLimit = parsePositiveInteger(
        laneState?.firstPassBurstLimit,
        DEFAULT_REVIEW_LANE_FIRST_PASS_BURST_LIMIT,
      );
      const persistedStreak =
        Math.max(0, Number.parseInt(String(laneState?.firstPassStartsSinceRereview || 0), 10) || 0);
      const admittedStreak =
        Math.max(0, Number.parseInt(String(starts.firstPass || 0), 10) || 0);
      if (persistedStreak + admittedStreak < burstLimit) return 0;
      return aFirst ? 1 : -1;
    }
  }

  return 0;
}

function compareReviewerDispatchEntries(
  a,
  b,
  {
    laneState = null,
    laneCounts = null,
    laneStarts = null,
    concurrencyLimit = DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX,
    pendingFirstPassAgeMs = null,
  } = {},
) {
  const aWake = a?.candidate?.wakePriority === true;
  const bWake = b?.candidate?.wakePriority === true;
  if (aWake !== bWake) return aWake ? -1 : 1;

  const counts = laneCounts || { firstPass: 0, rereview: 0 };
  const bothLanesPending = counts.firstPass > 0 && counts.rereview > 0;
  if (bothLanesPending) {
    const fairness = laneFairnessPreference({
      a,
      b,
      laneState,
      laneCounts: counts,
      laneStarts,
      concurrencyLimit,
      pendingFirstPassAgeMs,
    });
    if (fairness !== 0) return fairness;

    const burstLimit = parsePositiveInteger(
      laneState?.firstPassBurstLimit,
      DEFAULT_REVIEW_LANE_FIRST_PASS_BURST_LIMIT,
    );
    const streak = Math.max(0, Number.parseInt(String(laneState?.firstPassStartsSinceRereview || 0), 10) || 0);
    const preferRereview = streak >= burstLimit;
    const aFirst = reviewerDispatchIsFirstPass(a.candidate);
    const bFirst = reviewerDispatchIsFirstPass(b.candidate);
    if (aFirst !== bFirst) {
      return preferRereview
        ? (aFirst ? 1 : -1)
        : (aFirst ? -1 : 1);
    }
  }

  return compareReviewerDispatchCandidates(a.candidate, b.candidate);
}

function orderPendingReviewerDispatchEntries(
  entries,
  {
    laneState = null,
    laneStarts = null,
    concurrencyLimit = DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX,
    nowMs = Date.now(),
  } = {},
) {
  const laneCounts = pendingLaneCounts(entries);
  const pendingFirstPassAgeMs = oldestFirstPassAgeMs(
    entries,
    Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now(),
  );
  return [...entries].sort((a, b) => compareReviewerDispatchEntries(a, b, {
    laneState,
    laneCounts,
    laneStarts,
    concurrencyLimit,
    pendingFirstPassAgeMs,
  }));
}

function recordReviewerLaneStart(candidate, laneState = null) {
  if (!laneState) return;
  if (reviewerDispatchPassKind(candidate) === 'first-pass') {
    laneState.firstPassStartsSinceRereview =
      Math.max(0, Number.parseInt(String(laneState.firstPassStartsSinceRereview || 0), 10) || 0) + 1;
  } else {
    laneState.firstPassStartsSinceRereview = 0;
  }
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

function reviewerDispatchPendingAgeMs(candidate, nowMs = Date.now()) {
  if (
    typeof candidate?.pendingSinceMs === 'number'
    && Number.isFinite(candidate.pendingSinceMs)
  ) {
    return Math.max(0, nowMs - candidate.pendingSinceMs);
  }
  const pendingSince = parseSortTimeMs(candidate?.pendingSince);
  if (pendingSince !== null) return Math.max(0, nowMs - pendingSince);
  return null;
}

function safeReviewerNowMs(now = () => Date.now()) {
  try {
    const currentNowMs = Number(now());
    return Number.isFinite(currentNowMs) ? currentNowMs : Date.now();
  } catch {
    return Date.now();
  }
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

function logReviewerDispatchDeferred(candidate, {
  logger = console,
  reason = 'not-started',
  nowMs = Date.now(),
} = {}) {
  const waitMs = reviewerDispatchWaitMs(candidate, nowMs);
  const waitText = waitMs === null ? 'unknown' : String(Math.round(waitMs));
  logger?.warn?.(
    `[watcher] reviewer dispatch DEFERRED for ` +
      `${candidate?.repoPath || 'unknown'}#${candidate?.prNumber || 'unknown'}: ` +
      `reason=${reason} reviewer=${candidate?.reviewerModel || 'unknown'} ` +
      `pass_kind=${reviewerDispatchPassKind(candidate)} wait_ms=${waitText}`
  );
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

// Fetch the number of gemini credentials that can currently serve a concurrent
// checkout (registered credentials not in a real-429 cooldown) from the broker's
// /quota endpoint. This is the DYNAMIC source for the gemini dispatch cap — the
// value lives in the broker/quota DB, never hardcoded here. Failures return
// null; the resolver below treats that as a conservative single-Gemini cap so a
// telemetry hiccup cannot fan out into multiple 409-bound reviewer timeouts.
async function fetchGeminiCredentialConcurrency({
  brokerUrl,
  secret = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 4000,
} = {}) {
  if (!brokerUrl || typeof fetchImpl !== 'function') return null;
  const url = `${String(brokerUrl).replace(/\/+$/, '')}/quota?provider=gemini`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: 'application/json' };
    if (secret) headers.Authorization = `Bearer ${secret}`;
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    if (!res || !res.ok) return null;
    const body = await res.json();
    const credentials = Array.isArray(body?.credentials) ? body.credentials : null;
    if (credentials === null) return null;
    // Count credentials NOT in a real quota cooldown — those are the ones that
    // can hold a concurrent checkout lease right now.
    return credentials.filter((credential) => !credential?.is_cooled).length;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Resolve the concurrent-GEMINI-reviewer cap. Gemini reviewers all check out
// from a shared, typically single-account credential pool, so dispatching more
// concurrent gemini reviewers than gemini credentials just makes them contend on
// the checkout lease and lose — the broker returns 409, and older callers then
// fell into a serialized 30-minute fallback lock. `geminiCredentialConcurrency`
// is the live broker credential count (see fetchGeminiCredentialConcurrency).
// `null`/`''`/malformed => one Gemini at a time (safe degraded mode); a real
// count caps gemini in-flight at min(count, pool ceiling). 0 usable credentials
// => gemini simply does not dispatch this tick (graceful — no spin, retried next
// tick).
function resolveGeminiDispatchConcurrencyLimit({ geminiCredentialConcurrency = null, ceiling } = {}) {
  const cap = Math.max(1, Number.parseInt(String(ceiling), 10) || 1);
  if (
    geminiCredentialConcurrency === null
    || geminiCredentialConcurrency === undefined
    || geminiCredentialConcurrency === ''
  ) {
    return Math.min(cap, 1);
  }
  const parsed = Number.parseInt(String(geminiCredentialConcurrency), 10);
  if (Number.isNaN(parsed)) return Math.min(cap, 1);
  return Math.min(cap, Math.max(0, parsed));
}

function activeReviewerCountForModel(activeReviewerCounts, model) {
  const normalizedModel = String(model || '').trim().toLowerCase();
  if (!normalizedModel || !activeReviewerCounts) return 0;
  if (activeReviewerCounts instanceof Map) {
    return Math.max(0, Number.parseInt(String(activeReviewerCounts.get(normalizedModel) || 0), 10) || 0);
  }
  if (typeof activeReviewerCounts === 'object') {
    return Math.max(0, Number.parseInt(String(activeReviewerCounts[normalizedModel] || 0), 10) || 0);
  }
  return 0;
}

function countActiveReviewerSpawnsByModel(activeReviewerSpawns) {
  const counts = new Map();
  for (const record of activeReviewerSpawns?.values?.() || []) {
    const model = String(record?.reviewerModel || '').trim().toLowerCase();
    if (model) counts.set(model, (counts.get(model) || 0) + 1);
  }
  return counts;
}

function reviewerDispatchPrKey({ repo, prNumber } = {}) {
  const normalizedRepo = String(repo || '').trim().toLowerCase();
  const normalizedPr = Number(prNumber);
  if (!normalizedRepo || !Number.isFinite(normalizedPr)) return null;
  return `${normalizedRepo}#${normalizedPr}`;
}

function incrementReviewerModelCount(counts, model) {
  const normalizedModel = String(model || '').trim().toLowerCase();
  if (!normalizedModel) return;
  counts.set(normalizedModel, (counts.get(normalizedModel) || 0) + 1);
}

function summarizeDeferredReviewerReasons(deferredReasons = []) {
  const counts = new Map();
  for (const reasonRow of deferredReasons) {
    const reason = reasonRow?.reason || 'unknown';
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()].map(([reason, count]) => `${reason}:${count}`).join(',');
}

function createDetachedReviewerDispatchTracker({ activeReviewerSpawns } = {}) {
  const detachedReviewerDispatches = new Map();
  return {
    activeCounts() {
      const counts = countActiveReviewerSpawnsByModel(activeReviewerSpawns);
      const registeredPrKeys = new Set();
      for (const record of activeReviewerSpawns?.values?.() || []) {
        const key = reviewerDispatchPrKey({ repo: record?.repo, prNumber: record?.pr });
        if (key) registeredPrKeys.add(key);
      }
      for (const record of detachedReviewerDispatches.values()) {
        const key = reviewerDispatchPrKey({ repo: record?.repo, prNumber: record?.prNumber });
        if (!key || registeredPrKeys.has(key)) continue;
        incrementReviewerModelCount(counts, record?.reviewerModel);
      }
      return counts;
    },
    track({ candidate, promise } = {}) {
      const repo = String(candidate?.repoPath || '').trim();
      const prNumber = Number(candidate?.prNumber);
      const reviewerModel = String(candidate?.reviewerModel || '').trim().toLowerCase();
      if (!repo || !Number.isFinite(prNumber) || !reviewerModel || !promise) return;
      const token = Symbol('detached-reviewer-dispatch');
      detachedReviewerDispatches.set(token, { repo, prNumber, reviewerModel });
      Promise.resolve(promise)
        .finally(() => {
          detachedReviewerDispatches.delete(token);
        })
        .catch(() => {});
    },
  };
}

async function runBoundedReviewerDispatchQueue(candidates, {
  maxConcurrent = DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX,
  availableCredentials = null,
  geminiCredentialConcurrency = null,
  activeReviewerCounts = null,
  laneState = null,
  usePersistentReviewerLaneState = false,
  maxThrownFailures = 1,
  singleWave = false,
  singleWaveSettleGraceMs = DEFAULT_SINGLE_WAVE_SETTLE_GRACE_MS,
  onCandidateStarted = null,
  logger = console,
  now = () => Date.now(),
  waitWarnMs = DEFAULT_REVIEWER_DISPATCH_WAIT_WARN_MS,
  splitPostReviewSettlement = false,
} = {}) {
  const concurrencyLimit = resolveReviewerCredentialConcurrencyLimit({
    poolSlots: maxConcurrent,
    availableCredentials,
  });
  if (concurrencyLimit < 1) {
    const deferredCandidates = Array.isArray(candidates) ? [...candidates] : [];
    const nowMs = Number(now());
    const resolvedNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    for (const candidate of deferredCandidates) {
      logReviewerDispatchDeferred(candidate, {
        logger,
        reason: 'reviewer-pool-credential-capacity-zero',
        nowMs: resolvedNowMs,
      });
    }
    const deferredReasons = deferredCandidates.map((candidate) => ({
      repoPath: candidate?.repoPath || null,
      prNumber: candidate?.prNumber || null,
      reviewerModel: candidate?.reviewerModel || null,
      passKind: reviewerDispatchPassKind(candidate),
      reason: 'reviewer-pool-credential-capacity-zero',
    }));
    return {
      dispatched: 0,
      maxObservedConcurrency: 0,
      deferred: deferredCandidates.length,
      deferredCandidates,
      deferredReasons,
      deferredReasonSummary: summarizeDeferredReviewerReasons(deferredReasons),
    };
  }
  const geminiConcurrencyLimit = resolveGeminiDispatchConcurrencyLimit({
    geminiCredentialConcurrency,
    ceiling: concurrencyLimit,
  });
  const thrownFailureLimit = Math.max(1, Number.parseInt(String(maxThrownFailures), 10) || 0);
  const queue = sortReviewerDispatchCandidates(candidates);
  const pending = queue.map((candidate) => ({ candidate, started: false }));
  const activeLaneState = laneState || (
    usePersistentReviewerLaneState ? refreshPersistentReviewerLaneState() : null
  );
  const active = new Set();
  const activeRecords = new Map();
  const errors = [];
  const laneStarts = { firstPass: 0, rereview: 0 };
  let maxObservedConcurrency = 0;
  let attempted = 0;
  let dispatched = 0;
  let activeGemini = activeReviewerCountForModel(activeReviewerCounts, 'gemini');
  let initialWaveClosed = false;

  const isGeminiCandidate = (candidate) =>
    String(candidate?.reviewerModel || '').toLowerCase() === 'gemini';

  const dispatchWasSkipped = (result) =>
    result && typeof result === 'object' && result.dispatched === false;

  const recordLaneAdmission = (candidate) => {
    const key = reviewerDispatchIsFirstPass(candidate) ? 'firstPass' : 'rereview';
    laneStarts[key] += 1;
  };

  const refundLaneAdmission = (candidate) => {
    const key = reviewerDispatchIsFirstPass(candidate) ? 'firstPass' : 'rereview';
    laneStarts[key] = Math.max(0, laneStarts[key] - 1);
  };

  const countDispatch = (promise) => {
    const record = activeRecords.get(promise);
    if (!record || record.counted) return;
    record.counted = true;
    dispatched += 1;
  };

  async function start(candidate) {
    const gemini = isGeminiCandidate(candidate);
    try {
      if (gemini) activeGemini += 1;
      const currentNowMs = Number(now());
      const resolvedNowMs = Number.isFinite(currentNowMs) ? currentNowMs : Date.now();
      logReviewerDispatchWait(candidate, { logger, nowMs: resolvedNowMs, waitWarnMs });
      if (!splitPostReviewSettlement) return await candidate.run();

      // Admission capacity covers model execution and the durable post
      // decision, not token accounting, follow-up bookkeeping, or merge
      // confirmation.  The candidate calls releaseAdmissionCapacity only
      // after its review row has been durably settled.  Keep the continuation
      // alive (and observed) while returning the scarce slot immediately.
      let releaseAdmissionCapacity;
      let rejectAdmissionCapacity;
      const admission = new Promise((resolve, reject) => {
        releaseAdmissionCapacity = resolve;
        rejectAdmissionCapacity = reject;
      });
      let released = false;
      const release = (value = { dispatched: true }) => {
        if (released) return;
        released = true;
        releaseAdmissionCapacity(value);
      };
      candidate.admissionReleaseCapacity = release;
      const settlement = Promise.resolve()
        .then(() => candidate.run())
        .then((result) => {
          release(result);
          return result;
        })
        .catch((err) => {
          if (!released) {
            released = true;
            rejectAdmissionCapacity(err);
            return;
          }
          logger?.error?.(
            `[watcher] deferred reviewer settlement failed for ${candidate.repoPath}#${candidate.prNumber}:`,
            err?.message || err,
          );
        })
        .finally(() => {
          delete candidate.admissionReleaseCapacity;
        });
      // A process-lifetime continuation registry is unnecessary here: the
      // candidate's own durable row is the restart handle. This catch ensures
      // a late rejection never becomes unhandled in the current process.
      settlement.catch(() => {});
      return await admission;
    } catch (err) {
      errors.push(err);
      logger?.error?.(
        `[watcher] reviewer dispatch task failed for ${candidate.repoPath}#${candidate.prNumber}:`,
        err?.message || err
      );
    } finally {
      if (gemini) activeGemini -= 1;
    }
  }

  // Next pending entry startable now: overall pool has room AND, for gemini
  // candidates, the gemini in-flight cap is not yet reached. A capped gemini
  // head does NOT block codex/claude candidates behind it (no head-of-line
  // stall on reviewers that don't touch the gemini pool).
  const recordDeferredReason = (entry, reason) => {
    if (!entry || entry.started || entry.deferredReason) return;
    entry.deferredReason = reason;
  };

  const nextStartableEntry = () => {
    const counts = pendingLaneCounts(pending);
    const bothLanesPending = counts.firstPass > 0 && counts.rereview > 0;
    if (active.size >= concurrencyLimit) {
      const resolvedNowMs = bothLanesPending ? safeReviewerNowMs(now) : undefined;
      for (const entry of orderPendingReviewerDispatchEntries(pending, {
        laneState: activeLaneState,
        laneStarts,
        concurrencyLimit,
        nowMs: resolvedNowMs,
      })) {
        if (!entry.started) recordDeferredReason(entry, 'reviewer-pool-saturated');
      }
      return null;
    }
    const resolvedNowMs = bothLanesPending ? safeReviewerNowMs(now) : undefined;
    for (const entry of orderPendingReviewerDispatchEntries(pending, {
      laneState: activeLaneState,
      laneStarts,
      concurrencyLimit,
      nowMs: resolvedNowMs,
    })) {
      if (entry.started) continue;
      if (isGeminiCandidate(entry.candidate) && activeGemini >= geminiConcurrencyLimit) {
        recordDeferredReason(
          entry,
          geminiConcurrencyLimit < 1
            ? 'gemini-credential-concurrency-zero'
            : 'gemini-credential-concurrency-saturated'
        );
        continue;
      }
      return entry;
    }
    return null;
  };

  const hasUnstarted = () => pending.some((entry) => !entry.started);
  const deferReasonFor = (candidate) => {
    if (isGeminiCandidate(candidate) && geminiConcurrencyLimit < 1) {
      return 'gemini-credential-concurrency-zero';
    }
    if (isGeminiCandidate(candidate) && activeGemini >= geminiConcurrencyLimit) {
      return 'gemini-credential-concurrency-saturated';
    }
    if (initialWaveClosed) return 'single-wave-deferred';
    if (active.size >= concurrencyLimit) return 'reviewer-pool-saturated';
    return 'not-started';
  };

  while (
    (errors.length < thrownFailureLimit && hasUnstarted() && !initialWaveClosed)
    || active.size > 0
  ) {
    const attemptedBeforeStart = attempted;
    let entry;
    while (
      errors.length < thrownFailureLimit
      && !initialWaveClosed
      && (entry = nextStartableEntry()) !== null
    ) {
      entry.started = true;
      const startedEntry = entry;
      recordLaneAdmission(startedEntry.candidate);
      const promise = start(startedEntry.candidate);
      if (typeof onCandidateStarted === 'function') {
        try {
          onCandidateStarted({ candidate: startedEntry.candidate, promise });
        } catch (err) {
          logger?.warn?.(
            `[watcher] reviewer dispatch start observer failed for ` +
              `${startedEntry.candidate?.repoPath || 'unknown'}#${startedEntry.candidate?.prNumber || 'unknown'}: ` +
              `${err?.message || err}`
          );
        }
      }
      attempted += 1;
      active.add(promise);
      activeRecords.set(promise, { counted: false });
      promise.then((result) => {
        if (!dispatchWasSkipped(result)) {
          recordReviewerLaneStart(startedEntry.candidate, activeLaneState);
          countDispatch(promise);
        }
        refundLaneAdmission(startedEntry.candidate);
      }).finally(() => {
        active.delete(promise);
        activeRecords.delete(promise);
      });
      maxObservedConcurrency = Math.max(maxObservedConcurrency, active.size);
      const remainingLaneCounts = pendingLaneCounts(pending);
      if (
        concurrencyLimit > 1
        && remainingLaneCounts.firstPass > 0
        && remainingLaneCounts.rereview > 0
      ) {
        await Promise.resolve();
        await Promise.resolve();
      }
    }
    if (singleWave && !splitPostReviewSettlement && attempted > attemptedBeforeStart) {
      // The watcher needs a dispatch *wave*, not a full batch drain. Some
      // runtimes await reviewer completion inside candidate.run(), so admitting
      // a new reviewer every time a slot frees can serialize an entire backlog
      // ahead of posted-review maintenance and hammer closeout.
      const settleGraceMs = Math.max(
        0,
        Number.parseInt(String(singleWaveSettleGraceMs), 10) || 0,
      );
      if (active.size > 0) {
        let settleTimer = null;
        try {
          await Promise.race([
            Promise.all([...active]),
            new Promise((resolve) => {
              settleTimer = setTimeout(resolve, settleGraceMs);
            }),
          ]);
        } finally {
          if (settleTimer) clearTimeout(settleTimer);
        }
      }
      if (active.size > 0) {
        initialWaveClosed = true;
        for (const entry of pending) {
          if (!entry.started) recordDeferredReason(entry, 'single-wave-deferred');
        }
        logger?.log?.(
          `[watcher] reviewer dispatch single-wave detached after launch wave: ` +
            `active=${active.size} deferred=${pending.filter((item) => !item.started).length}`
        );
        break;
      }
      if (dispatched > 0) {
        initialWaveClosed = true;
      }
    }
    if (active.size > 0) {
      await Promise.race(active);
    } else {
      // Nothing in flight and nothing startable (only gemini candidates remain
      // and the gemini cap is 0, or a full pool of gemini is blocked with none
      // active to free the cap). Leave the remainder for the next tick rather
      // than spin.
      if (hasUnstarted() && !initialWaveClosed && nextStartableEntry() !== null) {
        continue;
      }
      break;
    }
  }

  if (errors.length > 0) {
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, `${errors.length} reviewer dispatch tasks failed`);
  }
  const deferredEntries = orderPendingReviewerDispatchEntries(pending, {
    laneState: activeLaneState,
    laneStarts,
    concurrencyLimit,
    nowMs: safeReviewerNowMs(now),
  })
    .filter((entry) => !entry.started);
  const resolvedNowMs = Date.now();
  const deferredReasons = deferredEntries.map((entry) => ({
    repoPath: entry.candidate?.repoPath || null,
    prNumber: entry.candidate?.prNumber || null,
    reviewerModel: entry.candidate?.reviewerModel || null,
    passKind: reviewerDispatchPassKind(entry.candidate),
    reason: entry.deferredReason || deferReasonFor(entry.candidate),
  }));
  for (let index = 0; index < deferredEntries.length; index += 1) {
    logReviewerDispatchDeferred(deferredEntries[index].candidate, {
      logger,
      reason: deferredReasons[index].reason,
      nowMs: resolvedNowMs,
    });
  }
  return {
    dispatched,
    maxObservedConcurrency,
    deferred: deferredEntries.length,
    deferredCandidates: deferredEntries.map((entry) => entry.candidate),
    deferredReasons,
    deferredReasonSummary: summarizeDeferredReviewerReasons(deferredReasons),
  };
}

export {
  DEFAULT_FIRST_PASS_REVIEWER_POOL_MAX,
  DEFAULT_REVIEW_LANE_FIRST_PASS_BURST_LIMIT,
  DEFAULT_REVIEW_LANE_FIRST_PASS_URGENT_AGE_MS,
  DEFAULT_REVIEW_LANE_MIN_SHARE,
  DEFAULT_REVIEWER_DISPATCH_WAIT_WARN_MS,
  MAX_FIRST_PASS_REVIEWER_POOL_MAX,
  DEFAULT_REVIEWER_MEMORY_SAMPLE_TTL_MS,
  DEFAULT_SINGLE_WAVE_SETTLE_GRACE_MS,
  compareReviewerDispatchCandidates,
  countActiveReviewerSpawnsByModel,
  createDetachedReviewerDispatchTracker,
  createReviewerLaneState,
  createReviewerMemoryAdmissionSampler,
  logReviewerDispatchWait,
  reserveReviewerMemoryAdmission,
  fetchGeminiCredentialConcurrency,
  resolveGeminiDispatchConcurrencyLimit,
  resolveReviewerCredentialConcurrencyLimit,
  resolveReviewerMemoryPressureConfig,
  resolveFirstPassReviewerPoolConfig,
  resolveReviewLaneConfig,
  reviewerLaneFloor,
  runBoundedReviewerDispatchQueue,
  sortReviewerDispatchCandidates,
  reviewerDispatchIsFirstPass,
  reviewerDispatchPassKind,
};
