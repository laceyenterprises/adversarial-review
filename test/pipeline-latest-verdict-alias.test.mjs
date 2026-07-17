import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveLatestVerdict,
  singleStagePipeline,
} from '../src/kernel/pipeline.mjs';

const REV = 'rev-1';

function verdict(kind) {
  return { kind, body: kind, blockingFindings: [] };
}
function pv(role, kind, revisionRef = REV) {
  return { reviewerRole: role, verdict: verdict(kind), revisionRef };
}

// --- alias compatibility: legacy single-stage subjects --------------------

test('deriveLatestVerdict: a legacy subject with no pipeline returns its own latestVerdict', () => {
  const subject = {
    ref: { domainId: 'code-pr', subjectExternalId: 'r#1', revisionRef: REV },
    latestVerdict: verdict('request-changes'),
  };
  assert.equal(deriveLatestVerdict(subject), subject.latestVerdict);
});

test('deriveLatestVerdict: an empty-pipeline subject falls back to latestVerdict', () => {
  const subject = {
    ref: { domainId: 'code-pr', subjectExternalId: 'r#1', revisionRef: REV },
    pipeline: [],
    latestVerdict: verdict('comment-only'),
  };
  assert.equal(deriveLatestVerdict(subject), subject.latestVerdict);
});

// --- alias resolution: pipeline subjects ----------------------------------

test('deriveLatestVerdict: single-stage pipeline resolves to the stage newest verdict', () => {
  const pipeline = singleStagePipeline({ reviewerRole: 'code-quality-reviewer' });
  const subject = {
    ref: { domainId: 'code-pr', subjectExternalId: 'r#1', revisionRef: REV },
    pipeline: [
      {
        stageId: 'code-review',
        stageIndex: 0,
        panelVerdicts: [pv('code-quality-reviewer', 'comment-only'), pv('code-quality-reviewer', 'approved')],
      },
    ],
  };
  const latest = deriveLatestVerdict(subject, { pipeline });
  assert.equal(latest.kind, 'approved'); // newest of the active stage
});

test('deriveLatestVerdict: two-stage pipeline resolves to the active (blocking) stage newest verdict', () => {
  const pipeline = {
    stages: [
      { id: 'code-quality', panel: ['cq'], aggregation: 'any-blocking-blocks' },
      { id: 'security', panel: ['sec'], aggregation: 'any-blocking-blocks' },
    ],
  };
  const subject = {
    ref: { domainId: 'code-pr', subjectExternalId: 'r#1', revisionRef: REV },
    pipeline: [
      { stageId: 'code-quality', stageIndex: 0, panelVerdicts: [pv('cq', 'approved')] },
      { stageId: 'security', stageIndex: 1, panelVerdicts: [pv('sec', 'request-changes')] },
    ],
  };
  // code-quality clean, security blocking => active stage is security.
  const latest = deriveLatestVerdict(subject, { pipeline });
  assert.equal(latest.kind, 'request-changes');
});

test('singleStagePipeline: mirrors the pre-pipeline shape (one stage, one role, any-blocking-blocks)', () => {
  const pipeline = singleStagePipeline({
    reviewerRole: 'code-quality-reviewer',
    domainRiskClasses: { high: { maxRemediationRounds: 3 } },
  });
  assert.equal(pipeline.stages.length, 1);
  assert.deepEqual(pipeline.stages[0].panel, ['code-quality-reviewer']);
  assert.equal(pipeline.stages[0].aggregation, 'any-blocking-blocks');
  assert.equal(pipeline.stages[0].roundBudgetByRisk.high, 3);
});
