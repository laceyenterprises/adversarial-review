// ASR-03 — the Argus security review queue.
//
// The two properties under test are the two halves of the idempotency
// contract, and they pull in opposite directions:
//
//   * a re-poll at the SAME head must not duplicate work, and
//   * a NEW head MUST enqueue again, because a security review is a statement
//     about the exact tree it read. Reusing a verdict across a new commit is
//     approving a tree nobody looked at.
//
// Getting one right by breaking the other is the realistic failure, so both
// are asserted against every bucket a prior job might be sitting in — pending,
// in-progress, completed and failed. A dedupe check that only scans `pending`
// passes the naive test and re-runs every finished review.
//
// The third property is the depth read Sentinel uses: a stuck Argus queue has
// to be visible, so depth is asserted to stay accurate across bucket
// transitions and past the newest-N record read cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ARGUS_JOB_BUCKETS,
  ARGUS_JOB_KIND,
  ARGUS_JOB_SCHEMA_VERSION,
  buildArgusJobId,
  claimNextArgusJob,
  completeArgusJob,
  ensureArgusJobDirs,
  enqueueArgusSecurityReview,
  failArgusJob,
  findArgusJob,
  getArgusJobDir,
  listArgusJobs,
  readArgusJob,
  readArgusQueueDepth,
  resolveEnqueueRace,
} from '../src/argus-security-queue.mjs';
import { classifySecuritySurface } from '../src/security-surface-classifier.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'c'.repeat(40);

function makeRoot() {
  return mkdtempSync(path.join(tmpdir(), 'argus-queue-'));
}

function reasonsFixture() {
  const { needsReview, reasons } = classifySecuritySurface({
    author: 'dependabot[bot]',
    changedFiles: ['package-lock.json'],
  });
  assert.equal(needsReview, true);
  return reasons;
}

function enqueue(rootDir, overrides = {}) {
  return enqueueArgusSecurityReview({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 909,
    headSha: HEAD_A,
    reasons: reasonsFixture(),
    ...overrides,
  });
}

function bucketNames(rootDir, bucket) {
  const dir = getArgusJobDir(rootDir, bucket);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).sort() : [];
}

function allJsonFileCount(rootDir) {
  return ARGUS_JOB_BUCKETS.reduce((sum, bucket) => sum + bucketNames(rootDir, bucket).length, 0);
}

test('enqueue records repo, prNumber, headSha, ASR-02 reasons and enqueue time', () => {
  const rootDir = makeRoot();
  const enqueuedAt = '2026-08-25T12:00:00.000Z';
  const result = enqueue(rootDir, { enqueuedAt, source: 'watcher-poll' });

  assert.equal(result.enqueued, true);
  assert.equal(result.outcome, 'created');
  assert.equal(result.bucket, 'pending');

  const job = readArgusJob(result.jobPath);
  assert.equal(job.schemaVersion, ARGUS_JOB_SCHEMA_VERSION);
  assert.equal(job.kind, ARGUS_JOB_KIND);
  assert.equal(job.status, 'pending');
  assert.equal(job.repo, 'laceyenterprises/adversarial-review');
  assert.equal(job.prNumber, 909);
  assert.equal(job.headSha, HEAD_A);
  assert.equal(job.enqueuedAt, enqueuedAt);
  assert.equal(job.source, 'watcher-poll');

  // The triggers are persisted verbatim: the queue routes on ASR-02's reasons
  // and never reinterprets or collapses them into a boolean.
  assert.deepEqual(job.reasons, reasonsFixture());
  assert.deepEqual(
    job.reasons.map((reason) => reason.trigger).sort(),
    ['bot-author', 'manifest-change']
  );
});

test('the queue lives beside data/follow-up-jobs, never inside it', () => {
  const rootDir = makeRoot();
  enqueue(rootDir);

  assert.equal(existsSync(path.join(rootDir, 'data', 'follow-up-jobs')), false);
  assert.match(getArgusJobDir(rootDir, 'pending'), /data\/argus-security-jobs\/pending$/u);
});

