import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDomainPipeline } from '../src/domain-pipeline.mjs';
import { runReviewPipeline } from '../src/review-pipeline-driver.mjs';

const REGISTRY = {
  roles: {
    'code-quality-reviewer': { id: 'code-quality-reviewer', promptSet: 'code-pr', workerClass: 'codex', taskKind: 'review', completionShape: 'decision-only' },
    'security-reviewer': { id: 'security-reviewer', promptSet: 'code-pr-security', workerClass: 'codex', taskKind: 'review', completionShape: 'decision-only' },
  },
  routing: { neverReviewOwnBuilderClass: true },
};

function pipelineConfig() {
  return {
    id: 'code-pr',
    riskClasses: { low: { maxRemediationRounds: 1 }, medium: { maxRemediationRounds: 2 }, high: { maxRemediationRounds: 3 }, critical: { maxRemediationRounds: 4 } },
    pipeline: {
      enabled: true,
      stages: [
        { id: 'code-quality', panel: ['code-quality-reviewer'], aggregation: { kind: 'unanimous-clean' } },
        { id: 'security', panel: ['security-reviewer'], aggregation: { kind: 'unanimous-clean' } },
      ],
    },
  };
}

function resolved() {
  return resolveDomainPipeline(pipelineConfig(), { roleRegistry: REGISTRY });
}

// A stub reviewer keyed by stage id → verdict, recording the order stages ran.
function stubReviewer(verdictByStage) {
  const ran = [];
  const runStageReview = async ({ stage, roleId, round }) => {
    ran.push({ stageId: stage.id, roleId, round });
    const verdict = verdictByStage[stage.id];
    return typeof verdict === 'function' ? verdict({ round }) : verdict;
  };
  return { runStageReview, ran };
}

const REV = 'rev-aaaaaaa';

// ── e2e: both stages ─────────────────────────────────────────────────────────

test('e2e: stage 1 clean → stage 2 runs; both clean → pipeline CLEAN', async () => {
  const { runStageReview, ran } = stubReviewer({
    'code-quality': { kind: 'comment-only', body: 'cq clean' },
    security: { kind: 'approved', body: 'sec clean' },
  });
  const res = await runReviewPipeline({
    resolvedPipeline: resolved(), currentRevisionRef: REV, riskClass: 'high', observedAt: '2026-07-17T00:00:00Z', runStageReview,
  });
  assert.deepEqual(ran.map((r) => r.stageId), ['code-quality', 'security']);
  assert.equal(res.disposition, 'clean');
  assert.equal(res.complete, true);
  assert.deepEqual(res.ranStageIds, ['code-quality', 'security']);
  assert.match(res.rollupBody, /pipeline: CLEAN — all 2 stages clean/);
});

test('e2e: stage 1 blocks → stage 2 never runs (sequential gate)', async () => {
  const { runStageReview, ran } = stubReviewer({
    'code-quality': { kind: 'request-changes', body: 'cq bad', blockingFindings: [{ problem: 'a' }] },
    security: { kind: 'approved', body: 'should not run' },
  });
  const res = await runReviewPipeline({
    resolvedPipeline: resolved(), currentRevisionRef: REV, riskClass: 'high', observedAt: '2026-07-17T00:00:00Z', runStageReview,
  });
  assert.deepEqual(ran.map((r) => r.stageId), ['code-quality']);
  assert.equal(res.disposition, 'blocking');
  assert.equal(res.blockingStageId, 'code-quality');
  assert.deepEqual(res.notRunStageIds, ['security']);
  assert.match(res.rollupBody, /pipeline: BLOCKED at code-quality/);
  assert.match(res.rollupBody, /security .* not run/);
});

test('e2e: stage 1 clean → stage 2 blocks → BLOCKED at security, findings routed', async () => {
  const { runStageReview, ran } = stubReviewer({
    'code-quality': { kind: 'comment-only', body: 'cq clean' },
    security: { kind: 'request-changes', body: 'sec bad', blockingFindings: [{ problem: 'x' }, { problem: 'y' }] },
  });
  const res = await runReviewPipeline({
    resolvedPipeline: resolved(), currentRevisionRef: REV, riskClass: 'high', observedAt: '2026-07-17T00:00:00Z', runStageReview,
  });
  assert.deepEqual(ran.map((r) => r.stageId), ['code-quality', 'security']);
  assert.equal(res.disposition, 'blocking');
  assert.equal(res.blockingStageId, 'security');
  assert.equal(res.blockingFindingsCount, 2);
  assert.match(res.rollupBody, /pipeline: BLOCKED at security — 2 blocking findings routed/);
});

// ── Downstream-only re-review (the ARC-13 "Don't") ───────────────────────────

