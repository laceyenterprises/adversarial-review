import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FOLLOW_UP_JOB_SCHEMA_VERSION,
  buildFollowUpJob,
  claimNextFollowUpJob,
  createFollowUpJob,
  extractReviewSummary,
  getFollowUpJobDir,
  markFollowUpJobCompleted,
  markFollowUpJobFailed,
  readFollowUpJob,
} from '../src/follow-up-jobs.mjs';

function makeJobInput(rootDir) {
  return {
    rootDir,
    repo: 'laceyenterprises/clio',
    prNumber: 7,
    reviewerModel: 'claude',
    linearTicketId: null,
    reviewBody: '## Summary\nCheck auth expiry handling.',
    reviewPostedAt: '2026-04-21T08:00:00.000Z',
    critical: true,
  };
}

test('extractReviewSummary prefers the Summary section when present', () => {
  const reviewBody = [
    '## Summary',
    'Race condition in retry path can double-submit the webhook.',
    '',
    '## Blocking issues',
    '- file: src/worker.mjs',
  ].join('\n');

  assert.equal(
    extractReviewSummary(reviewBody),
    'Race condition in retry path can double-submit the webhook.'
  );
});

test('buildFollowUpJob creates a pending durable handoff record', () => {
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 42,
    reviewerModel: 'codex',
    linearTicketId: 'LAC-42',
    reviewBody: '## Summary\nTighten null handling.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-04-21T07:46:00.000Z',
    critical: false,
  });

  assert.equal(job.schemaVersion, FOLLOW_UP_JOB_SCHEMA_VERSION);
  assert.equal(job.status, 'pending');
  assert.equal(job.trigger.type, 'github-review-posted');
  assert.equal(job.repo, 'laceyenterprises/clio');
  assert.equal(job.prNumber, 42);
  assert.equal(job.reviewSummary, 'Tighten null handling.');
  assert.equal(job.sessionHandoff.resumePreferred, true);
  assert.equal(job.sessionHandoff.resumeAvailable, false);
  assert.match(job.jobId, /^laceyenterprises__clio-pr-42-/);
});

test('createFollowUpJob writes the pending job JSON under data/follow-up-jobs/pending', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const { job, jobPath } = createFollowUpJob(makeJobInput(rootDir));

  assert.match(jobPath, /data\/follow-up-jobs\/pending\/.+\.json$/);

  const persisted = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.deepEqual(persisted, job);
  assert.equal(persisted.recommendedFollowUpAction.priority, 'high');
});

test('createFollowUpJob does not overwrite an existing job file when ids collide', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const input = makeJobInput(rootDir);

  const first = createFollowUpJob(input);
  const second = createFollowUpJob(input);

  assert.notEqual(first.jobPath, second.jobPath);
  assert.notEqual(first.job.jobId, second.job.jobId);

  const firstPersisted = JSON.parse(readFileSync(first.jobPath, 'utf8'));
  const secondPersisted = JSON.parse(readFileSync(second.jobPath, 'utf8'));
  assert.equal(firstPersisted.jobId, first.job.jobId);
  assert.equal(secondPersisted.jobId, second.job.jobId);
});

test('claimNextFollowUpJob moves the oldest pending file into in-progress metadata', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  createFollowUpJob({
    ...makeJobInput(rootDir),
    prNumber: 8,
    reviewPostedAt: '2026-04-21T09:00:00.000Z',
  });

  const claimed = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-04-21T10:00:00.000Z',
    launcherPid: 4242,
  });

  assert.ok(claimed);
  assert.match(claimed.jobPath, /data\/follow-up-jobs\/in-progress\/.+\.json$/);
  assert.equal(claimed.job.status, 'in_progress');
  assert.equal(claimed.job.claimedAt, '2026-04-21T10:00:00.000Z');
  assert.equal(claimed.job.claimedBy.workerType, 'codex-remediation');
  assert.equal(claimed.job.claimedBy.launcherPid, 4242);
  assert.equal(existsSync(path.join(getFollowUpJobDir(rootDir, 'pending'), `${claimed.job.jobId}.json`)), false);
});

test('markFollowUpJobFailed moves an in-progress job into failed with error context', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });

  const failed = markFollowUpJobFailed({
    rootDir,
    jobPath: claimed.jobPath,
    error: new Error('gh repo clone failed'),
    failedAt: '2026-04-21T10:05:00.000Z',
  });

  assert.match(failed.jobPath, /data\/follow-up-jobs\/failed\/.+\.json$/);
  assert.equal(failed.job.status, 'failed');
  assert.equal(failed.job.failedAt, '2026-04-21T10:05:00.000Z');
  assert.equal(failed.job.failure.message, 'gh repo clone failed');
  assert.equal(existsSync(claimed.jobPath), false);
});