test('re-enqueue at the same head is a no-op while the job is still pending', () => {
  const rootDir = makeRoot();
  const first = enqueue(rootDir, { enqueuedAt: '2026-08-25T12:00:00.000Z' });
  const second = enqueue(rootDir, { enqueuedAt: '2026-08-25T12:05:00.000Z' });

  assert.equal(second.enqueued, false);
  assert.equal(second.outcome, 'duplicate');
  assert.equal(second.bucket, 'pending');
  assert.equal(second.jobPath, first.jobPath);

  // The original record is untouched — a re-poll must not restart the clock on
  // an already-queued job, or an aging job never looks aged to Sentinel.
  assert.equal(readArgusJob(first.jobPath).enqueuedAt, '2026-08-25T12:00:00.000Z');
  assert.equal(allJsonFileCount(rootDir), 1);
});

// The dedupe check has to look in every bucket. Scanning only `pending` would
// re-enqueue — and so re-run — every security review the moment it is claimed
// or finished, which is the loop this contract exists to prevent.
for (const [label, advance] of [
  ['claimed into in-progress', (rootDir) => claimNextArgusJob({ rootDir }).jobPath],
  ['completed', (rootDir) => completeArgusJob({ rootDir, jobPath: claimNextArgusJob({ rootDir }).jobPath }).jobPath],
  ['failed', (rootDir) => failArgusJob({ rootDir, jobPath: claimNextArgusJob({ rootDir }).jobPath, error: 'boom' }).jobPath],
]) {
  test(`re-enqueue at the same head is a no-op once the job is ${label}`, () => {
    const rootDir = makeRoot();
    enqueue(rootDir);
    const advancedPath = advance(rootDir);

    const again = enqueue(rootDir);
    assert.equal(again.enqueued, false);
    assert.equal(again.outcome, 'duplicate');
    assert.equal(again.jobPath, advancedPath);
    assert.equal(bucketNames(rootDir, 'pending').length, 0);
    assert.equal(allJsonFileCount(rootDir), 1);
  });
}

test('a new head enqueues again — a review is bound to the tree it read', () => {
  const rootDir = makeRoot();
  const first = enqueue(rootDir, { headSha: HEAD_A });
  const second = enqueue(rootDir, { headSha: HEAD_B });

  assert.equal(second.enqueued, true);
  assert.equal(second.outcome, 'created');
  assert.notEqual(second.jobPath, first.jobPath);
  assert.equal(bucketNames(rootDir, 'pending').length, 2);

  const heads = listArgusJobs(rootDir, { bucket: 'pending' }).map((entry) => entry.job.headSha).sort();
  assert.deepEqual(heads, [HEAD_A, HEAD_B].sort());
});

test('a new head enqueues again even after the old head was already reviewed', () => {
  const rootDir = makeRoot();
  enqueue(rootDir, { headSha: HEAD_A });
  completeArgusJob({ rootDir, jobPath: claimNextArgusJob({ rootDir }).jobPath });

  const afterNewCommit = enqueue(rootDir, { headSha: HEAD_B });
  assert.equal(afterNewCommit.enqueued, true);
  assert.equal(afterNewCommit.bucket, 'pending');
  assert.equal(readArgusJob(afterNewCommit.jobPath).headSha, HEAD_B);

  // The completed review of the old tree stays completed; it simply carries no
  // authority over the new one.
  assert.equal(bucketNames(rootDir, 'completed').length, 1);
});

test('identity is per (repo, prNumber, headSha) — a different repo or PR is a different job', () => {
  const rootDir = makeRoot();
  enqueue(rootDir);
  assert.equal(enqueue(rootDir, { repo: 'laceyenterprises/agent-os' }).enqueued, true);
  assert.equal(enqueue(rootDir, { prNumber: 910 }).enqueued, true);
  assert.equal(bucketNames(rootDir, 'pending').length, 3);

  // Same triple, upper-cased repo and SHA: GitHub treats these as one subject,
  // so the queue must too.
  const sameSubject = enqueue(rootDir, {
    repo: 'LaceyEnterprises/Adversarial-Review',
    headSha: HEAD_A.toUpperCase(),
  });
  assert.equal(sameSubject.enqueued, false);
  assert.equal(bucketNames(rootDir, 'pending').length, 3);
});

