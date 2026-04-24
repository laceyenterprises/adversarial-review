import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FOLLOW_UP_JOB_SCHEMA_VERSION,
  REMEDIATION_REPLY_KIND,
  REMEDIATION_REPLY_SCHEMA_VERSION,
  buildFollowUpJob,
  buildRemediationReply,
  claimNextFollowUpJob,
  createFollowUpJob,
  extractReviewSummary,
  getFollowUpJobDir,
  markFollowUpJobFailed,
  markFollowUpJobSpawned,
  readRemediationReplyArtifact,
  validateRemediationReply,
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
  assert.equal(job.remediationReply.kind, REMEDIATION_REPLY_KIND);
  assert.equal(job.remediationReply.schemaVersion, REMEDIATION_REPLY_SCHEMA_VERSION);
  assert.equal(job.remediationReply.state, 'awaiting-worker-write');
  assert.equal(job.remediationReply.path, null);
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

test('markFollowUpJobSpawned records the expected remediation reply artifact path', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });

  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-04-21T10:01:00.000Z',
    worker: {
      processId: 8123,
      workspaceDir: 'data/follow-up-jobs/workspaces/example',
      replyPath: 'data/follow-up-jobs/workspaces/example/.adversarial-follow-up/remediation-reply.json',
    },
  });

  assert.equal(spawned.job.remediationReply.kind, REMEDIATION_REPLY_KIND);
  assert.equal(spawned.job.remediationReply.state, 'awaiting-worker-write');
  assert.equal(
    spawned.job.remediationReply.path,
    'data/follow-up-jobs/workspaces/example/.adversarial-follow-up/remediation-reply.json'
  );
});

test('buildRemediationReply and validateRemediationReply accept a re-review request contract', () => {
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 42,
    reviewerModel: 'codex',
    linearTicketId: 'LAC-42',
    reviewBody: '## Summary\nTighten null handling.',
    reviewPostedAt: '2026-04-21T07:46:00.000Z',
    critical: false,
  });

  const reply = buildRemediationReply({
    job,
    outcome: 'completed',
    summary: 'Patched null handling and added a regression test.',
    validation: ['npm test'],
    blockers: [],
    reReviewRequested: true,
    reReviewReason: 'The remediation is landed and ready for another adversarial pass.',
  });

  assert.equal(reply.kind, REMEDIATION_REPLY_KIND);
  assert.equal(reply.schemaVersion, REMEDIATION_REPLY_SCHEMA_VERSION);
  assert.equal(reply.reReview.requested, true);
  assert.equal(reply.reReview.reason, 'The remediation is landed and ready for another adversarial pass.');
  assert.deepEqual(validateRemediationReply(reply, { expectedJob: job }), reply);
});

test('validateRemediationReply rejects a re-review request without a durable reason', () => {
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 42,
    reviewerModel: 'codex',
    linearTicketId: 'LAC-42',
    reviewBody: '## Summary\nTighten null handling.',
    reviewPostedAt: '2026-04-21T07:46:00.000Z',
    critical: false,
  });

  assert.throws(
    () => validateRemediationReply({
      kind: REMEDIATION_REPLY_KIND,
      schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
      jobId: job.jobId,
      repo: job.repo,
      prNumber: job.prNumber,
      outcome: 'completed',
      summary: 'Patched null handling.',
      validation: [],
      blockers: [],
      reReview: {
        requested: true,
        reason: '',
      },
    }, { expectedJob: job }),
    /reReview\.reason is required/
  );
});

test('readRemediationReplyArtifact parses and validates the durable remediation reply file', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 42,
    reviewerModel: 'codex',
    linearTicketId: 'LAC-42',
    reviewBody: '## Summary\nTighten null handling.',
    reviewPostedAt: '2026-04-21T07:46:00.000Z',
    critical: false,
  });
  const replyPath = path.join(rootDir, 'reply.json');
  const reply = buildRemediationReply({
    job,
    outcome: 'completed',
    summary: 'Patched null handling and added a regression test.',
    validation: ['npm test'],
    blockers: [],
    reReviewRequested: false,
  });

  writeFileSync(replyPath, `${JSON.stringify(reply, null, 2)}\n`, 'utf8');

  assert.deepEqual(readRemediationReplyArtifact(replyPath, { expectedJob: job }), reply);
});
