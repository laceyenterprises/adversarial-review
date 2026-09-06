import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TTM_BUDGET_PERCENTILE,
  MAX_QUEUE_PRESSURE_MULTIPLIER,
  TTM_BASE_BUDGET_FLOOR_MINUTES,
  TTM_PER_ROUND_BUDGET_FLOOR_MINUTES,
  TtmDistributionUnreadableError,
  bucketSamplesByRounds,
  deriveTtmBudget,
  fitTtmBudgetModel,
  percentileOf,
  queuePressureMultiplier,
  readMergedTtmSamples,
  referenceQueueDepth,
} from '../src/ttm-budget-model.mjs';

// The literals the budget used to be. Nothing measured produced them, and the
// pipeline has never met them; they exist here only so the tests can assert
// the derived budget is NOT them.
const LEGACY_BASE_MINUTES = 15;
const LEGACY_PER_ROUND_MINUTES = 10;

/**
 * Synthesise a merge distribution whose TTM is `base + rounds * perRound`
 * with a fixed deterministic spread, so a test can state the curve it fed in
 * and check the curve that comes back out.
 */
function syntheticDistribution({
  base,
  perRound,
  perBucket = 20,
  maxRounds = 4,
  spread = 0.25,
  startMs = Date.parse('2026-09-01T00:00:00.000Z'),
  stepMinutes = 20,
}) {
  const samples = [];
  let index = 0;
  for (let rounds = 0; rounds <= maxRounds; rounds += 1) {
    const centre = base + rounds * perRound;
    for (let i = 0; i < perBucket; i += 1) {
      // Deterministic sweep across [centre*(1-spread), centre*(1+spread)].
      const position = perBucket === 1 ? 0.5 : i / (perBucket - 1);
      samples.push({
        prNumber: 1000 + index,
        mergedAt: new Date(startMs + index * stepMinutes * 60_000).toISOString(),
        ttmMinutes: centre * (1 - spread + 2 * spread * position),
        reviewRounds: rounds,
      });
      index += 1;
    }
  }
  return samples;
}

test('percentileOf interpolates and handles degenerate samples', () => {
  assert.equal(percentileOf([], 90), null);
  assert.equal(percentileOf([42], 90), 42);
  assert.equal(percentileOf([0, 10], 50), 5);
  assert.equal(percentileOf([0, 10, 20, 30, 40], 50), 20);
});

test('buckets carry their own sample count so a 1-merge bucket cannot outvote a 50-merge one', () => {
  const buckets = bucketSamplesByRounds(
    [
      ...Array.from({ length: 50 }, () => ({ ttmMinutes: 60, reviewRounds: 0 })),
      { ttmMinutes: 6000, reviewRounds: 7 },
    ],
    90
  );
  assert.deepEqual(buckets.map((b) => [b.reviewRounds, b.sampleCount]), [[0, 50], [7, 1]]);
});

// ── The core anti-magic-number contract ────────────────────────────────────
// A test that pins the budget to a literal proves nothing: the defect being
// fixed WAS a literal. These assert the budget tracks the distribution.

test('the derived budget is a function of the measured distribution, not a constant', () => {
  const slow = fitTtmBudgetModel(syntheticDistribution({ base: 120, perRound: 50 }), {});
  const fast = fitTtmBudgetModel(syntheticDistribution({ base: 30, perRound: 8 }), {});

  assert.equal(slow.source, 'measured-fit');
  assert.equal(fast.source, 'measured-fit');

  // Each fit recovers the curve it was fed, at the configured percentile
  // (p90 of a +/-25% spread sits at ~1.2x the bucket centre).
  assert.ok(
    Math.abs(slow.baseBudgetMinutes - 120 * 1.2) < 14,
    `slow base ${slow.baseBudgetMinutes} should track the fed 120m curve`
  );
  assert.ok(
    Math.abs(slow.perRoundBudgetMinutes - 50 * 1.2) < 7,
    `slow per-round ${slow.perRoundBudgetMinutes} should track the fed 50m/round curve`
  );

  // And the two differ in the direction the distributions differ.
  assert.ok(slow.baseBudgetMinutes > fast.baseBudgetMinutes * 2);
  assert.ok(slow.perRoundBudgetMinutes > fast.perRoundBudgetMinutes * 2);

  // Neither is the literal it replaced.
  assert.notEqual(slow.baseBudgetMinutes, LEGACY_BASE_MINUTES);
  assert.notEqual(slow.perRoundBudgetMinutes, LEGACY_PER_ROUND_MINUTES);
});

