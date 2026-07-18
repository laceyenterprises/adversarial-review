import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDomainPipeline } from '../src/domain-pipeline.mjs';
import { runReviewPipeline } from '../src/review-pipeline-driver.mjs';

// Coverage for the two #634 (ARC-13) review findings.

const REGISTRY = {
  roles: {
    'code-quality-reviewer': { id: 'code-quality-reviewer', promptSet: 'code-pr', workerClass: 'codex', taskKind: 'review', completionShape: 'decision-only' },
    'security-reviewer': { id: 'security-reviewer', promptSet: 'code-pr-security', workerClass: 'codex', taskKind: 'review', completionShape: 'decision-only' },
  },
  routing: { neverReviewOwnBuilderClass: true },
};

function resolved() {
  return resolveDomainPipeline(
    {
      id: 'code-pr',
      riskClasses: { low: { maxRemediationRounds: 1 }, medium: { maxRemediationRounds: 2 }, high: { maxRemediationRounds: 3 }, critical: { maxRemediationRounds: 4 } },
      pipeline: {
        enabled: true,
        stages: [
          { id: 'code-quality', panel: ['code-quality-reviewer'], aggregation: { kind: 'unanimous-clean' } },
          { id: 'security', panel: ['security-reviewer'], aggregation: { kind: 'unanimous-clean' } },
        ],
      },
    },
    { roleRegistry: REGISTRY },
  );
}

const REV = 'rev-bbbbbbb';

test('finding 1: a pending disposition does NOT post a rollup (no dedupe-slot burn)', async () => {
  const posted = [];
  const runStageReview = async ({ stage }) =>
    // stage 1 returns NO verdict (transient failure) → disposition pending.
    stage.id === 'code-quality' ? null : { kind: 'approved', body: 'x' };
  const res = await runReviewPipeline({
    resolvedPipeline: resolved(),
    currentRevisionRef: REV,
    riskClass: 'high',
    observedAt: '2026-07-17T00:00:00Z',
    runStageReview,
    postRollup: async (r) => { posted.push(r); return { id: 'rcpt' }; },
  });
  assert.equal(res.disposition, 'pending');
  assert.equal(posted.length, 0, 'no rollup should be posted for a pending disposition');
  assert.equal(res.rollupReceipt, null);
});

test('finding 1: a clean/blocking disposition DOES post a rollup', async () => {
  const posted = [];
  const runStageReview = async () => ({ kind: 'approved', body: 'x' });
  const res = await runReviewPipeline({
    resolvedPipeline: resolved(),
    currentRevisionRef: REV,
    riskClass: 'high',
    observedAt: '2026-07-17T00:00:00Z',
    runStageReview,
    postRollup: async (r) => { posted.push(r); return { id: 'rcpt' }; },
  });
  assert.equal(res.disposition, 'clean');
  assert.equal(posted.length, 1);
});

test('finding 2: persisted stage states retain body only for the newest verdict per role', async () => {
  // Pre-seed a stage with two prior code-quality verdicts (older + newer),
  // both carrying a heavy body; only the newest should keep its body.
  const stageStates = [
    {
      stageId: 'code-quality',
      stageIndex: 0,
      panelVerdicts: [
        { reviewerRoleId: 'code-quality-reviewer', revisionRef: REV, kind: 'request-changes', body: 'OLD heavy body', observedAt: '2026-07-17T00:00:00Z' },
        { reviewerRoleId: 'code-quality-reviewer', revisionRef: REV, kind: 'comment-only', body: 'NEW heavy body', observedAt: '2026-07-17T01:00:00Z' },
      ],
    },
    { stageId: 'security', stageIndex: 1, panelVerdicts: [] },
  ];
  // A no-op reviewer: code-quality already has verdicts at REV, security clean.
  const runStageReview = async ({ stage }) =>
    stage.id === 'security' ? { kind: 'approved', body: 'sec' } : null;
  const res = await runReviewPipeline({
    resolvedPipeline: resolved(),
    currentRevisionRef: REV,
    riskClass: 'high',
    observedAt: '2026-07-17T02:00:00Z',
    runStageReview,
    stageStates,
  });
  const cq = res.stageStates.find((s) => s.stageId === 'code-quality');
  const bodies = cq.panelVerdicts.map((v) => v.body);
  assert.ok(bodies.includes('NEW heavy body'), 'newest verdict keeps its body');
  assert.ok(!bodies.includes('OLD heavy body'), 'older verdict body is stripped');
});
