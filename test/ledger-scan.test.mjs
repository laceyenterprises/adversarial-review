import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { buildFollowUpJob, getFollowUpJobDir, listFollowUpJobsInDir, summarizePRRemediationLedger } from '../src/follow-up-jobs.mjs';
import { followUpJobFilePrefix } from '../src/follow-up-job-names.mjs';
import { findActiveRemediationJob } from '../src/ama/active-remediation-job.mjs';
import { findLatestFollowUpJob, findFollowUpJobForRevision } from '../src/operator-retrigger-helpers.mjs';
import { findLatestFollowUpJobForPR, listMergeAgentDispatches, recordMergeAgentDispatch } from '../src/follow-up-merge-agent.mjs';
import { ledgerSubjects, writeLedgerScanFixture } from './helpers/ledger-scan-fixture.mjs';

function fixtureRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'ledger-scan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function captureReads(t, fn) {
  const read = fs.readFileSync;
  const paths = [];
  const spy = t.mock.method(fs, 'readFileSync', (...args) => {
    paths.push(String(args[0]));
    return read(...args);
  });
  syncBuiltinESMExports();
  try {
    return { result: fn(), paths };
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
}

test('LEDGERSCAN-01: every summary field matches the original whole-directory scan', (t) => {
  const root = fixtureRoot(t);
  writeLedgerScanFixture(root);
  // Frozen from the original implementation against writeLedgerScanFixture,
  // before narrowing the full-ledger scan. No deployed job data is used.
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/ledger-scan/legacy-summaries.json', import.meta.url), 'utf8'));
  assert.deepEqual(baseline.map(({ subject }) => subject), ledgerSubjects);
  t.mock.method(console, 'error', () => {});
  for (const { subject, full, refunds } of baseline) {
    for (const [refundsOnly, expected] of [[false, full], [true, refunds]]) {
      const actual = summarizePRRemediationLedger(root, subject, { refundsOnly });
      assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
      for (const field of Object.keys(expected)) {
        assert.deepEqual(actual[field], expected[field], `${JSON.stringify(subject)} refundsOnly=${refundsOnly} field=${field}`);
      }
    }
  }
});

for (const refundsOnly of [false, true]) {
  test(`LEDGERSCAN-01: summary reads only the PR filename prefix (refundsOnly=${refundsOnly})`, (t) => {
    const root = fixtureRoot(t);
    const files = writeLedgerScanFixture(root);
    const subject = ledgerSubjects[0];
    const prefix = followUpJobFilePrefix(subject.repo, subject.prNumber);
    const expected = files.filter((file) => basename(file).startsWith(prefix)).sort();
    t.mock.method(console, 'error', () => {});
    const { paths } = captureReads(t, () => summarizePRRemediationLedger(root, subject, { refundsOnly }));
    // Exclude the direct per-PR void/recovery lookups; include all job buckets
    // and archived records. Prefix collisions still require parsed identity checks.
    const jobReads = paths.filter((file) => /\/(pending|in-progress|completed|failed|stopped|stopped-archived\/[^/]+)\/[^/]+\.json$/u.test(file));
    assert.deepEqual(jobReads.sort(), expected);
    assert.ok(jobReads.length < files.length);
    assert.ok(!jobReads.some((file) => basename(file).startsWith('sample__project-pr-8776-')));
    assert.equal(console.error.mock.calls.length, 2, 'both unreadable target records are reported');
  });
}

function writeJob(root, bucket, repo, prNumber, suffix, overrides = {}) {
  const job = { ...buildFollowUpJob({ repo, prNumber, reviewerModel: 'codex',
    reviewBody: '## Verdict\nRequest changes', reviewPostedAt: '2026-01-01T00:00:00.000Z' }),
    status: bucket, lastHeartbeatAt: new Date().toISOString(), ...overrides };
  const dir = getFollowUpJobDir(root, bucket);
  mkdirSync(dir, { recursive: true });
  const jobPath = join(dir, `${followUpJobFilePrefix(repo, prNumber)}${suffix}.json`);
  writeFileSync(jobPath, JSON.stringify(job));
  return jobPath;
}