test('shifting the distribution shifts the budget proportionally', () => {
  const oneX = fitTtmBudgetModel(syntheticDistribution({ base: 100, perRound: 40 }), {});
  const twoX = fitTtmBudgetModel(syntheticDistribution({ base: 200, perRound: 80 }), {});
  const ratioBase = twoX.baseBudgetMinutes / oneX.baseBudgetMinutes;
  const ratioSlope = twoX.perRoundBudgetMinutes / oneX.perRoundBudgetMinutes;
  assert.ok(Math.abs(ratioBase - 2) < 0.1, `base ratio ${ratioBase} should be ~2`);
  assert.ok(Math.abs(ratioSlope - 2) < 0.1, `slope ratio ${ratioSlope} should be ~2`);
});

test('the chosen percentile is what moves the budget, and it is stated in the model', () => {
  const samples = syntheticDistribution({ base: 100, perRound: 40 });
  const p50 = fitTtmBudgetModel(samples, { percentile: 50 });
  const p90 = fitTtmBudgetModel(samples, { percentile: 90 });
  assert.equal(p90.percentile, 90);
  assert.equal(p50.percentile, 50);
  assert.ok(p90.baseBudgetMinutes > p50.baseBudgetMinutes);
  assert.equal(fitTtmBudgetModel(samples, {}).percentile, DEFAULT_TTM_BUDGET_PERCENTILE);
});

test('a sample too small to fit is reported unusable rather than fitted anyway', () => {
  const model = fitTtmBudgetModel(
    syntheticDistribution({ base: 100, perRound: 40, perBucket: 2, maxRounds: 1 }),
    {}
  );
  assert.equal(model.source, 'insufficient-samples');
  assert.equal(model.usable, false);
  assert.equal(model.baseBudgetMinutes, null);
  assert.equal(model.perRoundBudgetMinutes, null);
});

test('a distribution with only one round bucket yields no invented slope', () => {
  const model = fitTtmBudgetModel(
    syntheticDistribution({ base: 100, perRound: 40, perBucket: 40, maxRounds: 0 }),
    {}
  );
  assert.equal(model.source, 'measured-flat');
  assert.equal(model.usable, true);
  assert.ok(model.baseBudgetMinutes > LEGACY_BASE_MINUTES);
  assert.equal(model.perRoundBudgetMinutes, TTM_PER_ROUND_BUDGET_FLOOR_MINUTES);
});

test('floors keep a degenerate fit from producing a budget tighter than the literals it replaced', () => {
  // A distribution where more rounds merge FASTER would fit a negative slope.
  const inverted = [
    ...Array.from({ length: 30 }, () => ({ ttmMinutes: 5, reviewRounds: 0 })),
    ...Array.from({ length: 30 }, () => ({ ttmMinutes: 1, reviewRounds: 4 })),
  ];
  const model = fitTtmBudgetModel(inverted, {});
  assert.equal(model.usable, true);
  assert.ok(model.fitSlope < 0, 'the raw fit really is negative here');
  assert.equal(model.baseBudgetMinutes, TTM_BASE_BUDGET_FLOOR_MINUTES);
  assert.equal(model.perRoundBudgetMinutes, TTM_PER_ROUND_BUDGET_FLOOR_MINUTES);
});

