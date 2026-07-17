import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_AGGREGATION,
  aggregatePanel,
  activeStageIndex,
  deriveLatestVerdict,
  invalidateStagesOnRevisionAdvance,
  isVerdictClean,
  normalizeAggregation,
  resolveStageRoundBudget,
  resolveSubjectRemediationCeiling,
  singleStagePipeline,
  stagesToRerunAfterRemediation,
  PipelineContractError,
} from '../src/kernel/pipeline.mjs';

const REV = 'rev-abc';

function verdict(kind, blocking = []) {
  return { kind, body: 'x', blockingFindings: blocking };
}
function pv(role, kind, revisionRef = REV, blocking = []) {
  return { reviewerRole: role, verdict: verdict(kind, blocking), revisionRef };
}

// --- isVerdictClean -------------------------------------------------------

test('isVerdictClean: comment-only and approved with no findings are clean', () => {
  assert.equal(isVerdictClean(verdict('comment-only')), true);
  assert.equal(isVerdictClean(verdict('approved')), true);
});

test('isVerdictClean: request-changes, unknown, or any blocking finding is not clean', () => {
  assert.equal(isVerdictClean(verdict('request-changes')), false);
  assert.equal(isVerdictClean(verdict('unknown')), false);
  assert.equal(isVerdictClean(verdict('comment-only', [{ problem: 'x' }])), false);
  assert.equal(isVerdictClean(null), false);
});

// --- aggregatePanel: policies --------------------------------------------

test('any-blocking-blocks: one blocking verdict blocks the stage', () => {
  const r = aggregatePanel({
    panel: ['a', 'b'],
    aggregation: 'any-blocking-blocks',
    panelVerdicts: [pv('a', 'comment-only'), pv('b', 'request-changes')],
    revisionRef: REV,
  });
  assert.equal(r.decision, 'blocked');
});

test('any-blocking-blocks: all clean passes', () => {
  const r = aggregatePanel({
    panel: ['a', 'b'],
    aggregation: 'any-blocking-blocks',
    panelVerdicts: [pv('a', 'comment-only'), pv('b', 'approved')],
    revisionRef: REV,
  });
  assert.equal(r.decision, 'clean');
});

test('unanimous-clean: any non-clean vote blocks', () => {
  const clean = aggregatePanel({
    panel: ['a', 'b'],
    aggregation: 'unanimous-clean',
    panelVerdicts: [pv('a', 'approved'), pv('b', 'comment-only')],
    revisionRef: REV,
  });
  assert.equal(clean.decision, 'clean');
  const blocked = aggregatePanel({
    panel: ['a', 'b'],
    aggregation: 'unanimous-clean',
    panelVerdicts: [pv('a', 'approved'), pv('b', 'request-changes')],
    revisionRef: REV,
  });
  assert.equal(blocked.decision, 'blocked');
});

test('quorum(2): two of three clean passes; one clean blocks', () => {
  const pass = aggregatePanel({
    panel: ['a', 'b', 'c'],
    aggregation: { kind: 'quorum', n: 2 },
    panelVerdicts: [pv('a', 'approved'), pv('b', 'approved'), pv('c', 'request-changes')],
    revisionRef: REV,
  });
  assert.equal(pass.decision, 'clean');
  const fail = aggregatePanel({
    panel: ['a', 'b', 'c'],
    aggregation: { kind: 'quorum', n: 2 },
    panelVerdicts: [pv('a', 'approved'), pv('b', 'request-changes'), pv('c', 'request-changes')],
    revisionRef: REV,
  });
  assert.equal(fail.decision, 'blocked');
});

test('weighted: clean weight must meet threshold', () => {
  const agg = { kind: 'weighted', weights: { a: 1, b: 2 }, threshold: 2 };
  const pass = aggregatePanel({
    panel: ['a', 'b'],
    aggregation: agg,
    panelVerdicts: [pv('a', 'request-changes'), pv('b', 'approved')],
    revisionRef: REV,
  });
  assert.equal(pass.decision, 'clean'); // b alone (weight 2) meets threshold
  const fail = aggregatePanel({
    panel: ['a', 'b'],
    aggregation: agg,
    panelVerdicts: [pv('a', 'approved'), pv('b', 'request-changes')],
    revisionRef: REV,
  });
  assert.equal(fail.decision, 'blocked'); // a alone (weight 1) below threshold
});

test('aggregatePanel: incomplete until every panel role votes at the revision', () => {
  const r = aggregatePanel({
    panel: ['a', 'b'],
    aggregation: 'any-blocking-blocks',
    panelVerdicts: [pv('a', 'approved')],
    revisionRef: REV,
  });
  assert.equal(r.decision, 'incomplete');
  assert.deepEqual(r.missingRoles, ['b']);
});

test('aggregatePanel: verdicts for a different revision do not count', () => {
  const r = aggregatePanel({
    panel: ['a'],
    aggregation: 'any-blocking-blocks',
    panelVerdicts: [pv('a', 'approved', 'stale-rev')],
    revisionRef: REV,
  });
  assert.equal(r.decision, 'incomplete');
  assert.deepEqual(r.missingRoles, ['a']);
});

test('normalizeAggregation rejects an unknown policy with a classified error', () => {
  assert.throws(() => normalizeAggregation({ kind: 'nonsense' }), (err) => {
    assert.ok(err instanceof PipelineContractError);
    assert.equal(err.reason, 'unknown-aggregation');
    return true;
  });
});

test('DEFAULT_AGGREGATION is the single-reviewer any-blocking-blocks policy', () => {
  assert.equal(DEFAULT_AGGREGATION, 'any-blocking-blocks');
});
