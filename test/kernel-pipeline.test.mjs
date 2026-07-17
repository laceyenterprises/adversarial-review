import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGGREGATION_POLICY_KINDS,
  DEFAULT_REMEDIATION_CEILING_CAP,
  DEFAULT_ROUND_BUDGET_BY_RISK,
  RISK_CLASSES,
  aggregateStageVerdict,
  classifyVerdictDisposition,
  newestVerdict,
  normalizeRiskClass,
  planPipelineReReview,
  resolveActiveStage,
  resolveLatestVerdict,
  resolveRemediationBudgetPlan,
  resolveStageRoundBudget,
  stageVerdictAppliesToRevision,
  stageVerdictsForRevision,
} from '../src/kernel/pipeline.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function verdict({ kind = 'approved', revisionRef, roleId, observedAt, blockingFindings } = {}) {
  return {
    kind,
    body: `## Verdict\n${kind}`,
    ...(revisionRef ? { revisionRef } : {}),
    ...(roleId ? { reviewerRoleId: roleId } : {}),
    ...(observedAt ? { observedAt } : {}),
    ...(blockingFindings ? { blockingFindings } : {}),
  };
}

function stage(id, aggregation, panel, roundBudgetByRisk) {
  return {
    id,
    panel: panel.map((roleId) => ({ id: roleId })),
    aggregation,
    roundBudgetByRisk: roundBudgetByRisk ?? { low: 1, medium: 2, high: 3, critical: 4 },
  };
}

const singleRolePanel = ['reviewer'];

// ---------------------------------------------------------------------------
// classifyVerdictDisposition
// ---------------------------------------------------------------------------

test('classifyVerdictDisposition maps kinds and honors blocking findings', () => {
  assert.equal(classifyVerdictDisposition(verdict({ kind: 'approved' })), 'clean');
  assert.equal(classifyVerdictDisposition(verdict({ kind: 'comment-only' })), 'clean');
  assert.equal(classifyVerdictDisposition(verdict({ kind: 'request-changes' })), 'blocking');
  assert.equal(classifyVerdictDisposition(verdict({ kind: 'unknown' })), 'indeterminate');
  assert.equal(classifyVerdictDisposition(null), 'indeterminate');
  // A comment-only verdict with structured blocking findings escalates to blocking.
  assert.equal(
    classifyVerdictDisposition(verdict({ kind: 'comment-only', blockingFindings: [{ problem: 'x' }] })),
    'blocking',
  );
});

// ---------------------------------------------------------------------------
// Revision pinning
// ---------------------------------------------------------------------------

test('stageVerdictAppliesToRevision requires an exact revisionRef match', () => {
  assert.equal(stageVerdictAppliesToRevision(verdict({ revisionRef: 'A' }), 'A'), true);
  assert.equal(stageVerdictAppliesToRevision(verdict({ revisionRef: 'A' }), 'B'), false);
  // A verdict with no revisionRef applies to no revision (fails safe to re-review).
  assert.equal(stageVerdictAppliesToRevision(verdict({}), 'A'), false);
  // No current revision to compare against => no match.
  assert.equal(stageVerdictAppliesToRevision(verdict({ revisionRef: 'A' }), ''), false);
  assert.equal(stageVerdictAppliesToRevision(verdict({ revisionRef: 'A' }), null), false);
});

test('stageVerdictsForRevision filters a stage state by pinned revision', () => {
  const state = {
    stageId: 's',
    stageIndex: 0,
    panelVerdicts: [
      verdict({ revisionRef: 'A', roleId: 'r1' }),
      verdict({ revisionRef: 'B', roleId: 'r2' }),
      verdict({ roleId: 'r3' }),
    ],
  };
  assert.deepEqual(
    stageVerdictsForRevision(state, 'A').map((v) => v.reviewerRoleId),
    ['r1'],
  );
  assert.deepEqual(stageVerdictsForRevision(null, 'A'), []);
});