test('an unreadable record still holds its identity — no duplicate beside it', () => {
  const rootDir = makeRoot();
  const created = enqueue(rootDir);
  writeFileSync(created.jobPath, '{ not json', 'utf8');

  const again = enqueue(rootDir);
  assert.equal(again.enqueued, false);
  assert.equal(again.outcome, 'duplicate');
  assert.equal(bucketNames(rootDir, 'pending').length, 1);
});

test('a job claimed mid-enqueue rolls the racing create back instead of duplicating', () => {
  // The interleaving this defends: the pre-check finds nothing anywhere, then a
  // concurrent consumer claims the same job into `in-progress`, then the create
  // lands in `pending`. Two copies of one job means two reviews of one tree.
  // The steps cannot be interleaved from a single-threaded test, so the
  // post-create reconciliation is driven directly against the state the race
  // produces.
  const rootDir = makeRoot();
  const created = enqueue(rootDir);
  const inProgressPath = path.join(
    getArgusJobDir(rootDir, 'inProgress'),
    path.basename(created.jobPath)
  );
  mkdirSync(getArgusJobDir(rootDir, 'inProgress'), { recursive: true });
  writeFileSync(inProgressPath, JSON.stringify({ ...created.job, status: 'in_progress' }), 'utf8');

  const resolved = resolveEnqueueRace({
    rootDir,
    jobId: created.job.jobId,
    jobPath: created.jobPath,
  });
  assert.equal(resolved.enqueued, false);
  assert.equal(resolved.outcome, 'duplicate');
  assert.equal(resolved.bucket, 'inProgress');
  assert.equal(resolved.jobPath, inProgressPath);
  assert.equal(resolved.job.status, 'in_progress');

  // The racing pending copy is gone; the claimed job is the only one left.
  assert.equal(existsSync(created.jobPath), false);
  assert.equal(allJsonFileCount(rootDir), 1);
});

test('a create that wins the race stands', () => {
  const rootDir = makeRoot();
  const created = enqueue(rootDir);
  assert.equal(
    resolveEnqueueRace({ rootDir, jobId: created.job.jobId, jobPath: created.jobPath }),
    null
  );
  assert.equal(existsSync(created.jobPath), true);
});

test('a filename collision carrying a different subject fails loud instead of deduping', () => {
  const rootDir = makeRoot();
  ensureArgusJobDirs(rootDir);
  const jobId = buildArgusJobId({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 909,
    headSha: HEAD_A,
  });
  writeFileSync(
    path.join(getArgusJobDir(rootDir, 'pending'), `${jobId}.json`),
    JSON.stringify({ jobId, repo: 'someone/else', prNumber: 1, headSha: HEAD_C }),
    'utf8'
  );

  assert.throws(() => enqueue(rootDir), /job id collision/u);
});

test('enqueue refuses input that cannot identify a tree', () => {
  const rootDir = makeRoot();

  // An abbreviated SHA is a different identity, not a weaker one: it would
  // both double-enqueue against its own expansion and collapse two distinct
  // heads that share a prefix into one skipped review.
  assert.throws(() => enqueue(rootDir, { headSha: 'a1b2c3d' }), /full 40- or 64-character hex/u);
  assert.throws(() => enqueue(rootDir, { headSha: '' }), /full 40- or 64-character hex/u);
  assert.throws(() => enqueue(rootDir, { headSha: `${'z'.repeat(40)}` }), /full 40- or 64-character hex/u);
  assert.throws(() => enqueue(rootDir, { repo: '  ' }), /repo is required/u);
  assert.throws(() => enqueue(rootDir, { prNumber: 0 }), /positive integer/u);
  assert.throws(() => enqueue(rootDir, { prNumber: 12.5 }), /positive integer/u);

  // A security job with no reason has lost what the reviewer specialises on.
  assert.throws(() => enqueue(rootDir, { reasons: [] }), /non-empty array/u);
  assert.throws(() => enqueue(rootDir, { reasons: [{}] }), /trigger must be a non-empty string/u);
  assert.throws(() => enqueue(rootDir, { reasons: ['bot-author'] }), /must be an object/u);
  assert.throws(() => enqueue(rootDir, { enqueuedAt: 'not-a-date' }), /invalid ISO timestamp/u);

  assert.equal(allJsonFileCount(rootDir), 0);
});