// ── Load awareness ─────────────────────────────────────────────────────────

test("reference queue depth comes out of the same sample via Little's Law", () => {
  // 20 merges 20m apart => window 380m, throughput 0.0526/min; mean TTM 100m
  // => L = lambda * W ~= 5.3 concurrent.
  const samples = Array.from({ length: 20 }, (_, i) => ({
    mergedAt: new Date(Date.parse('2026-09-01T00:00:00.000Z') + i * 20 * 60_000).toISOString(),
    ttmMinutes: 100,
    reviewRounds: 0,
  }));
  const depth = referenceQueueDepth(samples);
  assert.ok(Math.abs(depth - 5.26) < 0.2, `depth ${depth}`);
});

test('queue pressure widens the budget under load, never tightens it, and saturates', () => {
  const idle = queuePressureMultiplier({ openPrCount: 3, referenceOpenPrCount: 6 });
  assert.equal(idle.multiplier, 1, 'a short queue must not tighten the measured budget');
  assert.equal(idle.saturated, false);

  const busy = queuePressureMultiplier({ openPrCount: 12, referenceOpenPrCount: 6 });
  assert.equal(busy.multiplier, 2);
  assert.equal(busy.saturated, false);

  // The live 2026-09-06 reading: 23 open against a Little's-Law reference of
  // ~6.3. Past the cap the model stops absorbing load, and says so.
  const oversubscribed = queuePressureMultiplier({ openPrCount: 23, referenceOpenPrCount: 6.3 });
  assert.equal(oversubscribed.multiplier, MAX_QUEUE_PRESSURE_MULTIPLIER);
  assert.equal(oversubscribed.saturated, true, 'oversubscription must stay visible, not be absorbed');
});

test('an unusable reference depth applies no pressure at all', () => {
  for (const reference of [null, 0, -1, NaN, undefined]) {
    const pressure = queuePressureMultiplier({ openPrCount: 50, referenceOpenPrCount: reference });
    assert.equal(pressure.multiplier, 1);
    assert.equal(pressure.referenceOpenPrCount, null);
  }
});

test('deriveTtmBudget multiplies the measured curve by measured pressure', () => {
  const samples = syntheticDistribution({ base: 100, perRound: 40 });
  const reference = referenceQueueDepth(samples);
  const quiet = deriveTtmBudget(samples, { openPrCount: 1 });
  const loaded = deriveTtmBudget(samples, { openPrCount: Math.round(reference * 2) });
  assert.equal(quiet.pressure.multiplier, 1);
  assert.ok(
    loaded.pressure.multiplier > 1.8 && loaded.pressure.multiplier <= 2.2,
    `loaded multiplier ${loaded.pressure.multiplier}`
  );
  assert.ok(
    Math.abs(loaded.baseBudgetMinutes / quiet.baseBudgetMinutes - loaded.pressure.multiplier) < 0.01
  );
});

// ── Blind, never false-clean ───────────────────────────────────────────────

test('an unreadable distribution throws rather than returning an empty sample', () => {
  const brokenDb = {
    prepare() {
      throw Object.assign(new Error('no such table: reviewed_prs'), { code: 'SQLITE_ERROR' });
    },
  };
  assert.throws(
    () => readMergedTtmSamples(brokenDb),
    (error) => error instanceof TtmDistributionUnreadableError
      && /unreadable/.test(error.message)
      && /no such table/.test(error.message)
  );
});

test('an empty-but-readable distribution is unusable, not a zero budget', () => {
  const emptyDb = { prepare: () => ({ all: () => [] }) };
  const derived = deriveTtmBudget(readMergedTtmSamples(emptyDb), { openPrCount: 10 });
  assert.equal(derived.usable, false);
  assert.equal(derived.baseBudgetMinutes, null);
  assert.notEqual(derived.baseBudgetMinutes, 0, 'a zero budget would flag every PR');
});