// ---------------------------------------------------------------------------
// newestVerdict
// ---------------------------------------------------------------------------

test('newestVerdict picks the latest observedAt, ties break to array order', () => {
  assert.equal(newestVerdict([]), null);
  const older = verdict({ observedAt: '2026-05-01T00:00:00.000Z', roleId: 'a' });
  const newer = verdict({ observedAt: '2026-05-02T00:00:00.000Z', roleId: 'b' });
  assert.equal(newestVerdict([older, newer]).reviewerRoleId, 'b');
  assert.equal(newestVerdict([newer, older]).reviewerRoleId, 'b');
  // Equal timestamps => later position wins.
  const tieA = verdict({ observedAt: '2026-05-02T00:00:00.000Z', roleId: 'x' });
  const tieB = verdict({ observedAt: '2026-05-02T00:00:00.000Z', roleId: 'y' });
  assert.equal(newestVerdict([tieA, tieB]).reviewerRoleId, 'y');
});

// ---------------------------------------------------------------------------
// Aggregation policies
// ---------------------------------------------------------------------------

test('aggregation policy kinds are exactly the four contract kinds', () => {
  assert.deepEqual(
    [...AGGREGATION_POLICY_KINDS].sort(),
    ['any-blocking-blocks', 'quorum', 'unanimous-clean', 'weighted'],
  );
});

test('unanimous-clean: clean only when every role is clean', () => {
  const s = stage('s', { kind: 'unanimous-clean' }, ['a', 'b']);
  const clean = aggregateStageVerdict(s, [
    verdict({ kind: 'approved', roleId: 'a' }),
    verdict({ kind: 'approved', roleId: 'b' }),
  ]);
  assert.equal(clean.decision, 'clean');

  // One blocking => blocking.
  assert.equal(
    aggregateStageVerdict(s, [
      verdict({ kind: 'approved', roleId: 'a' }),
      verdict({ kind: 'request-changes', roleId: 'b' }),
    ]).decision,
    'blocking',
  );

  // One indeterminate (no block) => pending (not unanimous).
  assert.equal(
    aggregateStageVerdict(s, [
      verdict({ kind: 'approved', roleId: 'a' }),
      verdict({ kind: 'unknown', roleId: 'b' }),
    ]).decision,
    'pending',
  );

  // Missing role => pending.
  assert.equal(
    aggregateStageVerdict(s, [verdict({ kind: 'approved', roleId: 'a' })]).decision,
    'pending',
  );
});

test('any-blocking-blocks: tolerates indeterminate, blocks on any block', () => {
  const s = stage('s', { kind: 'any-blocking-blocks' }, ['a', 'b']);
  // No block, both reported (one indeterminate) => clean (the unanimous-clean distinction).
  assert.equal(
    aggregateStageVerdict(s, [
      verdict({ kind: 'approved', roleId: 'a' }),
      verdict({ kind: 'unknown', roleId: 'b' }),
    ]).decision,
    'clean',
  );
  // Any block => blocking.
  assert.equal(
    aggregateStageVerdict(s, [
      verdict({ kind: 'unknown', roleId: 'a' }),
      verdict({ kind: 'request-changes', roleId: 'b' }),
    ]).decision,
    'blocking',
  );
  // A role still missing => pending.
  assert.equal(
    aggregateStageVerdict(s, [verdict({ kind: 'approved', roleId: 'a' })]).decision,
    'pending',
  );
});

