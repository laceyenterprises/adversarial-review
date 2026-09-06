/**
 * Measured TTM budget derivation.
 *
 * The rounds-aware time-to-merge budget used to be three literals: 15 minutes
 * of base plus 10 minutes per remediation round. Nothing measured produced
 * those numbers, and the pipeline has never met them. Measured on the
 * production host 2026-09-06 over the last 200 merges in `reviews.db`:
 *
 *   p50 time-to-merge = 97m      p90 = 270m      p95 = 366m
 *
 * against a budget that ranged 15-55m. A median PR took ~2x the most generous
 * budget and ~7x the tightest, so essentially every open PR breached, the
 * `review:ttm_budget_breach` finding paged permanently, and operators learned
 * to ignore it. On 2026-09-05 a genuinely deadlocked PR (agent-os#6288,
 * stranded 3h44m on a closer-lease self-deadlock) was indistinguishable from
 * the fifteen PRs that were merely moving at normal speed.
 *
 * A budget with no stated derivation is an aspiration, and it drifts out of
 * date exactly the way that one did. So this module derives the budget FROM
 * the distribution, every tick, and carries the provenance with it:
 *
 *   1. Read the recent merged-PR sample from `reviews.db`
 *      (`readMergedTtmSamples`): elapsed minutes plus completed review rounds.
 *   2. Bucket by round count, take the configured percentile of each bucket,
 *      and weighted-least-squares fit `base + rounds * per_round` across the
 *      buckets (`fitTtmBudgetModel`). Nothing here is a literal: change the
 *      distribution and the budget moves with it.
 *   3. Scale the fitted budget by measured queue pressure
 *      (`queuePressureMultiplier`), because latency on this host is
 *      load-correlated and a fixed threshold on a variable-load host is the
 *      same defect already fixed in the boot-stagger budget (agent-os#6241)
 *      and the reviewer timeout multiplier (adversarial-review#946).
 *
 * The percentile default is p90 and that choice is deliberate. This budget now
 * feeds a TREND, not a page: at p90 roughly one in ten normally-progressing
 * PRs trips it, which is informative on a graph and intolerable on a pager.
 * "Stuck" is a separate, non-budget signal owned by `ttm-tracker.mjs`.
 *
 * `blind`, never false-clean: if the distribution cannot be read,
 * `readMergedTtmSamples` throws `TtmDistributionUnreadableError` rather than
 * returning an empty sample that would silently fit a budget of zero (which
 * would flag everything) or fall back to a seeded budget that claims to be
 * measured. The caller reports blindness; it does not report health.
 *
 * @module ttm-budget-model
 */

/** Percentile of the measured distribution the budget sits at. */
export const DEFAULT_TTM_BUDGET_PERCENTILE = 90;
/** Most recent merges sampled for the fit. */
export const DEFAULT_TTM_FIT_SAMPLE_LIMIT = 200;
/** Below this many merged samples the distribution cannot support a fit. */
export const DEFAULT_TTM_MIN_FIT_SAMPLES = 25;
/** A slope needs at least two distinct round buckets to exist at all. */
export const MIN_ROUND_BUCKETS_FOR_SLOPE = 2;
/** Floors so a degenerate fit can never produce a budget tighter than the
 *  pre-measurement literals it replaced. */
export const TTM_BASE_BUDGET_FLOOR_MINUTES = 15;
export const TTM_PER_ROUND_BUDGET_FLOOR_MINUTES = 5;
/** Queue-pressure multiplier bounds. Floor 1: pressure may widen the measured
 *  budget, never tighten it. Ceiling 3: past this the queue is not "busy", it
 *  is oversubscribed, and widening further would hide a throughput deficit
 *  behind a budget that always passes. */
export const MIN_QUEUE_PRESSURE_MULTIPLIER = 1;
export const MAX_QUEUE_PRESSURE_MULTIPLIER = 3;

/** Thrown when the merged-PR distribution cannot be read at all (SEN-02
 *  `blind`): the caller must report that it could not look, not that the
 *  pipeline is healthy. */