test('downstream re-review: stage-2 remediation at the same revision re-runs stage 2 ONLY', async () => {
  // Prior state at REV: stage 1 clean, stage 2 blocked. A remediation addressed
  // the stage-2 findings at the same revision; re-review must re-run stage 2 and
  // NOT stage 1 (its clean verdict at REV still stands).
  const stageStates = [
    { stageId: 'code-quality', stageIndex: 0, panelVerdicts: [{ kind: 'comment-only', body: 'cq clean', reviewerRoleId: 'code-quality-reviewer', revisionRef: REV, observedAt: '2026-07-17T00:00:00Z' }] },
    { stageId: 'security', stageIndex: 1, panelVerdicts: [{ kind: 'request-changes', body: 'sec bad', reviewerRoleId: 'security-reviewer', revisionRef: REV, observedAt: '2026-07-17T00:01:00Z', blockingFindings: [{ problem: 'x' }] }] },
  ];
  const { runStageReview, ran } = stubReviewer({
    'code-quality': { kind: 'comment-only', body: 'MUST NOT RUN' },
    security: { kind: 'comment-only', body: 'sec now clean' },
  });
  const res = await runReviewPipeline({
    resolvedPipeline: resolved(), stageStates, currentRevisionRef: REV, riskClass: 'high', observedAt: '2026-07-17T00:02:00Z', runStageReview,
  });
  assert.deepEqual(ran.map((r) => r.stageId), ['security'], 'only stage 2 re-runs');
  assert.equal(ran[0].round, 2, 'stage 2 is on its 2nd round');
  assert.deepEqual(res.carriedForwardStageIds, ['code-quality']);
  assert.deepEqual(res.ranStageIds, ['security']);
  assert.equal(res.disposition, 'clean');
});

test('revision advance re-runs from stage 1 (stale verdicts do not carry across a new revision)', async () => {
  // Same prior state, but the current revision has advanced past REV: stage 1's
  // clean verdict pins to the OLD revision, so the pipeline restarts at stage 1.
  const stageStates = [
    { stageId: 'code-quality', stageIndex: 0, panelVerdicts: [{ kind: 'comment-only', body: 'cq clean', reviewerRoleId: 'code-quality-reviewer', revisionRef: REV, observedAt: '2026-07-17T00:00:00Z' }] },
    { stageId: 'security', stageIndex: 1, panelVerdicts: [{ kind: 'request-changes', body: 'sec bad', reviewerRoleId: 'security-reviewer', revisionRef: REV, observedAt: '2026-07-17T00:01:00Z' }] },
  ];
  const { runStageReview, ran } = stubReviewer({
    'code-quality': { kind: 'comment-only', body: 'cq clean again' },
    security: { kind: 'approved', body: 'sec clean' },
  });
  const res = await runReviewPipeline({
    resolvedPipeline: resolved(), stageStates, currentRevisionRef: 'rev-bbbbbbb', riskClass: 'high', observedAt: '2026-07-17T00:03:00Z', runStageReview,
  });
  assert.deepEqual(ran.map((r) => r.stageId), ['code-quality', 'security']);
  assert.deepEqual(res.carriedForwardStageIds, []);
  assert.equal(res.disposition, 'clean');
});

// ── Rollup delivery + budget ─────────────────────────────────────────────────

test('the rollup is posted exactly once through the injected comms effect', async () => {
  const posts = [];
  const { runStageReview } = stubReviewer({
    'code-quality': { kind: 'comment-only', body: 'cq clean' },
    security: { kind: 'request-changes', body: 'sec bad', blockingFindings: [{ problem: 'x' }] },
  });
  const res = await runReviewPipeline({
    resolvedPipeline: resolved(), currentRevisionRef: REV, riskClass: 'medium', observedAt: '2026-07-17T00:00:00Z', runStageReview,
    postRollup: async (rollup) => { posts.push(rollup); return { deliveryExternalId: 'c1' }; },
  });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body, res.rollupBody);
  assert.equal(posts[0].disposition, 'blocking');
  assert.equal(res.rollupReceipt.deliveryExternalId, 'c1');
});

test('the resolved budget plan caps the subject-level remediation ceiling', async () => {
  const { runStageReview } = stubReviewer({
    'code-quality': { kind: 'comment-only', body: 'ok' },
    security: { kind: 'approved', body: 'ok' },
  });
  const res = await runReviewPipeline({
    resolvedPipeline: resolved(), currentRevisionRef: REV, riskClass: 'critical', observedAt: '2026-07-17T00:00:00Z', runStageReview,
  });
  // critical per-stage budget 4 + 4 = 8, capped at DEFAULT_REMEDIATION_CEILING_CAP (8).
  assert.equal(res.budget.ceiling, 8);
  assert.equal(res.budget.riskClass, 'critical');
});

test('a reviewer that returns null leaves the stage pending and closes the gate', async () => {
  const ran = [];
  const runStageReview = async ({ stage }) => { ran.push(stage.id); return stage.id === 'code-quality' ? null : { kind: 'approved', body: 'x' }; };
  const res = await runReviewPipeline({
    resolvedPipeline: resolved(), currentRevisionRef: REV, riskClass: 'high', observedAt: '2026-07-17T00:00:00Z', runStageReview,
  });
  assert.deepEqual(ran, ['code-quality'], 'stage 2 gated out by pending stage 1');
  assert.equal(res.disposition, 'pending');
  assert.equal(res.pendingStageId, 'code-quality');
});