test('quorum: clean at N clean; blocks when a clean quorum is unreachable', () => {
  const s = stage('s', { kind: 'quorum', quorum: 2 }, ['a', 'b', 'c']);
  assert.equal(
    aggregateStageVerdict(s, [
      verdict({ kind: 'approved', roleId: 'a' }),
      verdict({ kind: 'approved', roleId: 'b' }),
    ]).decision,
    'clean',
  );
  // 1 clean, 2 blocking => reachable clean (1) < 2 => blocking.
  assert.equal(
    aggregateStageVerdict(s, [
      verdict({ kind: 'approved', roleId: 'a' }),
      verdict({ kind: 'request-changes', roleId: 'b' }),
      verdict({ kind: 'request-changes', roleId: 'c' }),
    ]).decision,
    'blocking',
  );
  // 1 clean, 1 blocking, 1 missing => reachable clean (2) >= 2 => pending.
  assert.equal(
    aggregateStageVerdict(s, [
      verdict({ kind: 'approved', roleId: 'a' }),
      verdict({ kind: 'request-changes', roleId: 'b' }),
    ]).decision,
    'pending',
  );
  assert.throws(
    () => aggregateStageVerdict(stage('s', { kind: 'quorum' }, ['a']), []),
    /quorum/,
  );
});

test('weighted: clean at threshold weight; blocks when reachable weight falls short', () => {
  const s = stage('s', { kind: 'weighted', weights: { a: 2, b: 1, c: 1 }, threshold: 2 }, ['a', 'b', 'c']);
  // Role a (weight 2) clean => threshold met.
  assert.equal(
    aggregateStageVerdict(s, [verdict({ kind: 'approved', roleId: 'a' })]).decision,
    'clean',
  );
  // a blocks (weight 2), b clean (1): reachable clean weight = 4-2=2 >= 2 => pending.
  assert.equal(
    aggregateStageVerdict(s, [
      verdict({ kind: 'request-changes', roleId: 'a' }),
      verdict({ kind: 'approved', roleId: 'b' }),
    ]).decision,
    'pending',
  );
  // a and b block (weight 3): reachable clean weight = 4-3=1 < 2 => blocking.
  assert.equal(
    aggregateStageVerdict(s, [
      verdict({ kind: 'request-changes', roleId: 'a' }),
      verdict({ kind: 'request-changes', roleId: 'b' }),
    ]).decision,
    'blocking',
  );
  // Missing weights default to 1: b+c clean (2) => clean.
  assert.equal(
    aggregateStageVerdict(
      stage('s', { kind: 'weighted', threshold: 2 }, ['a', 'b']),
      [verdict({ kind: 'approved', roleId: 'a' }), verdict({ kind: 'approved', roleId: 'b' })],
    ).decision,
    'clean',
  );
  assert.throws(
    () => aggregateStageVerdict(stage('s', { kind: 'weighted' }, ['a']), []),
    /threshold/,
  );
});

test('single-role panel attributes an unlabeled verdict to the sole role (v1 shape)', () => {
  const s = stage('s', { kind: 'unanimous-clean' }, singleRolePanel);
  assert.equal(aggregateStageVerdict(s, [verdict({ kind: 'approved' })]).decision, 'clean');
  assert.equal(aggregateStageVerdict(s, [verdict({ kind: 'request-changes' })]).decision, 'blocking');
});

test('aggregateStageVerdict rejects an unknown policy kind', () => {
  assert.throws(
    () => aggregateStageVerdict(stage('s', { kind: 'nope' }, ['a']), []),
    /unknown aggregation policy/,
  );
});

// ---------------------------------------------------------------------------
// Budget / ceiling matrix
// ---------------------------------------------------------------------------

test('normalizeRiskClass normalizes case/whitespace and falls back to medium', () => {
  assert.equal(normalizeRiskClass('HIGH'), 'high');
  assert.equal(normalizeRiskClass('  critical '), 'critical');
  assert.equal(normalizeRiskClass('nonsense'), 'medium');
  assert.equal(normalizeRiskClass(undefined), 'medium');
  assert.equal(normalizeRiskClass('nonsense', 'low'), 'low');
});

