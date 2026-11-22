import assert from 'node:assert/strict';
import test from 'node:test';
import { livePatternScenarios, runLivePattern, head } from './live-patterns.mjs';

const DEFECTS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D7', 'D8'];

test('MRQ-11 live-pattern library: stable unique ids and every fixed defect covered', () => {
  const ids = livePatternScenarios.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^MRQ11-D[0-9]-[a-zA-Z0-9-]+$/);
  for (const defect of DEFECTS) {
    assert.ok(livePatternScenarios.some(s => s.defect === defect && !s.regression), defect);
  }
});

for (const scenario of livePatternScenarios) {
  test(`MRQ-11 ${scenario.id}`, () => {
    const { observation, patternKey } = runLivePattern(scenario);
    const decision = observation.v2Decision;
    const { expect } = scenario;
    // Missing evidence is a typed unknown, never a fold error.
    assert.equal(observation.foldError, false);
    assert.equal(decision.kind, expect.kind);
    assert.equal(decision.reason, expect.reason);
    if (expect.nextAction) assert.equal(decision.nextAction, expect.nextAction);
    if (expect.relation) assert.equal(observation.classification.relation, expect.relation);
    // Every corrected decision can carry a pattern disposition.
    assert.notEqual(patternKey, null);
    if (expect.detail) assert.equal(JSON.parse(patternKey)[2], expect.detail);
    // The corrected decision differs from the adjudicated pre-fix pattern.
    if (!scenario.regression) {
      const before = scenario.before;
      assert.ok(before.foldError || before.patternKey === null || before.kind !== decision.kind
        || before.reason !== decision.reason || before.nextAction !== decision.nextAction, scenario.id);
    }
  });
}

test('MRQ-11 D1: an active launch is translated to custody once per snapshot and released on termination', () => {
  const scenario = livePatternScenarios.find(s => s.id === 'MRQ11-D1-terminal-launch-releases-custody');
  const { events } = runLivePattern(scenario);
  const custody = events.filter(e => e.type === 'launch_custody_observed');
  assert.deepEqual(custody.map(e => [e.custody.launchRequestId, e.custody.state, e.revisionRef]),
    [['synthetic-launch', 'running', head], ['synthetic-launch', 'terminal', head]]);
  assert.ok(custody.every(e => e.custody.freshnessSeconds === 180 && e.custody.at === e.at));
});

test('MRQ-11 D5: an observed merge records merge_observed and no post-merge mergeability', () => {
  const { events } = runLivePattern(livePatternScenarios.find(s => s.id === 'MRQ11-D5-P21-done-merged'));
  const merges = events.filter(e => e.type === 'merge_observed');
  assert.equal(merges.length, 1);
  assert.equal(merges[0].mergedRevision, head);
  assert.equal(merges[0].planRequired, true);
  assert.deepEqual(events.filter(e => e.type === 'mergeability_observed').map(e => e.mergeability), ['MERGEABLE']);
});

test('MRQ-11 D4: spent rounds exhaust the review stage once across polls', () => {
  const scenario = livePatternScenarios.find(s => s.id === 'MRQ11-D4-P11-spent-rounds-final-remediation');
  const later = { ...scenario.steps[0], snapshot: () => ({ ...scenario.steps[0].snapshot(),
    observedAt: '2030-01-01T00:05:00.000Z', passId: 'synthetic-pass:later' }) };
  const repeated = { ...scenario, steps: [scenario.steps[0], later] };
  const { events } = runLivePattern(repeated);
  assert.equal(events.filter(e => e.type === 'budget_exhausted').length, 1);
});