export class TtmDistributionUnreadableError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'TtmDistributionUnreadableError';
    if (cause) this.cause = cause;
  }
}

function toMs(value) {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Linear-interpolated percentile over a numeric sample.
 * @param {Array<number>} values
 * @param {number} percentileValue 0-100
 * @returns {number|null} null when the sample is empty.
 */
export function percentileOf(values, percentileValue) {
  const sorted = (values || [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (percentileValue / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

/**
 * Group merged samples by completed review-round count and take the configured
 * percentile of each bucket. Returned ascending by round count.
 * @param {Array<{ttmMinutes: number, reviewRounds: number}>} samples
 * @param {number} percentileValue
 */
export function bucketSamplesByRounds(samples, percentileValue) {
  const byRounds = new Map();
  for (const sample of samples || []) {
    const ttm = Number(sample?.ttmMinutes);
    if (!Number.isFinite(ttm) || ttm < 0) continue;
    const rounds = Math.max(0, Math.trunc(Number(sample?.reviewRounds) || 0));
    const bucket = byRounds.get(rounds) || [];
    bucket.push(ttm);
    byRounds.set(rounds, bucket);
  }
  return [...byRounds.entries()]
    .map(([reviewRounds, values]) => ({
      reviewRounds,
      sampleCount: values.length,
      percentileMinutes: percentileOf(values, percentileValue),
      medianMinutes: percentileOf(values, 50),
    }))
    .filter((bucket) => Number.isFinite(bucket.percentileMinutes))
    .sort((a, b) => a.reviewRounds - b.reviewRounds);
}

/**
 * Weighted least-squares fit of `percentileMinutes ~ base + slope * rounds`,
 * weighting each bucket by how many merges it contains so a 1-sample 8-round
 * bucket cannot drag the curve.
 */
function weightedLinearFit(buckets) {
  let sumW = 0;
  let sumWx = 0;
  let sumWy = 0;
  let sumWxy = 0;
  let sumWxx = 0;
  for (const bucket of buckets) {
    const w = bucket.sampleCount;
    const x = bucket.reviewRounds;
    const y = bucket.percentileMinutes;
    sumW += w;
    sumWx += w * x;
    sumWy += w * y;
    sumWxy += w * x * y;
    sumWxx += w * x * x;
  }
  const denominator = sumWxx * sumW - sumWx * sumWx;
  if (!Number.isFinite(denominator) || denominator === 0) return null;
  const slope = (sumWxy * sumW - sumWx * sumWy) / denominator;
  const intercept = (sumWy - slope * sumWx) / sumW;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null;
  return { slope, intercept };
}

/**
 * Derive `{baseBudgetMinutes, perRoundBudgetMinutes}` from a measured sample.
 *
 * @param {Array<{ttmMinutes: number, reviewRounds: number}>} samples
 * @param {Object} [opts]
 * @param {number} [opts.percentile] percentile of the distribution to sit at.
 * @param {number} [opts.minSamples] below this the sample cannot support a fit.
 * @returns {Object} model with a `source` naming exactly how it was derived:
 *   `measured-fit` (percentile curve across >=2 round buckets),
 *   `measured-flat` (enough merges but only one round bucket, so no slope
 *   exists to measure and the per-round floor applies), or
 *   `insufficient-samples` (too few merges to derive anything; `usable` is
 *   false and the caller must not present the budget as measured).
 */
export function fitTtmBudgetModel(samples, {
  percentile = DEFAULT_TTM_BUDGET_PERCENTILE,
  minSamples = DEFAULT_TTM_MIN_FIT_SAMPLES,
} = {}) {
  const usableSamples = (samples || []).filter(
    (sample) => Number.isFinite(Number(sample?.ttmMinutes)) && Number(sample.ttmMinutes) >= 0
  );
  const buckets = bucketSamplesByRounds(usableSamples, percentile);
  const base = {
    percentile,
    minSamples,
    sampleCount: usableSamples.length,
    roundBuckets: buckets,
    observedMedianMinutes: percentileOf(usableSamples.map((s) => s.ttmMinutes), 50),
    observedPercentileMinutes: percentileOf(usableSamples.map((s) => s.ttmMinutes), percentile),
  };

  if (usableSamples.length < minSamples) {
    return {
      ...base,
      source: 'insufficient-samples',
      usable: false,
      baseBudgetMinutes: null,
      perRoundBudgetMinutes: null,
    };
  }

  if (buckets.length < MIN_ROUND_BUCKETS_FOR_SLOPE) {
    // Every merge in the window took the same number of rounds, so the sample
    // contains no evidence about what a round costs. Sit the base on what was
    // measured and apply the per-round floor rather than inventing a slope.
    return {
      ...base,
      source: 'measured-flat',
      usable: true,
      baseBudgetMinutes: Math.max(
        TTM_BASE_BUDGET_FLOOR_MINUTES,
        base.observedPercentileMinutes
      ),
      perRoundBudgetMinutes: TTM_PER_ROUND_BUDGET_FLOOR_MINUTES,
    };
  }

  const fit = weightedLinearFit(buckets);
  if (!fit) {
    return {
      ...base,
      source: 'insufficient-samples',
      usable: false,
      baseBudgetMinutes: null,
      perRoundBudgetMinutes: null,
    };
  }

  return {
    ...base,
    source: 'measured-fit',
    usable: true,
    // Floors only. A measured curve that comes out tighter than the literals
    // it replaced would be a regression to the defect this module exists to
    // remove, and a negative slope is not a thing a remediation round can do.
    baseBudgetMinutes: Math.max(TTM_BASE_BUDGET_FLOOR_MINUTES, fit.intercept),
    perRoundBudgetMinutes: Math.max(TTM_PER_ROUND_BUDGET_FLOOR_MINUTES, fit.slope),
    fitIntercept: fit.intercept,
    fitSlope: fit.slope,
  };
}

/**
 * Reference queue depth the fitted distribution was measured at, via Little's
 * Law: L = lambda * W. Throughput (lambda) and mean latency (W) both come out
 * of the same merged sample, so no extra query and no extra assumption.
 *
 * @returns {number|null} null when the sample spans no time and the reference
 *   cannot be computed (the caller must then apply no pressure at all).
 */
export function referenceQueueDepth(samples) {
  const rows = (samples || []).filter((sample) => Number.isFinite(Number(sample?.ttmMinutes)));
  if (rows.length < 2) return null;
  const mergedMs = rows.map((sample) => toMs(sample.mergedAt)).filter((ms) => ms !== null);
  if (mergedMs.length < 2) return null;
  const windowMinutes = (Math.max(...mergedMs) - Math.min(...mergedMs)) / 60_000;
  if (!(windowMinutes > 0)) return null;
  const throughputPerMinute = mergedMs.length / windowMinutes;
  const meanTtm = rows.reduce((sum, s) => sum + Number(s.ttmMinutes), 0) / rows.length;
  const depth = throughputPerMinute * meanTtm;
  return Number.isFinite(depth) && depth > 0 ? depth : null;
}

/**
 * Graded queue-pressure multiplier, same shape as the reviewer timeout
 * multiplier (`load-aware-timeout.mjs`): floored at the nominal, capped, and
 * scaled by a measured quantity rather than gated on one.
 *
 * The load variable here is queue depth, not CPU. Little's Law says latency
 * scales linearly with depth at fixed throughput, so the multiplier is linear
 * in `open / reference` -- deliberately not a second, differently-shaped
 * latency model.
 *
 * @returns {{multiplier: number, rawPressure: number|null, saturated: boolean,
 *   referenceOpenPrCount: number|null, openPrCount: number}}
 */
export function queuePressureMultiplier({ openPrCount, referenceOpenPrCount } = {}) {
  const open = Math.max(0, Number(openPrCount) || 0);
  const reference = Number(referenceOpenPrCount);
  if (!Number.isFinite(reference) || reference <= 0) {
    return {
      multiplier: MIN_QUEUE_PRESSURE_MULTIPLIER,
      rawPressure: null,
      saturated: false,
      referenceOpenPrCount: null,
      openPrCount: open,
    };
  }
  const rawPressure = open / reference;
  const multiplier = Math.min(
    MAX_QUEUE_PRESSURE_MULTIPLIER,
    Math.max(MIN_QUEUE_PRESSURE_MULTIPLIER, rawPressure)
  );
  return {
    multiplier,
    rawPressure,
    // Saturated means the cap bound the multiplier: the queue is deeper than
    // the widest budget this model will grant. That is a throughput deficit,
    // and it must stay visible instead of being absorbed by a wider budget.
    saturated: rawPressure > MAX_QUEUE_PRESSURE_MULTIPLIER,
    referenceOpenPrCount: reference,
    openPrCount: open,
  };
}

/**
 * Read the recent merged-PR sample used for the fit.
 *
 * @throws {TtmDistributionUnreadableError} when the tables backing the
 *   distribution cannot be queried. Callers report `blind`; they do not
 *   substitute an empty sample, which would read as a clean pipeline.
 */
export function readMergedTtmSamples(db, { limit = DEFAULT_TTM_FIT_SAMPLE_LIMIT } = {}) {
  const sampleLimit = Number.isInteger(Number(limit)) && Number(limit) > 0
    ? Number(limit)
    : DEFAULT_TTM_FIT_SAMPLE_LIMIT;
  let rows;
  try {
    rows = db.prepare(
      `SELECT r.repo                AS repo,
              r.pr_number           AS pr_number,
              r.reviewed_at         AS reviewed_at,
              r.merged_at           AS merged_at,
              (SELECT MAX(p.attempt_number)
                 FROM reviewer_passes p
                WHERE p.repo = r.repo
                  AND p.pr_number = r.pr_number
                  AND p.pass_kind IN ('first-pass', 'rereview')
                  AND p.status = 'completed') AS max_attempt
         FROM reviewed_prs r
        WHERE r.merged_at IS NOT NULL
          AND r.reviewed_at IS NOT NULL
        ORDER BY r.merged_at DESC
        LIMIT ?`
    ).all(sampleLimit);
  } catch (error) {
    throw new TtmDistributionUnreadableError(
      `reviews.db merged-PR distribution is unreadable: ${error?.message || error}`,
      { cause: error }
    );
  }
  const samples = [];
  for (const row of rows) {
    const startMs = toMs(row.reviewed_at);
    const mergedMs = toMs(row.merged_at);
    if (startMs === null || mergedMs === null || mergedMs < startMs) continue;
    samples.push({
      repo: row.repo,
      prNumber: Number(row.pr_number),
      mergedAt: row.merged_at,
      ttmMinutes: (mergedMs - startMs) / 60_000,
      reviewRounds: Math.max(0, (Number(row.max_attempt) || 1) - 1),
    });
  }
  return samples;
}

/**
 * Full derivation: measured percentile curve, scaled by measured queue
 * pressure, with the provenance attached.
 *
 * @param {Array} samples from {@link readMergedTtmSamples}
 * @param {Object} opts
 * @param {number} opts.openPrCount current open reviewed PRs.
 * @returns {Object} `{usable, baseBudgetMinutes, perRoundBudgetMinutes, model,
 *   pressure}`. When `usable` is false the caller keeps its seeded budget and
 *   must say the budget is not measured.
 */
export function deriveTtmBudget(samples, {
  percentile = DEFAULT_TTM_BUDGET_PERCENTILE,
  minSamples = DEFAULT_TTM_MIN_FIT_SAMPLES,
  openPrCount = 0,
} = {}) {
  const model = fitTtmBudgetModel(samples, { percentile, minSamples });
  const pressure = queuePressureMultiplier({
    openPrCount,
    referenceOpenPrCount: referenceQueueDepth(samples),
  });
  if (!model.usable) {
    return {
      usable: false,
      baseBudgetMinutes: null,
      perRoundBudgetMinutes: null,
      model,
      pressure,
    };
  }
  return {
    usable: true,
    baseBudgetMinutes: model.baseBudgetMinutes * pressure.multiplier,
    perRoundBudgetMinutes: model.perRoundBudgetMinutes * pressure.multiplier,
    model,
    pressure,
  };
}