test('resolveStageRoundBudget returns per-risk budget, falling back on malformed values', () => {
  const s = stage('s', { kind: 'unanimous-clean' }, ['a'], { low: 1, medium: 2, high: 3, critical: 4 });
  for (const risk of RISK_CLASSES) {
    assert.equal(resolveStageRoundBudget(s, risk), { low: 1, medium: 2, high: 3, critical: 4 }[risk]);
  }
  // Malformed value => default per-risk budget.
  const bad = stage('s', { kind: 'unanimous-clean' }, ['a'], { low: 0, medium: -1, high: 'x', critical: null });
  for (const risk of RISK_CLASSES) {
    assert.equal(resolveStageRoundBudget(bad, risk), DEFAULT_ROUND_BUDGET_BY_RISK[risk]);
  }
});

test('remediation ceiling = capped sum of stage budgets across the risk matrix', () => {
  const twoStage = [
    stage('a', { kind: 'unanimous-clean' }, ['a'], { low: 1, medium: 2, high: 3, critical: 4 }),
    stage('b', { kind: 'unanimous-clean' }, ['b'], { low: 1, medium: 1, high: 2, critical: 3 }),
  ];
  // Sums per risk: low 2, medium 3, high 5, critical 7 — all under the cap (8).
  const expected = { low: 2, medium: 3, high: 5, critical: 7 };
  for (const risk of RISK_CLASSES) {
    const plan = resolveRemediationBudgetPlan(twoStage, risk);
    assert.equal(plan.riskClass, risk);
    assert.equal(plan.ceiling, expected[risk]);
    assert.equal(plan.ceilingSource, 'sum-capped');
    assert.equal(plan.perStage.length, 2);
  }
});

test('remediation ceiling is capped so many-stage pipelines do not multiply rounds', () => {
  const fourCritical = ['a', 'b', 'c', 'd'].map((id) =>
    stage(id, { kind: 'unanimous-clean' }, [id], { low: 1, medium: 2, high: 3, critical: 4 }),
  );
  // Raw sum at critical = 16, capped to DEFAULT_REMEDIATION_CEILING_CAP (8).
  const plan = resolveRemediationBudgetPlan(fourCritical, 'critical');
  assert.equal(plan.ceiling, DEFAULT_REMEDIATION_CEILING_CAP);
  assert.equal(plan.ceilingSource, 'sum-capped');
});

test('ceiling never drops below the largest single-stage budget', () => {
  const single = [stage('a', { kind: 'unanimous-clean' }, ['a'], { low: 1, medium: 2, high: 3, critical: 4 })];
  // Cap of 1 would starve a critical stage; guard raises it back to 4.
  const plan = resolveRemediationBudgetPlan(single, 'critical', { cap: 1 });
  assert.equal(plan.ceiling, 4);
});

test('operator override sets the ceiling directly and bypasses the cap', () => {
  const fourCritical = ['a', 'b', 'c', 'd'].map((id) =>
    stage(id, { kind: 'unanimous-clean' }, [id]),
  );
  const plan = resolveRemediationBudgetPlan(fourCritical, 'critical', { override: 12 });
  assert.equal(plan.ceiling, 12);
  assert.equal(plan.ceilingSource, 'override');
});

test('resolveRemediationBudgetPlan rejects an empty pipeline', () => {
  assert.throws(() => resolveRemediationBudgetPlan([], 'high'), /non-empty pipeline/);
});

// ---------------------------------------------------------------------------
// Stage invalidation on revision advance
// ---------------------------------------------------------------------------

const twoStagePipeline = [
  stage('code-quality', { kind: 'unanimous-clean' }, ['cq'], { low: 1, medium: 2, high: 3, critical: 4 }),
  stage('security', { kind: 'any-blocking-blocks' }, ['sec'], { low: 1, medium: 1, high: 2, critical: 3 }),
];