test('a 64-character SHA-256 object name is accepted', () => {
  const rootDir = makeRoot();
  assert.equal(enqueue(rootDir, { headSha: 'd'.repeat(64) }).enqueued, true);
});

test('the persisted reasons are a copy the caller cannot mutate afterwards', () => {
  const rootDir = makeRoot();
  const reasons = reasonsFixture();
  const created = enqueue(rootDir, { reasons });

  reasons[0].trigger = 'tampered';
  reasons.push({ trigger: 'appended' });

  const persisted = readArgusJob(created.jobPath).reasons;
  assert.equal(persisted.length, 2);
  assert.equal(persisted[0].trigger, 'bot-author');
  assert.equal(created.job.reasons[0].trigger, 'bot-author');
});

test('queue depth reports accurately across buckets as jobs move', () => {
  const rootDir = makeRoot();
  assert.deepEqual(readArgusQueueDepth(rootDir).depth, {
    pending: 0, inProgress: 0, completed: 0, failed: 0,
  });
  assert.equal(readArgusQueueDepth(rootDir).total, 0);
  assert.equal(readArgusQueueDepth(rootDir).oldestPending, null);

  enqueue(rootDir, { headSha: HEAD_A });
  enqueue(rootDir, { headSha: HEAD_B });
  enqueue(rootDir, { headSha: HEAD_C });
  assert.deepEqual(readArgusQueueDepth(rootDir).depth, {
    pending: 3, inProgress: 0, completed: 0, failed: 0,
  });

  const claimed = claimNextArgusJob({ rootDir });
  assert.deepEqual(readArgusQueueDepth(rootDir).depth, {
    pending: 2, inProgress: 1, completed: 0, failed: 0,
  });

  completeArgusJob({ rootDir, jobPath: claimed.jobPath });
  failArgusJob({ rootDir, jobPath: claimNextArgusJob({ rootDir }).jobPath, error: 'reviewer crashed' });

  const depth = readArgusQueueDepth(rootDir);
  assert.deepEqual(depth.depth, { pending: 1, inProgress: 0, completed: 1, failed: 1 });
  assert.equal(depth.total, 3);
  // `active` is the backlog signal: queued plus in flight, terminal excluded.
  assert.equal(depth.active, 1);
});

test('queue depth counts unreadable records and ignores non-record files', () => {
  const rootDir = makeRoot();
  const created = enqueue(rootDir);
  const pendingDir = getArgusJobDir(rootDir, 'pending');
  writeFileSync(path.join(pendingDir, 'README.txt'), 'not a job', 'utf8');
  writeFileSync(path.join(pendingDir, '.job.json.1234.tmp'), '{}', 'utf8');
  writeFileSync(path.join(pendingDir, 'corrupt.json'), '{ truncated', 'utf8');

  // A corrupt record is still work sitting in the queue, so it counts; a
  // half-written temp file and a stray note are not records, so they do not.
  assert.equal(readArgusQueueDepth(rootDir).depth.pending, 2);
  assert.equal(existsSync(created.jobPath), true);
});

test('queue depth is not truncated by the newest-N record read cap', () => {
  const rootDir = makeRoot();
  const pendingDir = getArgusJobDir(rootDir, 'pending');
  mkdirSync(pendingDir, { recursive: true });

  const total = 205;
  for (let i = 0; i < total; i += 1) {
    const headSha = String(i).padStart(40, '0');
    const jobId = buildArgusJobId({ repo: 'laceyenterprises/agent-os', prNumber: 1, headSha });
    writeFileSync(
      path.join(pendingDir, `${jobId}.json`),
      JSON.stringify({ jobId, repo: 'laceyenterprises/agent-os', prNumber: 1, headSha }),
      'utf8'
    );
  }

  // A capped depth read would report a badly stuck queue as a merely busy one.
  assert.equal(readArgusQueueDepth(rootDir).depth.pending, total);
  // Record READS stay capped — a debugging list must not parse the whole bucket.
  assert.equal(listArgusJobs(rootDir, { bucket: 'pending' }).length, 200);
  assert.equal(listArgusJobs(rootDir, { bucket: 'pending', limit: 5 }).length, 5);
});

