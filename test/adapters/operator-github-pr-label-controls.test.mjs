import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGitHubPRLabelControlsAdapter,
  legacyLabelEventFromControlResult,
} from '../../src/adapters/operator/github-pr-label-controls/index.mjs';

const subjectRef = {
  domainId: 'code-pr',
  subjectExternalId: 'laceyenterprises/adversarial-review#486',
  revisionRef: 'new-sha',
};

const controls = [
  ['operator-approved', 'observeOperatorApproved'],
  ['force-rereview', 'observeForceRereview'],
  ['halted-loop', 'observeHaltedLoop'],
  ['raised-round-cap', 'observeRaisedRoundCap'],
  ['merge-agent-requested', 'observeMergeAgentOverride'],
];

function makeAdapter(event, calls = []) {
  return createGitHubPRLabelControlsAdapter({
    fetchLatestLabelEventImpl: async (repo, prNumber, labelName) => {
      calls.push({ repo, prNumber, labelName });
      return typeof event === 'function' ? event(labelName) : event;
    },
    execFileImpl: async () => ({ stdout: '{}' }),
  });
}

function currentEvent(label) {
  return {
    id: `evt-${label}`,
    nodeId: `node-${label}`,
    label,
    actor: 'placey',
    createdAt: '2026-05-10T17:00:00.000Z',
    headSha: 'new-sha',
    codeScopedAt: '2026-05-10T16:59:00.000Z',
  };
}

for (const [label, method] of controls) {
  test(`${label} applies when the label event is scoped to the current head`, async () => {
    const calls = [];
    const adapter = makeAdapter(currentEvent(label), calls);

    const result = await adapter[method](subjectRef, 'new-sha');

    assert.equal(result.applied, true);
    assert.equal(result.observedRevisionRef, 'new-sha');
    assert.equal(result.actor, 'placey');
    assert.equal(result.eventId, `evt-${label}`);
    assert.equal(result.observedAt, '2026-05-10T17:00:00.000Z');
    assert.equal(calls[0].repo, 'laceyenterprises/adversarial-review');
    assert.equal(calls[0].prNumber, 486);
    assert.equal(calls[0].labelName, label);
  });

  test(`${label} fails closed when the label event is stale`, async () => {
    const adapter = makeAdapter({
      ...currentEvent(label),
      headSha: 'old-sha',
    });

    const result = await adapter[method](subjectRef, 'new-sha');

    assert.equal(result.applied, false);
    assert.equal(result.reason, 'stale: label applied at old-sha, current head is new-sha');
    assert.equal(result.observedRevisionRef, 'old-sha');
  });

  test(`${label} fails closed when the label event is non-attributable`, async () => {
    const adapter = makeAdapter({
      ...currentEvent(label),
      actor: null,
    });

    const result = await adapter[method](subjectRef, 'new-sha');

    assert.equal(result.applied, false);
    assert.equal(result.reason, 'non-attributable');
  });
}

test('observeOverrides returns a revision-scoped operator override set', async () => {
  const adapter = makeAdapter((labelName) => currentEvent(labelName));

  const overrides = await adapter.observeOverrides(subjectRef, 'new-sha');

  assert.equal(overrides.expectedRevisionRef, 'new-sha');
  assert.equal(overrides.observedRevisionRef, 'new-sha');
  assert.equal(overrides.operatorApproved, true);
  assert.equal(overrides.forceRereview, true);
  assert.equal(overrides.halted, true);
  assert.equal(overrides.events.length, 4);
  assert.deepEqual(
    overrides.events.map((event) => event.type),
    ['force-rereview', 'operator-approved', 'halted', 'raised-round-cap']
  );
});

test('legacyLabelEventFromControlResult converts applied controls for existing merge-gate callers', () => {
  const converted = legacyLabelEventFromControlResult(
    {
      applied: true,
      observedRevisionRef: 'new-sha',
      actor: 'placey',
      eventId: 'evt-operator-approved',
      observedAt: '2026-05-10T17:00:00.000Z',
      codeScopedAt: '2026-05-10T16:59:00.000Z',
    },
    'operator-approved'
  );

  assert.equal(converted.label, 'operator-approved');
  assert.equal(converted.actor, 'placey');
  assert.equal(converted.headSha, 'new-sha');
  assert.equal(converted.createdAt, '2026-05-10T17:00:00.000Z');
});
