// The convergence budget is ONE policy. These tests exist because it used to be
// five independent scalars: the round-budget table was duplicated verbatim in
// `follow-up-jobs.mjs` and `kernel/pipeline.mjs`, and three further bounds were
// pinned as literals whose comments described a derivation and then hardcoded
// the result. Raising the medium budget moved the remediation rounds and left
// the rest behind, so the pipeline stopped agreeing with itself.

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  DEFAULT_RISK_CLASS,
  DEFAULT_ROUND_BUDGET_BY_RISK,
  RISK_CLASSES,
  amaRetainLoopCapFor,
  convergenceBudget,
  convergenceBudgetForRiskClass,
  hammerLifetimeDispatchesFor,
  normalizeRoundBudget,
  remediationCeilingCapFor,
} from '../src/kernel/convergence-budget.mjs';
import {
  DEFAULT_REMEDIATION_CEILING_CAP,
  DEFAULT_ROUND_BUDGET_BY_RISK as KERNEL_BUDGET,
  RISK_CLASSES as KERNEL_RISK_CLASSES,
} from '../src/kernel/pipeline.mjs';
import { AMA_RETAIN_LOOP_CAP } from '../src/ama-retain-loop-cap.mjs';
import {
  HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES,
  HAMMER_RETRY_CAP_TOTAL_DISPATCHES,
} from '../src/ama/hammer-retry-cap.mjs';

test('adopting the shared budget did not change any live constant', () => {
  // These are the exact values the pins held before they were derived. If a
  // derivation is ever changed, this test is the thing that says the live
  // pipeline just moved.
  assert.deepEqual({ ...DEFAULT_ROUND_BUDGET_BY_RISK }, {
    low: 1, medium: 3, high: 3, critical: 4,
  });
  assert.equal(AMA_RETAIN_LOOP_CAP, 3);
  assert.equal(HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES, 6);
  assert.equal(DEFAULT_REMEDIATION_CEILING_CAP, 8);
});

test('the kernel no longer keeps its own copy of the budget table', () => {
  // Identity, not equality: a mirrored literal would be deep-equal but not the
  // same frozen object, and would drift the moment one side was edited.
  assert.equal(KERNEL_BUDGET, DEFAULT_ROUND_BUDGET_BY_RISK);
  assert.equal(KERNEL_RISK_CLASSES, RISK_CLASSES);
});

test('raising the round budget moves every derived bound with it', () => {
  const raised = { ...DEFAULT_ROUND_BUDGET_BY_RISK, medium: 5 };
  assert.equal(amaRetainLoopCapFor(raised.medium), 5);
  assert.equal(hammerLifetimeDispatchesFor(raised.medium), 10);
  // The subject ceiling tracks the WIDEST declared class. Raising medium to 5
  // makes medium wider than critical=4, so the ceiling follows medium.
  assert.equal(remediationCeilingCapFor(raised), 10);
  assert.equal(remediationCeilingCapFor({ ...raised, critical: 7 }), 14);
});

test('lowering the round budget also moves the derived bounds', () => {
  assert.equal(amaRetainLoopCapFor(1), 1);
  // Floored to per-series + 1 rather than the raw 1 x 2 = 2, which would equal
  // the per-series cap and leave the lifetime ceiling no headroom.
  assert.equal(hammerLifetimeDispatchesFor(1), HAMMER_RETRY_CAP_TOTAL_DISPATCHES + 1);
  assert.equal(remediationCeilingCapFor({ low: 1, medium: 1, high: 1, critical: 1 }), 2);
});

test('the hammer lifetime ceiling always stays above the per-series cap', () => {
  // The per-series cap is what the lifetime ceiling must not collide with; the
  // comment on the lifetime constant asserts this and it used to be true only
  // by coincidence of two literals.
  for (const rounds of [1, 2, 3, 4, 5, 6, 10]) {
    assert.ok(
      hammerLifetimeDispatchesFor(rounds) > HAMMER_RETRY_CAP_TOTAL_DISPATCHES,
      `lifetime ${hammerLifetimeDispatchesFor(rounds)} must exceed per-series `
      + `${HAMMER_RETRY_CAP_TOTAL_DISPATCHES} at budget ${rounds}`,
    );
  }
});

test('a malformed budget can never produce a zero or negative bound', () => {
  for (const bad of [0, -1, -99, null, undefined, '', 'x', NaN, Infinity, 1.5, {}, []]) {
    const budget = convergenceBudget(bad);
    assert.ok(budget.remediationRounds > 0, `rounds for ${String(bad)}`);
    assert.ok(budget.amaRetainLoopCap > 0, `retain cap for ${String(bad)}`);
    assert.ok(budget.hammerLifetimeDispatches > 0, `hammer lifetime for ${String(bad)}`);
    // An unbounded retain cap is the spin bug the cap exists to prevent.
    assert.ok(Number.isFinite(budget.amaRetainLoopCap));
  }
  assert.equal(normalizeRoundBudget(0), DEFAULT_ROUND_BUDGET_BY_RISK[DEFAULT_RISK_CLASS]);
});

test('every risk class resolves a coherent budget, unknown falls back to medium', () => {
  for (const risk of RISK_CLASSES) {
    const budget = convergenceBudgetForRiskClass(risk);
    assert.equal(budget.remediationRounds, DEFAULT_ROUND_BUDGET_BY_RISK[risk]);
    assert.equal(budget.amaRetainLoopCap, budget.remediationRounds);
    assert.equal(
      budget.hammerLifetimeDispatches,
      Math.max(budget.remediationRounds * 2, HAMMER_RETRY_CAP_TOTAL_DISPATCHES + 1),
    );
  }
  // The AMA call site resolves riskClass to 'unknown' for many PRs; that must
  // land on the medium default rather than an undefined bound.
  const unknown = convergenceBudgetForRiskClass('unknown');
  assert.deepEqual(unknown, convergenceBudgetForRiskClass(DEFAULT_RISK_CLASS));
  assert.equal(unknown.amaRetainLoopCap, 3);
});

test('an operator-declared budget overrides the default per class', () => {
  const declared = { low: 2, medium: 4, high: 6, critical: 9 };
  assert.equal(convergenceBudgetForRiskClass('high', declared).remediationRounds, 6);
  assert.equal(convergenceBudgetForRiskClass('high', declared).amaRetainLoopCap, 6);
  assert.equal(convergenceBudgetForRiskClass('high', declared).hammerLifetimeDispatches, 12);
  // A partially-declared table falls back per class, not wholesale.
  assert.equal(convergenceBudgetForRiskClass('critical', { medium: 4 }).remediationRounds, 4);
});