test('a revision advance invalidates every stage and restarts at the first stage', () => {
  // Both stages clean at revision A.
  const stageStates = [
    {
      stageId: 'code-quality',
      stageIndex: 0,
      panelVerdicts: [verdict({ kind: 'approved', roleId: 'cq', revisionRef: 'A' })],
    },
    {
      stageId: 'security',
      stageIndex: 1,
      panelVerdicts: [verdict({ kind: 'approved', roleId: 'sec', revisionRef: 'A' })],
    },
  ];
  // At revision A the pipeline is complete.
  const atA = planPipelineReReview({ pipeline: twoStagePipeline, stageStates, currentRevisionRef: 'A', riskClass: 'high' });
  assert.equal(atA.complete, true);
  assert.equal(atA.activeStageIndex, null);
  assert.deepEqual(atA.stagesToRun, []);

  // A remediation commit advances to revision B: every prior verdict is stale.
  const atB = planPipelineReReview({ pipeline: twoStagePipeline, stageStates, currentRevisionRef: 'B', riskClass: 'high' });
  assert.equal(atB.complete, false);
  assert.equal(atB.activeStageIndex, 0);
  assert.equal(atB.activeStageId, 'code-quality');
  assert.deepEqual(atB.stagesToRun, ['code-quality', 'security']);
  assert.deepEqual(atB.invalidatedStageIds, ['security']);
  assert.equal(atB.decisions[0].decision, 'pending');
  assert.equal(atB.decisions[1].decision, 'pending');
});

test('active stage is the failed stage; re-run includes it plus all downstream', () => {
  // Stage 0 clean at current revision B, stage 1 blocking at B.
  const stageStates = [
    {
      stageId: 'code-quality',
      stageIndex: 0,
      panelVerdicts: [verdict({ kind: 'approved', roleId: 'cq', revisionRef: 'B' })],
    },
    {
      stageId: 'security',
      stageIndex: 1,
      panelVerdicts: [verdict({ kind: 'request-changes', roleId: 'sec', revisionRef: 'B' })],
    },
  ];
  const plan = planPipelineReReview({ pipeline: twoStagePipeline, stageStates, currentRevisionRef: 'B', riskClass: 'medium' });
  assert.equal(plan.activeStageIndex, 1);
  assert.equal(plan.activeStageId, 'security');
  assert.deepEqual(plan.stagesToRun, ['security']);
  assert.equal(plan.decisions[0].decision, 'clean');
  assert.equal(plan.decisions[1].decision, 'blocking');
});

test('an upstream stage clean only at a stale revision is re-run from the first stage', () => {
  // Stage 0 clean at OLD revision A; head has advanced to B.
  const stageStates = [
    {
      stageId: 'code-quality',
      stageIndex: 0,
      panelVerdicts: [verdict({ kind: 'approved', roleId: 'cq', revisionRef: 'A' })],
    },
    { stageId: 'security', stageIndex: 1, panelVerdicts: [] },
  ];
  const plan = planPipelineReReview({ pipeline: twoStagePipeline, stageStates, currentRevisionRef: 'B' });
  assert.equal(plan.activeStageIndex, 0);
  assert.deepEqual(plan.stagesToRun, ['code-quality', 'security']);
  // Only code-quality carried prior (now-stale) verdicts; security never ran.
  assert.deepEqual(plan.invalidatedStageIds, []);
});

test('planPipelineReReview carries the resolved budget plan and rejects an empty pipeline', () => {
  const plan = planPipelineReReview({ pipeline: twoStagePipeline, currentRevisionRef: 'B', riskClass: 'critical' });
  assert.equal(plan.budget.riskClass, 'critical');
  assert.equal(plan.budget.ceiling, 7); // 4 + 3, under cap
  assert.throws(() => planPipelineReReview({ pipeline: [], currentRevisionRef: 'B' }), /non-empty pipeline/);
});

// ---------------------------------------------------------------------------
// latestVerdict alias compatibility
// ---------------------------------------------------------------------------

