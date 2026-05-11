import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';

import {
  collectReplaySnapshot,
  diffReplaySnapshots,
  normalizeApprovalOverrides,
  normalizeReplaySnapshot,
  parseArgs,
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
  assert.deepEqual(new Set(first.differences.map((diff) => diff.field)), new Set([
    'verdictState',
    'approvalOverrides',
    'duplicateDeliveryRows',
    'deliveryRows',
    'remediation',
  ]));
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

test('approval override normalization only accepts integer round caps from numeric input', () => {
  const normalizeRoundCap = (roundCap) => normalizeApprovalOverrides({
    approvalOverrides: [{
      subjectRef,
      expectedRevisionRef: 'sha-current',
      observedRevisionRef: 'sha-current',
      events: [{
        type: 'operator-approved',
        revisionRef: 'sha-current',
        eventExternalId: 'fresh',
        roundCap,
      }],
    }],
  }, subjectRef)[0]?.roundCap ?? null;

  assert.equal(normalizeRoundCap(3), 3);
  assert.equal(normalizeRoundCap(' 3 '), 3);
  assert.equal(normalizeRoundCap(''), null);
  assert.equal(normalizeRoundCap(null), null);
  assert.equal(normalizeRoundCap(false), null);
  assert.equal(normalizeRoundCap([]), null);
  assert.equal(normalizeRoundCap('3.5'), null);
});

test('collectReplaySnapshot surfaces terminal job JSON parse failures', () => {
  const rootDir = mkdtempSync(join(os.tmpdir(), 'replay-harness-'));
  const completedDir = join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(completedDir, { recursive: true });
  writeFileSync(join(completedDir, 'broken.json'), '{"jobId":', 'utf8');

  const snapshot = collectReplaySnapshot(rootDir, {
    since: '2026-05-01T00:00:00.000Z',
    now: new Date('2026-05-11T12:00:00.000Z'),
  });

  assert.equal(snapshot.records.length, 0);
  assert.equal(snapshot.parseErrors.length, 1);
  assert.equal(snapshot.parseErrors[0].source, 'terminal-job-json');

  const report = diffReplaySnapshots({ records: [] }, snapshot);
  assert.equal(report.ok, false);
  assert.deepEqual(report.differences.find((diff) => diff.field === 'parseErrors'), {
    subject: '__snapshot__',
    field: 'parseErrors',
    expected: [],
    actual: snapshot.parseErrors,
  });
});

test('normalizeReplaySnapshot surfaces conflicting verdict merges deterministically', () => {
  const requestChanges = {
    subjectRef,
    reviewBody: '## Verdict\nRequest changes',
  };
  const commentOnly = {
    subjectRef,
    reviewBody: '## Verdict\nComment only',
  };

  const first = normalizeReplaySnapshot({ records: [requestChanges, commentOnly] });
  const second = normalizeReplaySnapshot({ records: [commentOnly, requestChanges] });

  assert.deepEqual(first, second);
  assert.equal(first.records[0].verdictState, 'conflict');
  assert.deepEqual(first.subjectConflicts, [{
    subject: subjectRef,
    verdictStates: ['comment-only', 'request-changes'],
  }]);
});

test('normalizeReplaySnapshot routes typed records without revisionRef into unkeyedRecords', () => {
  const snapshot = normalizeReplaySnapshot({
    records: [{
      subjectRef: {
        domainId: 'code-pr',
        subjectExternalId: 'laceyenterprises/demo#7',
        revisionRef: null,
      },
      reviewBody: '## Verdict\nComment only',
    }],
  });

  assert.deepEqual(snapshot.records, []);
  assert.deepEqual(snapshot.unkeyedRecords, [{
    subject: {
      domainId: 'code-pr',
      subjectExternalId: 'laceyenterprises/demo#7',
      revisionRef: null,
    },
    verdictState: 'comment-only',
  }]);
});

test('parseArgs tokenizes replay commands without a shell', () => {
  const args = parseArgs([
    '--production-root', '/tmp/prod',
    '--staging-root', '/tmp/stage',
    '--replay-command', './scripts/replay-stage.mjs',
    '--replay-command-arg', '--job',
    '--replay-command-arg', 'demo',
  ]);

  assert.deepEqual(args.replayCommand, {
    command: resolve('./scripts/replay-stage.mjs'),
    args: ['--job', 'demo'],
  });
});