test('markFollowUpJobFailed is idempotent when the failed record already exists', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });

  const failed = markFollowUpJobFailed({
    rootDir,
    jobPath: claimed.jobPath,
    error: new Error('first failure'),
    failedAt: '2026-04-21T10:05:00.000Z',
  });

  const repeated = markFollowUpJobFailed({
    rootDir,
    jobPath: claimed.jobPath,
    error: new Error('second failure'),
    failedAt: '2026-04-21T10:06:00.000Z',
  });

  assert.equal(repeated.jobPath, failed.jobPath);
  assert.deepEqual(repeated.job, readFollowUpJob(failed.jobPath));
  assert.equal(repeated.job.failedAt, '2026-04-21T10:05:00.000Z');
  assert.equal(repeated.job.failure.message, 'first failure');
});

test('markFollowUpJobCompleted moves an in-progress job into completed with reconciliation context', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });

  const completed = markFollowUpJobCompleted({
    rootDir,
    jobPath: claimed.jobPath,
    completedAt: '2026-04-21T10:07:00.000Z',
    completion: {
      source: 'codex-output-last-message',
      finalMessagePath: 'data/follow-up-jobs/workspaces/job/.adversarial-follow-up/codex-last-message.md',
    },
  });

  assert.match(completed.jobPath, /data\/follow-up-jobs\/completed\/.+\.json$/);
  assert.equal(completed.job.status, 'completed');
  assert.equal(completed.job.completedAt, '2026-04-21T10:07:00.000Z');
  assert.equal(completed.job.completion.source, 'codex-output-last-message');
  assert.equal(existsSync(claimed.jobPath), false);
});

test('markFollowUpJobCompleted is idempotent when the completed record already exists', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });

  const completed = markFollowUpJobCompleted({
    rootDir,
    jobPath: claimed.jobPath,
    completedAt: '2026-04-21T10:07:00.000Z',
    completion: { source: 'codex-output-last-message' },
  });

  const repeated = markFollowUpJobCompleted({
    rootDir,
    jobPath: claimed.jobPath,
    completedAt: '2026-04-21T10:08:00.000Z',
    completion: { source: 'ignored-second-pass' },
  });

  assert.equal(repeated.jobPath, completed.jobPath);
  assert.deepEqual(repeated.job, readFollowUpJob(completed.jobPath));
  assert.equal(repeated.job.completedAt, '2026-04-21T10:07:00.000Z');
  assert.equal(repeated.job.completion.source, 'codex-output-last-message');
});

test('markFollowUpJobCompleted preserves an existing terminal record even if a stale in-progress source still exists', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });

  const completed = markFollowUpJobCompleted({
    rootDir,
    jobPath: claimed.jobPath,
    completedAt: '2026-04-21T10:07:00.000Z',
    completion: { source: 'codex-output-last-message', winner: 'first-writer' },
  });

  const staleCopy = {
    ...completed.job,
    status: 'in_progress',
    completedAt: undefined,
    completion: undefined,
  };
  writeFileSync(claimed.jobPath, `${JSON.stringify(staleCopy, null, 2)}\n`, 'utf8');

  const repeated = markFollowUpJobCompleted({
    rootDir,
    jobPath: claimed.jobPath,
    completedAt: '2026-04-21T10:08:00.000Z',
    completion: { source: 'ignored-second-pass', winner: 'second-writer' },
  });

  const persisted = readFollowUpJob(completed.jobPath);
  assert.equal(repeated.jobPath, completed.jobPath);
  assert.deepEqual(repeated.job, persisted);
  assert.equal(persisted.completedAt, '2026-04-21T10:07:00.000Z');
  assert.equal(persisted.completion.winner, 'first-writer');
  assert.equal(existsSync(claimed.jobPath), false);
});

test('markFollowUpJobFailed preserves an existing terminal record even if a stale in-progress source still exists', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });

  const failed = markFollowUpJobFailed({
    rootDir,
    jobPath: claimed.jobPath,
    error: new Error('first failure'),
    failedAt: '2026-04-21T10:05:00.000Z',
  });

  const staleCopy = {
    ...failed.job,
    status: 'in_progress',
    failedAt: undefined,
    failure: undefined,
  };
  writeFileSync(claimed.jobPath, `${JSON.stringify(staleCopy, null, 2)}\n`, 'utf8');

  const repeated = markFollowUpJobFailed({
    rootDir,
    jobPath: claimed.jobPath,
    error: new Error('second failure'),
    failedAt: '2026-04-21T10:06:00.000Z',
  });

  const persisted = readFollowUpJob(failed.jobPath);
  assert.equal(repeated.jobPath, failed.jobPath);
  assert.deepEqual(repeated.job, persisted);
  assert.equal(persisted.failedAt, '2026-04-21T10:05:00.000Z');
  assert.equal(persisted.failure.message, 'first failure');
  assert.equal(existsSync(claimed.jobPath), false);
});