test('resolveLatestVerdict returns the newest current-revision verdict of the active (furthest) stage', () => {
  const subjectState = {
    ref: { domainId: 'd', subjectExternalId: 's', revisionRef: 'B' },
    lifecycle: 'review-in-progress',
    currentRound: 1,
    completedRemediationRounds: 0,
    maxRemediationRounds: 5,
    terminal: false,
    observedAt: '2026-05-10T00:00:00.000Z',
    pipeline: [
      {
        stageId: 'code-quality',
        stageIndex: 0,
        panelVerdicts: [verdict({ kind: 'approved', roleId: 'cq', revisionRef: 'B', observedAt: '2026-05-01T00:00:00.000Z' })],
      },
      {
        stageId: 'security',
        stageIndex: 1,
        panelVerdicts: [
          verdict({ kind: 'request-changes', roleId: 'sec', revisionRef: 'B', observedAt: '2026-05-02T00:00:00.000Z' }),
          verdict({ kind: 'comment-only', roleId: 'sec', revisionRef: 'B', observedAt: '2026-05-03T00:00:00.000Z' }),
        ],
      },
    ],
  };
  const active = resolveActiveStage(subjectState);
  assert.equal(active.stageId, 'security');
  const latest = resolveLatestVerdict(subjectState);
  assert.equal(latest.kind, 'comment-only');
  assert.equal(latest.observedAt, '2026-05-03T00:00:00.000Z');
});

test('resolveLatestVerdict cannot bypass a current block with a stale downstream clean verdict', () => {
  const staleClean = verdict({
    kind: 'approved', roleId: 'sec', revisionRef: 'A', observedAt: '2026-05-03T00:00:00.000Z',
  });
  const currentBlock = verdict({
    kind: 'request-changes', roleId: 'cq', revisionRef: 'B', observedAt: '2026-05-04T00:00:00.000Z',
  });
  const subjectState = {
    ref: { domainId: 'd', subjectExternalId: 's', revisionRef: 'B' },
    pipeline: [
      { stageId: 'code-quality', stageIndex: 0, panelVerdicts: [currentBlock] },
      { stageId: 'security', stageIndex: 1, panelVerdicts: [staleClean] },
    ],
    latestVerdict: staleClean,
  };

  assert.equal(resolveActiveStage(subjectState).stageId, 'code-quality');
  assert.equal(resolveLatestVerdict(subjectState), currentBlock);

  const staleOnly = {
    ...subjectState,
    pipeline: [{ stageId: 'security', stageIndex: 1, panelVerdicts: [staleClean] }],
  };
  assert.equal(resolveActiveStage(staleOnly), null);
  assert.equal(resolveLatestVerdict(staleOnly), null);
});

test('resolveLatestVerdict falls back to the legacy latestVerdict field with no pipeline', () => {
  const legacy = {
    ref: { domainId: 'd', subjectExternalId: 's', revisionRef: 'A' },
    lifecycle: 'reviewed',
    currentRound: 1,
    completedRemediationRounds: 0,
    maxRemediationRounds: 2,
    latestVerdict: verdict({ kind: 'request-changes' }),
    terminal: false,
    observedAt: '2026-05-10T00:00:00.000Z',
  };
  assert.equal(resolveLatestVerdict(legacy).kind, 'request-changes');
  // Empty pipeline (no stage has verdicts yet) also falls back to the alias.
  const emptyPipeline = {
    ...legacy,
    pipeline: [{ stageId: 'code-quality', stageIndex: 0, panelVerdicts: [] }],
  };
  assert.equal(resolveLatestVerdict(emptyPipeline).kind, 'request-changes');
  // No verdict anywhere => null.
  assert.equal(resolveLatestVerdict({ ...legacy, latestVerdict: undefined }), null);
});

test('resolveActiveStage returns null when no stage has produced a verdict', () => {
  assert.equal(resolveActiveStage({ pipeline: [] }), null);
  assert.equal(resolveActiveStage({}), null);
  assert.equal(
    resolveActiveStage({ pipeline: [{ stageId: 's', stageIndex: 0, panelVerdicts: [] }] }),
    null,
  );
});