test('queue depth counts non-pending buckets without statting each record', () => {
  const rootDir = makeRoot();
  const completedDir = getArgusJobDir(rootDir, 'completed');
  const failedDir = getArgusJobDir(rootDir, 'failed');
  mkdirSync(completedDir, { recursive: true });
  mkdirSync(failedDir, { recursive: true });

  symlinkSync(path.join(rootDir, 'missing-completed-job.json'), path.join(completedDir, 'completed.json'));
  writeFileSync(path.join(failedDir, 'failed.json'), '{}', 'utf8');

  const depth = readArgusQueueDepth(rootDir);
  assert.equal(depth.depth.completed, 1);
  assert.equal(depth.depth.failed, 1);
  assert.equal(depth.total, 2);
  assert.equal(listArgusJobs(rootDir, { bucket: 'completed' }).length, 0);
});

test('pending list surfaces non-race stat failures instead of silently hiding jobs', () => {
  const rootDir = makeRoot();
  const pendingDir = getArgusJobDir(rootDir, 'pending');
  mkdirSync(pendingDir, { recursive: true });
  symlinkSync('loop.json', path.join(pendingDir, 'loop.json'));

  assert.throws(() => listArgusJobs(rootDir, { bucket: 'pending' }), /ELOOP/u);
  assert.throws(() => readArgusQueueDepth(rootDir), /ELOOP/u);
});

test('queue depth surfaces the oldest pending job as the stuck-queue signal', () => {
  const rootDir = makeRoot();
  const old = enqueue(rootDir, { headSha: HEAD_A, enqueuedAt: '2026-08-25T00:00:00.000Z' });
  enqueue(rootDir, { headSha: HEAD_B, enqueuedAt: '2026-08-25T05:00:00.000Z' });
  const oldSeconds = Date.parse('2026-08-25T00:00:00.000Z') / 1000;
  utimesSync(old.jobPath, oldSeconds, oldSeconds);

  const depth = readArgusQueueDepth(rootDir, { nowMs: Date.parse('2026-08-25T06:00:00.000Z') });
  assert.equal(depth.oldestPending.headSha, HEAD_A);
  assert.equal(depth.oldestPending.repo, 'laceyenterprises/adversarial-review');
  assert.equal(depth.oldestPending.prNumber, 909);
  assert.equal(depth.oldestPending.enqueuedAt, '2026-08-25T00:00:00.000Z');
  assert.equal(depth.oldestPendingAgeMs, 6 * 60 * 60 * 1000);
});

test('claim drains oldest-first and is a one-winner CAS', () => {
  const rootDir = makeRoot();
  const first = enqueue(rootDir, { headSha: HEAD_A });
  const second = enqueue(rootDir, { headSha: HEAD_B });
  const firstSeconds = Date.parse('2026-08-25T00:00:00.000Z') / 1000;
  const secondSeconds = Date.parse('2026-08-25T01:00:00.000Z') / 1000;
  utimesSync(first.jobPath, firstSeconds, firstSeconds);
  utimesSync(second.jobPath, secondSeconds, secondSeconds);

  const claimed = claimNextArgusJob({ rootDir, claimedAt: '2026-08-25T02:00:00.000Z' });
  assert.equal(claimed.job.headSha, HEAD_A);
  assert.equal(claimed.job.status, 'in_progress');
  assert.equal(claimed.job.claimedAt, '2026-08-25T02:00:00.000Z');
  assert.equal(existsSync(first.jobPath), false);
  assert.equal(readArgusJob(claimed.jobPath).status, 'in_progress');

  assert.equal(claimNextArgusJob({ rootDir }).job.headSha, HEAD_B);
  assert.equal(claimNextArgusJob({ rootDir }), null);
});

