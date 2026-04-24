import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAX_REMEDIATION_ROUNDS,
  FOLLOW_UP_JOB_SCHEMA_VERSION,
  buildFollowUpJob,
  claimNextFollowUpJob,
  createFollowUpJob,
  extractReviewSummary,
  getFollowUpJobDir,
  markFollowUpJobCompleted,
  markFollowUpJobFailed,
  requeueFollowUpJobForNextRound,
  writeFollowUpJob,
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
  assert.equal(job.remediationPlan.mode, 'bounded-manual-rounds');
  assert.equal(job.remediationPlan.maxRounds, DEFAULT_MAX_REMEDIATION_ROUNDS);
  assert.deepEqual(job.remediationPlan.rounds, []);
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
  assert.equal(claimed.job.remediationPlan.currentRound, 1);
  assert.equal(claimed.job.remediationPlan.rounds[0].state, 'claimed');
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
  assert.equal(failed.job.failure.code, 'worker-failure');
  assert.equal(failed.job.failure.message, 'gh repo clone failed');
  assert.equal(failed.job.remediationPlan.rounds[0].state, 'failed');
  assert.equal(existsSync(claimed.jobPath), false);
});

test('requeueFollowUpJobForNextRound moves a completed job back to pending for the next bounded round', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });
  const completed = markFollowUpJobCompleted({
    rootDir,
    jobPath: claimed.jobPath,
    finishedAt: '2026-04-21T10:05:00.000Z',
    completionPreview: 'Patched auth refresh path.',
  });

  const requeued = requeueFollowUpJobForNextRound({
    rootDir,
    jobPath: completed.jobPath,
    requestedAt: '2026-04-21T10:06:00.000Z',
    requestedBy: 'operator',
    reason: 'Reviewer requested another bounded pass.',
  });

  assert.match(requeued.jobPath, /data\/follow-up-jobs\/pending\/.+\.json$/);
  assert.equal(requeued.job.status, 'pending');
  assert.equal(requeued.job.remediationPlan.currentRound, 1);
  assert.equal(requeued.job.remediationPlan.nextAction.round, 2);
  assert.equal(requeued.job.remediationPlan.nextAction.requestedBy, 'operator');
});

test('requeueFollowUpJobForNextRound stops the job once the round cap is reached', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob({
    ...makeJobInput(rootDir),
    maxRemediationRounds: 1,
  });
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });
  const completed = markFollowUpJobCompleted({
    rootDir,
    jobPath: claimed.jobPath,
    finishedAt: '2026-04-21T10:05:00.000Z',
    completionPreview: 'Patched auth refresh path.',
  });

  const stopped = requeueFollowUpJobForNextRound({
    rootDir,
    jobPath: completed.jobPath,
    requestedAt: '2026-04-21T10:06:00.000Z',
    reason: 'Operator requested another round even though the cap was reached.',
  });

  assert.match(stopped.jobPath, /data\/follow-up-jobs\/stopped\/.+\.json$/);
  assert.equal(stopped.job.status, 'stopped');
  assert.match(stopped.job.remediationPlan.stopReason, /Reached max remediation rounds \(1\/1\)/);
});

test('claimNextFollowUpJob skips exhausted pending jobs after moving them to stopped', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const exhausted = createFollowUpJob({
    ...makeJobInput(rootDir),
    prNumber: 7,
    reviewPostedAt: '2026-04-21T08:00:00.000Z',
    maxRemediationRounds: 1,
  });
  createFollowUpJob({
    ...makeJobInput(rootDir),
    prNumber: 8,
    reviewPostedAt: '2026-04-21T09:00:00.000Z',
  });

  writeFollowUpJob(exhausted.jobPath, {
    ...exhausted.job,
    remediationPlan: {
      ...exhausted.job.remediationPlan,
      currentRound: 1,
      rounds: [{ round: 1, state: 'completed' }],
      nextAction: {
        type: 'consume-pending-round',
        round: 2,
        operatorVisibility: 'explicit',
      },
    },
  });

  const claimed = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-04-21T10:00:00.000Z',
    launcherPid: 4242,
  });

  assert.ok(claimed);
  assert.equal(claimed.job.prNumber, 8);
  assert.equal(
    existsSync(path.join(getFollowUpJobDir(rootDir, 'stopped'), `${exhausted.job.jobId}.json`)),
    true
  );
});
