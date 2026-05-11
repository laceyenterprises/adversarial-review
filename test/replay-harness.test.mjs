import test from 'node:test';
import assert from 'node:assert/strict';

import {
  diffReplaySnapshots,
  normalizeApprovalOverrides,
} from '../scripts/replay-30-day.mjs';

const subjectRef = {
  domainId: 'code-pr',
  subjectExternalId: 'laceyenterprises/demo#7',
  revisionRef: 'sha-current',
};

const productionFixture = {
  records: [{
    subjectRef,
    reviewBody: [
      '## Summary',
      'Review found a blocking issue.',
      '',
      '## Verdict',
      'Request changes',
    ].join('\n'),
    remediationReply: {
      addressed: [{ title: 'Fix null guard', finding: 'Missing null guard', action: 'Added guard' }],
      pushback: [{ title: 'Keep API', finding: 'Rename public function', reasoning: 'Would break callers' }],
      blockers: [{ title: 'Needs secret', finding: 'Cannot validate deploy', needsHumanInput: 'Deploy token required' }],
    },
    deliveries: [
      { key: { ...subjectRef, round: 1, kind: 'review-verdict' } },
      { key: { ...subjectRef, round: 1, kind: 'remediation-reply' } },
    ],
    approvalOverrides: [{
      subjectRef,
      expectedRevisionRef: 'sha-current',
      observedRevisionRef: 'sha-current',
      events: [
        {
          type: 'operator-approved',
          revisionRef: 'sha-current',
          eventExternalId: 'label-1',
          observedAt: '2026-05-11T12:00:00.000Z',
        },
        {
          type: 'force-rereview',
          revisionRef: 'sha-old',
          eventExternalId: 'label-stale',
          observedAt: '2026-05-11T12:01:00.000Z',
        },
      ],
    }],
  }],
};

const stagingFixture = {
  records: [{
    subjectRef,
    reviewBody: [
      '## Summary',
      'Review only left notes.',
      '',
      '## Verdict',
      'Comment only',
    ].join('\n'),
    remediationReply: {
      addressed: [{ title: 'Fix null guard', finding: 'Missing null guard', action: 'Added guard' }],
      pushback: [],
      blockers: [{ title: 'Needs secret', finding: 'Cannot validate deploy', needsHumanInput: 'Deploy token required' }],
    },
    deliveries: [
      { key: { ...subjectRef, round: 1, kind: 'review-verdict' } },
      { key: { ...subjectRef, round: 1, kind: 'review-verdict' } },
    ],
    approvalOverrides: [{
      subjectRef,
      expectedRevisionRef: 'sha-current',
      observedRevisionRef: 'sha-old',
      events: [{
        type: 'operator-approved',
        revisionRef: 'sha-old',
        eventExternalId: 'label-stale',
        observedAt: '2026-05-11T12:00:00.000Z',
      }],
    }],
  }],
};

test('replay harness produces deterministic diffs on a fixture pair', () => {
  const first = diffReplaySnapshots(productionFixture, stagingFixture);
  const second = diffReplaySnapshots(productionFixture, stagingFixture);

  assert.deepEqual(first.differences, second.differences);
  assert.equal(first.ok, false);
  assert.deepEqual(
    first.differences.map((diff) => diff.field),
    [
      'verdictState',
      'approvalOverrides',
      'duplicateDeliveryRows',
      'deliveryRows',
      'remediation',
    ]
  );
  assert.deepEqual(first.differences.find((diff) => diff.field === 'verdictState'), {
    subject: 'code-pr:laceyenterprises/demo#7@sha-current',
    field: 'verdictState',
    expected: 'request-changes',
    actual: 'comment-only',
  });
});

test('replay harness reports zero diff for equivalent snapshots', () => {
  const report = diffReplaySnapshots(productionFixture, productionFixture);

  assert.equal(report.ok, true);
  assert.deepEqual(report.differences, []);
});

test('approval override normalization drops stale observed revisions', () => {
  const overrides = normalizeApprovalOverrides({
    approvalOverrides: [{
      subjectRef,
      expectedRevisionRef: 'sha-current',
      observedRevisionRef: 'sha-current',
      events: [
        { type: 'operator-approved', revisionRef: 'sha-current', eventExternalId: 'fresh' },
        { type: 'force-rereview', revisionRef: 'sha-old', eventExternalId: 'stale' },
      ],
    }],
  }, subjectRef);

  assert.deepEqual(overrides, [{
    type: 'operator-approved',
    subject: 'code-pr:laceyenterprises/demo#7',
    observedRevisionRef: 'sha-current',
    expectedRevisionRef: 'sha-current',
    eventExternalId: 'fresh',
    roundCap: null,
  }]);
});
