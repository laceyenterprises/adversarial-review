import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

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

test('collectReplaySnapshot reads older replay DB schemas with partial timestamp columns', () => {
  const rootDir = mkdtempSync(join(os.tmpdir(), 'replay-harness-'));
  const dataDir = join(rootDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'reviews.db'));
  db.exec(`
    CREATE TABLE reviewed_prs (
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      reviewed_at TEXT NOT NULL,
      review_body TEXT
    );
    CREATE TABLE comment_deliveries (
      id INTEGER PRIMARY KEY,
      legacy_repo TEXT NOT NULL,
      legacy_pr_number INTEGER NOT NULL,
      attempted_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      round INTEGER
    );
  `);
  db.prepare(`
    INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, review_body)
    VALUES (?, ?, ?, ?)
  `).run('laceyenterprises/demo', 80, '2026-05-10T12:00:00.000Z', '## Verdict\nComment only');
  db.prepare(`
    INSERT INTO comment_deliveries (legacy_repo, legacy_pr_number, attempted_at, kind, round)
    VALUES (?, ?, ?, ?, ?)
  `).run('laceyenterprises/demo', 80, '2026-05-10T12:01:00.000Z', 'review-verdict', 1);
  db.close();

  const snapshot = collectReplaySnapshot(rootDir, {
    since: '2026-05-01T00:00:00.000Z',
    now: new Date('2026-05-11T12:00:00.000Z'),
  });

  assert.deepEqual(snapshot.parseErrors, []);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].deliveries.length, 1);
});

test('collectReplaySnapshot skips replay DB tables without window timestamp columns', () => {
  const rootDir = mkdtempSync(join(os.tmpdir(), 'replay-harness-'));
  const dataDir = join(rootDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'reviews.db'));
  db.exec(`
    CREATE TABLE reviewed_prs (
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL
    );
    CREATE TABLE comment_deliveries (
      id INTEGER PRIMARY KEY,
      legacy_repo TEXT NOT NULL,
      legacy_pr_number INTEGER NOT NULL
    );
  `);
  db.prepare('INSERT INTO reviewed_prs (repo, pr_number) VALUES (?, ?)').run('laceyenterprises/demo', 80);
  db.prepare('INSERT INTO comment_deliveries (legacy_repo, legacy_pr_number) VALUES (?, ?)').run('laceyenterprises/demo', 80);
  db.close();

  const snapshot = collectReplaySnapshot(rootDir, {
    since: '2026-05-01T00:00:00.000Z',
    now: new Date('2026-05-11T12:00:00.000Z'),
  });

  assert.deepEqual(snapshot.parseErrors, []);
  assert.deepEqual(snapshot.records, []);
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

test('normalizeReplaySnapshot routes fully-unidentifiable records into unidentifiedRecords', () => {
  // Records without typed identity AND without legacy repo+prNumber must
  // not be merged through 'unknown-subject' — that hides input drift.
  const snapshot = normalizeReplaySnapshot({
    records: [
      { reviewBody: '## Verdict\nRequest changes' },
      { reviewBody: '## Verdict\nComment only' },
    ],
  });
  assert.deepEqual(snapshot.records, []);
  assert.equal(snapshot.unidentifiedRecords.length, 2);
});

test('two records for one PR at different revisions stay distinct (no cross-revision collision)', () => {
  // Whether keyed typed (`code-pr:...@sha`) or legacy (`legacy:...@sha`),
  // two records at different revisionRefs must NOT merge into one subject.
  // The earlier legacy key omitted revisionRef and would have collapsed
  // these; the typed path already includes it. Pin both behaviors.
  const snapshot = normalizeReplaySnapshot({
    records: [
      { repo: 'foo/bar', prNumber: 7, revisionRef: 'sha-a', reviewBody: '## Verdict\nRequest changes' },
      { repo: 'foo/bar', prNumber: 7, revisionRef: 'sha-b', reviewBody: '## Verdict\nComment only' },
    ],
  });
  assert.equal(snapshot.records.length, 2);
  const keys = snapshot.records.map((r) => r.key).sort();
  for (const key of keys) {
    assert.ok(key.includes('@sha-a') || key.includes('@sha-b'), `expected revisionRef in key, got ${key}`);
  }
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
