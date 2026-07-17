import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeStageIndex,
  invalidateStagesOnRevisionAdvance,
  stagesToRerunAfterRemediation,
} from '../src/kernel/pipeline.mjs';

const REV = 'rev-1';
const NEW_REV = 'rev-2';

const PIPELINE = {
  stages: [
    { id: 'code-quality', panel: ['cq'], aggregation: 'any-blocking-blocks' },
    { id: 'security', panel: ['sec'], aggregation: 'any-blocking-blocks' },
  ],
};

function pv(role, kind, revisionRef = REV) {
  return { reviewerRole: role, verdict: { kind, body: 'x', blockingFindings: [] }, revisionRef };
}
function stageState(stageId, stageIndex, panelVerdicts) {
  return { stageId, stageIndex, panelVerdicts };
}

// --- active stage: later stage gates on prior-clean -----------------------

test('activeStageIndex: security does not run until code-quality is clean at the revision', () => {
  const states = [
    stageState('code-quality', 0, [pv('cq', 'request-changes')]),
    stageState('security', 1, []),
  ];
  assert.equal(activeStageIndex({ pipeline: PIPELINE, stageStates: states, revisionRef: REV }), 0);
});

test('activeStageIndex: advances to security once code-quality is clean', () => {
  const states = [
    stageState('code-quality', 0, [pv('cq', 'comment-only')]),
    stageState('security', 1, []),
  ];
  assert.equal(activeStageIndex({ pipeline: PIPELINE, stageStates: states, revisionRef: REV }), 1);
});

test('activeStageIndex: equals pipeline length when all stages are clean', () => {
  const states = [
    stageState('code-quality', 0, [pv('cq', 'approved')]),
    stageState('security', 1, [pv('sec', 'approved')]),
  ];
  assert.equal(activeStageIndex({ pipeline: PIPELINE, stageStates: states, revisionRef: REV }), 2);
});

// --- re-review: failed stage + downstream ---------------------------------

test('stagesToRerunAfterRemediation: stage-2 remediation re-runs stage 2 only, not stage 1', () => {
  assert.deepEqual(
    stagesToRerunAfterRemediation({ pipeline: PIPELINE, failedStageId: 'security' }),
    ['security'],
  );
});

test('stagesToRerunAfterRemediation: stage-1 remediation re-runs stage 1 AND downstream security', () => {
  assert.deepEqual(
    stagesToRerunAfterRemediation({ pipeline: PIPELINE, failedStageId: 'code-quality' }),
    ['code-quality', 'security'],
  );
});

test('stagesToRerunAfterRemediation: unknown stage id yields nothing', () => {
  assert.deepEqual(
    stagesToRerunAfterRemediation({ pipeline: PIPELINE, failedStageId: 'nope' }),
    [],
  );
});

// --- head move invalidation -----------------------------------------------

test('invalidateStagesOnRevisionAdvance: verdicts pinned to the old revision are dropped', () => {
  const states = [
    stageState('code-quality', 0, [pv('cq', 'approved', REV)]),
    stageState('security', 1, [pv('sec', 'approved', REV)]),
  ];
  const next = invalidateStagesOnRevisionAdvance({
    pipeline: PIPELINE,
    stageStates: states,
    newRevisionRef: NEW_REV,
  });
  // Every stale verdict dropped; the whole pipeline must be re-reviewed at NEW_REV.
  assert.equal(next.every((s) => s.panelVerdicts.length === 0), true);
  assert.equal(activeStageIndex({ pipeline: PIPELINE, stageStates: next, revisionRef: NEW_REV }), 0);
});

test('invalidateStagesOnRevisionAdvance: a verdict already at the new revision is preserved', () => {
  const states = [
    stageState('code-quality', 0, [pv('cq', 'approved', NEW_REV)]),
    stageState('security', 1, [pv('sec', 'approved', REV)]),
  ];
  const next = invalidateStagesOnRevisionAdvance({
    pipeline: PIPELINE,
    stageStates: states,
    newRevisionRef: NEW_REV,
  });
  assert.equal(next[0].panelVerdicts.length, 1); // cq kept (already at NEW_REV)
  assert.equal(next[1].panelVerdicts.length, 0); // sec dropped (stale)
  // code-quality clean at NEW_REV, so the active stage is security.
  assert.equal(activeStageIndex({ pipeline: PIPELINE, stageStates: next, revisionRef: NEW_REV }), 1);
});
