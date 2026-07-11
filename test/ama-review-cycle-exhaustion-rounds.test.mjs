import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewCycleExhaustedFromRounds } from '../src/watcher.mjs';

// Regression for the "comment-only cycle never exhausts" park bug (2026-07-10):
// a comment-only review produces no blocking findings, so no remediation worker
// spawns, so remediation rounds stay 0 forever. Exhaustion must ALSO trip on
// re-review rounds so a CI-green/CLEAN PR reviewed to its budget can finalize
// via the final hammer (which still remediates-then-closes — no review bypass).

test('exhausts on remediation rounds reaching budget (original path preserved)', () => {
  assert.equal(
    reviewCycleExhaustedFromRounds({
      effectiveRoundBudget: 2,
      completedRemediationRounds: 2,
      completedRereviewRounds: 0,
    }),
    true,
  );
});

test('THE BUG: comment-only cycle — 0 remediation rounds, budget re-review rounds — now exhausts', () => {
  assert.equal(
    reviewCycleExhaustedFromRounds({
      effectiveRoundBudget: 2,
      completedRemediationRounds: 0,
      completedRereviewRounds: 2,
    }),
    true,
  );
});

test('not exhausted while under budget on both counters', () => {
  assert.equal(
    reviewCycleExhaustedFromRounds({
      effectiveRoundBudget: 2,
      completedRemediationRounds: 1,
      completedRereviewRounds: 1,
    }),
    false,
  );
});

test('re-review rounds exceeding budget also exhausts (>=, not ==)', () => {
  assert.equal(
    reviewCycleExhaustedFromRounds({
      effectiveRoundBudget: 2,
      completedRemediationRounds: 0,
      completedRereviewRounds: 3,
    }),
    true,
  );
});

test('never exhausts on a non-positive or non-finite budget', () => {
  for (const budget of [0, -1, NaN, Infinity, undefined, null]) {
    assert.equal(
      reviewCycleExhaustedFromRounds({
        effectiveRoundBudget: budget,
        completedRemediationRounds: 99,
        completedRereviewRounds: 99,
      }),
      false,
      `budget=${budget} must not exhaust`,
    );
  }
});

test('tolerates non-finite round counters without throwing (probe-failure fallback)', () => {
  // remediation NaN but re-review meets budget -> exhausted
  assert.equal(
    reviewCycleExhaustedFromRounds({
      effectiveRoundBudget: 2,
      completedRemediationRounds: NaN,
      completedRereviewRounds: 2,
    }),
    true,
  );
  // both non-finite -> not exhausted (fail-closed: do not finalize on missing signal)
  assert.equal(
    reviewCycleExhaustedFromRounds({
      effectiveRoundBudget: 2,
      completedRemediationRounds: NaN,
      completedRereviewRounds: NaN,
    }),
    false,
  );
});