test('claim rolls back to pending when persisting the claimed record fails', () => {
  const rootDir = makeRoot();
  const created = enqueue(rootDir);

  assert.throws(
    () => claimNextArgusJob({
      rootDir,
      claimedAt: '2026-08-25T02:00:00.000Z',
      writeJob: () => {
        throw new Error('disk full');
      },
    }),
    /disk full/u
  );

  assert.equal(existsSync(created.jobPath), true);
  assert.equal(bucketNames(rootDir, 'inProgress').length, 0);
  assert.equal(readArgusJob(created.jobPath).status, 'pending');

  const claimed = claimNextArgusJob({ rootDir, claimedAt: '2026-08-25T02:05:00.000Z' });
  assert.equal(claimed.job.headSha, HEAD_A);
  assert.equal(claimed.job.status, 'in_progress');
  assert.equal(claimed.job.claimedAt, '2026-08-25T02:05:00.000Z');
});

test('claim does not overwrite an existing in-progress record with the same job name', () => {
  const rootDir = makeRoot();
  const created = enqueue(rootDir);
  const inProgressPath = path.join(
    getArgusJobDir(rootDir, 'inProgress'),
    path.basename(created.jobPath)
  );
  mkdirSync(getArgusJobDir(rootDir, 'inProgress'), { recursive: true });
  writeFileSync(inProgressPath, `${JSON.stringify({ ...created.job, status: 'in_progress', claimedAt: 'first' })}\n`);

  assert.equal(claimNextArgusJob({ rootDir }), null);
  assert.equal(existsSync(created.jobPath), true);
  assert.equal(readArgusJob(inProgressPath).claimedAt, 'first');
  assert.equal(readArgusJob(inProgressPath).status, 'in_progress');
});

test('terminal transitions move the record and stamp the outcome', () => {
  const rootDir = makeRoot();
  enqueue(rootDir, { headSha: HEAD_A });
  enqueue(rootDir, { headSha: HEAD_B });

  const completed = completeArgusJob({
    rootDir,
    jobPath: claimNextArgusJob({ rootDir }).jobPath,
    completedAt: '2026-08-25T03:00:00.000Z',
    result: { verdict: 'pass' },
  });
  assert.equal(completed.job.status, 'completed');
  assert.equal(completed.job.completedAt, '2026-08-25T03:00:00.000Z');
  assert.deepEqual(completed.job.result, { verdict: 'pass' });
  assert.equal(path.dirname(completed.jobPath), getArgusJobDir(rootDir, 'completed'));

  const failed = failArgusJob({
    rootDir,
    jobPath: claimNextArgusJob({ rootDir }).jobPath,
    failedAt: '2026-08-25T04:00:00.000Z',
    error: new Error('reviewer timed out'),
  });
  assert.equal(failed.job.status, 'failed');
  assert.equal(failed.job.failedAt, '2026-08-25T04:00:00.000Z');
  assert.match(failed.job.error, /reviewer timed out/u);
  assert.equal(path.dirname(failed.jobPath), getArgusJobDir(rootDir, 'failed'));

  // The head each verdict is bound to survives the move.
  assert.equal(completed.job.headSha, HEAD_A);
  assert.equal(failed.job.headSha, HEAD_B);
});

test('findArgusJob reports which bucket an existing job sits in', () => {
  const rootDir = makeRoot();
  const identity = { repo: 'laceyenterprises/adversarial-review', prNumber: 909, headSha: HEAD_A };
  assert.equal(findArgusJob(rootDir, identity), null);

  enqueue(rootDir);
  assert.equal(findArgusJob(rootDir, identity).bucket, 'pending');

  claimNextArgusJob({ rootDir });
  assert.equal(findArgusJob(rootDir, identity).bucket, 'inProgress');
});

test('ensureArgusJobDirs creates every bucket and getArgusJobDir rejects unknown ones', () => {
  const rootDir = makeRoot();
  ensureArgusJobDirs(rootDir);
  for (const bucket of ARGUS_JOB_BUCKETS) {
    assert.equal(existsSync(getArgusJobDir(rootDir, bucket)), true);
  }
  assert.deepEqual(ARGUS_JOB_BUCKETS, ['pending', 'inProgress', 'completed', 'failed']);
  assert.throws(() => getArgusJobDir(rootDir, 'stopped'), /Unknown argus job directory key/u);
});