test('LEDGERSCAN-01: sibling PR lookups skip unrelated files and retain parsed identity checks', (t) => {
  const root = fixtureRoot(t);
  const subject = { repo: 'sample/project', prNumber: 87 };
  const expected = [];
  for (const bucket of ['pending', 'inProgress', 'completed', 'failed', 'stopped']) {
    expected.push(writeJob(root, bucket, subject.repo, subject.prNumber, 'target', {
      revisionRef: 'a'.repeat(40), completedAt: bucket === 'completed' ? '2026-01-02T00:00:00.000Z' : null,
    }));
    writeJob(root, bucket, subject.repo, 8776, 'near');
    writeJob(root, bucket, 'sample/other', 87, 'other');
    expected.push(writeJob(root, bucket, subject.repo, subject.prNumber, 'spoof', {
      repo: 'sample/other', completedAt: '2026-02-01T00:00:00.000Z',
    }));
    writeFileSync(join(getFollowUpJobDir(root, bucket), 'unrelated-corrupt.json'), '{');
  }
  for (const lookup of [
    () => findLatestFollowUpJob(root, subject)?.job,
    () => findLatestFollowUpJobForPR(root, subject),
    () => findFollowUpJobForRevision(root, { ...subject, revisionRef: 'a'.repeat(40) })?.job,
    () => findActiveRemediationJob(root, subject),
  ]) {
    const { result, paths } = captureReads(t, lookup);
    assert.equal(result.repo, subject.repo);
    assert.equal(result.prNumber, subject.prNumber);
    assert.ok(paths.length > 0);
    assert.ok(paths.every((file) => expected.includes(file)), paths.join('\n'));
  }
  for (const bucket of ['pending', 'inProgress']) {
    const { result, paths } = captureReads(t, () => listFollowUpJobsInDir(root, bucket, subject));
    assert.equal(result.length, 2, 'filename narrowing leaves parsed identity decisions to callers');
    assert.ok(paths.every((file) => expected.includes(file)));
  }
});

test('LEDGERSCAN-01: active ownership lookups retain case-insensitive repo matching', (t) => {
  const root = fixtureRoot(t);
  const target = writeJob(root, 'pending', 'Sample/Project', 87, 'target');
  writeJob(root, 'pending', 'Sample/Project', 8776, 'near');
  const subject = { repo: 'sample/project', prNumber: 87 };
  const { result, paths } = captureReads(t, () => findActiveRemediationJob(root, subject));
  assert.equal(result.repo, 'Sample/Project');
  assert.deepEqual(paths, [target]);
  assert.equal(listFollowUpJobsInDir(root, 'pending', subject).length, 0);
  assert.equal(listFollowUpJobsInDir(root, 'pending', { ...subject, caseInsensitiveRepo: true }).length, 1);
  assert.equal(listFollowUpJobsInDir(root, 'pending').length, 2, 'unscoped readers still see the whole bucket');
});

test('LEDGERSCAN-01: 253 job files require only 3 job reads for the target PR', (t) => {
  const root = fixtureRoot(t);
  const subject = { repo: 'sample/project', prNumber: 87 };
  for (let pr = 100; pr < 350; pr++) writeJob(root, 'completed', subject.repo, pr, 'history');
  const expected = ['pending', 'inProgress', 'completed'].map((bucket) =>
    writeJob(root, bucket, subject.repo, subject.prNumber, 'target'));
  const { paths } = captureReads(t, () => summarizePRRemediationLedger(root, subject));
  assert.deepEqual(paths.filter((file) => !file.includes('/single-review-voids/')).sort(), expected.sort());
  const missing = captureReads(t, () => summarizePRRemediationLedger(root, { ...subject, prNumber: 999 }));
  assert.equal(missing.paths.filter((file) => !file.includes('/single-review-voids/')).length, 0);
});

test('LEDGERSCAN-01: filtered merge-agent dispatch lookup reads only its PR', (t) => {
  const root = fixtureRoot(t);
  const dir = join(root, 'data', 'follow-up-jobs', 'merge-agent-dispatches');
  mkdirSync(dir, { recursive: true });
  const records = [
    { repo: 'sample/project', prNumber: 87 },
    { repo: 'sample/project', prNumber: 8776 },
    { repo: 'sample/other', prNumber: 87 },
  ];
  for (const record of records) writeFileSync(join(dir, `${followUpJobFilePrefix(record.repo, record.prNumber)}head.json`), JSON.stringify(record));
  const { result, paths } = captureReads(t, () => listMergeAgentDispatches(root, records[0]));
  assert.deepEqual(result, [records[0]]);
  assert.deepEqual(paths, [join(dir, 'sample__project-pr-87-head.json')]);
  assert.deepEqual(new Set(listMergeAgentDispatches(root).map(JSON.stringify)), new Set(records.map(JSON.stringify)));
});

test('LEDGERSCAN-01: dispatch prefix matches production filenames and rejects sanitized repo collisions', (t) => {
  const root = fixtureRoot(t);
  const subject = { repo: 'sample/proj+ect._-', prNumber: 87 };
  const target = recordMergeAgentDispatch(root, { ...subject, headSha: 'target' });
  const collision = recordMergeAgentDispatch(root, { repo: 'sample/proj?ect._-', prNumber: 87, headSha: 'collision' });
  recordMergeAgentDispatch(root, { ...subject, prNumber: 8776, headSha: 'near' });
  recordMergeAgentDispatch(root, { repo: 'sample/other', prNumber: 87, headSha: 'other' });

  const { result, paths } = captureReads(t, () => listMergeAgentDispatches(root, subject));
  assert.deepEqual(paths.sort(), [target, collision].sort());
  assert.equal(result.length, 1);
  assert.equal(result[0].repo, subject.repo);
  assert.equal(result[0].headSha, 'target');
});
