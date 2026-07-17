import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveStageRoundBudget,
  resolveSubjectRemediationCeiling,
} from '../src/kernel/pipeline.mjs';

const DOMAIN_RISK = {
  low: { maxRemediationRounds: 1 },
  medium: { maxRemediationRounds: 2 },
  high: { maxRemediationRounds: 3 },
  critical: { maxRemediationRounds: 4 },
};

// --- per-stage budget matrix ----------------------------------------------

test('resolveStageRoundBudget: stage budget wins when present, across risk classes', () => {
  const stage = { id: 's', panel: ['a'], aggregation: 'any-blocking-blocks', roundBudgetByRisk: { low: 0, medium: 1, high: 2, critical: 3 } };
  assert.equal(resolveStageRoundBudget({ stage, riskClass: 'low' }), 0);
  assert.equal(resolveStageRoundBudget({ stage, riskClass: 'medium' }), 1);
  assert.equal(resolveStageRoundBudget({ stage, riskClass: 'high' }), 2);
  assert.equal(resolveStageRoundBudget({ stage, riskClass: 'critical' }), 3);
});

test('resolveStageRoundBudget: falls back to domain riskClasses when stage has none', () => {
  const stage = { id: 's', panel: ['a'], aggregation: 'any-blocking-blocks' };
  for (const [risk, expected] of [['low', 1], ['medium', 2], ['high', 3], ['critical', 4]]) {
    assert.equal(
      resolveStageRoundBudget({ stage, riskClass: risk, domainRiskClasses: DOMAIN_RISK }),
      expected,
    );
  }
});

test('resolveStageRoundBudget: falls back to 0 when neither stage nor domain provides one', () => {
  const stage = { id: 's', panel: ['a'], aggregation: 'any-blocking-blocks' };
  assert.equal(resolveStageRoundBudget({ stage, riskClass: 'high' }), 0);
});

// --- subject-level ceiling ------------------------------------------------

test('resolveSubjectRemediationCeiling: sums per-stage budgets by risk class', () => {
  const pipeline = {
    stages: [
      { id: 'code-quality', panel: ['a'], aggregation: 'any-blocking-blocks' },
      { id: 'security', panel: ['b'], aggregation: 'any-blocking-blocks' },
    ],
  };
  // Each stage falls back to the domain budget; two stages => 2x the domain budget.
  assert.equal(
    resolveSubjectRemediationCeiling({ pipeline, riskClass: 'high', domainRiskClasses: DOMAIN_RISK }),
    6,
  );
  assert.equal(
    resolveSubjectRemediationCeiling({ pipeline, riskClass: 'low', domainRiskClasses: DOMAIN_RISK }),
    2,
  );
});

test('resolveSubjectRemediationCeiling: explicit ceiling caps the sum (no hammer multiplication)', () => {
  const pipeline = {
    stages: [
      { id: 'code-quality', panel: ['a'], aggregation: 'any-blocking-blocks' },
      { id: 'security', panel: ['b'], aggregation: 'any-blocking-blocks' },
    ],
    subjectRemediationCeiling: 4,
  };
  // Sum for high would be 6, capped to 4.
  assert.equal(
    resolveSubjectRemediationCeiling({ pipeline, riskClass: 'high', domainRiskClasses: DOMAIN_RISK }),
    4,
  );
});

test('resolveSubjectRemediationCeiling: single-stage pipeline equals the stage budget (v1 parity)', () => {
  const pipeline = {
    stages: [{ id: 'code-review', panel: ['a'], aggregation: 'any-blocking-blocks' }],
  };
  for (const [risk, expected] of [['low', 1], ['medium', 2], ['high', 3], ['critical', 4]]) {
    assert.equal(
      resolveSubjectRemediationCeiling({ pipeline, riskClass: risk, domainRiskClasses: DOMAIN_RISK }),
      expected,
    );
  }
});
