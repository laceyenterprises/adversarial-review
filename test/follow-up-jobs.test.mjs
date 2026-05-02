import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAX_REMEDIATION_ROUNDS,
  FOLLOW_UP_JOB_SCHEMA_VERSION,
  REMEDIATION_REPLY_KIND,
  REMEDIATION_REPLY_SCHEMA_VERSION,
  buildFollowUpJob,
  buildRemediationReply,
  buildStopMetadata,
  claimNextFollowUpJob,
  createFollowUpJob,
  extractReviewSummary,
  getFollowUpJobDir,
  markFollowUpJobCompleted,
  markFollowUpJobFailed,
  markFollowUpJobSpawned,
  readRemediationReplyArtifact,
  readFollowUpJob,
  requeueFollowUpJobForNextRound,
  stopFollowUpJob,
  validateRemediationReply,
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

test('readFollowUpJob normalizes legacy v1 jobs into bounded remediation shape', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const jobPath = path.join(rootDir, 'legacy.json');
  writeFileSync(jobPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'adversarial-review-follow-up',
    status: 'completed',
    jobId: 'legacy-job',
    createdAt: '2026-04-21T08:00:00.000Z',
    repo: 'laceyenterprises/clio',
    prNumber: 7,
    reviewerModel: 'claude',
    critical: true,
    reviewSummary: 'Legacy job',
    reviewBody: 'Legacy body',
    recommendedFollowUpAction: {
      type: 'address-adversarial-review',
      priority: 'high',
      summary: 'Legacy',
    },
    claimedAt: '2026-04-21T10:00:00.000Z',
    claimedBy: {
      workerType: 'codex-remediation',
      launcherPid: 7,
    },
    remediationWorker: {
      model: 'codex',
      state: 'spawned',
      processId: 8123,
    },
    completedAt: '2026-04-21T10:05:00.000Z',
    completion: {
      preview: 'Legacy completion',
    },
  }, null, 2)}\n`, 'utf8');

  const normalized = readFollowUpJob(jobPath);
  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.remediationPlan.mode, 'bounded-manual-rounds');
  assert.equal(normalized.remediationPlan.maxRounds, DEFAULT_MAX_REMEDIATION_ROUNDS);
  assert.equal(normalized.remediationPlan.currentRound, 1);
  assert.equal(normalized.remediationPlan.rounds[0].state, 'completed');
  assert.equal(normalized.remediationPlan.rounds[0].worker.processId, 8123);
  assert.equal(normalized.remediationPlan.rounds[0].completion.preview, 'Legacy completion');
  assert.equal(normalized.recommendedFollowUpAction.executionModel, 'bounded-manual-rounds');
  assert.equal(normalized.remediationReply.kind, REMEDIATION_REPLY_KIND);
  assert.equal(normalized.remediationReply.state, 'awaiting-worker-write');
  assert.equal(normalized.remediationReply.path, null);
});

test('readFollowUpJob whitelists persisted remediationReply fields during normalization', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const jobPath = path.join(rootDir, 'job.json');
  writeFileSync(jobPath, `${JSON.stringify({
    schemaVersion: 2,
    kind: 'adversarial-review-follow-up',
    status: 'pending',
    jobId: 'job-1',
    createdAt: '2026-04-21T08:00:00.000Z',
    repo: 'laceyenterprises/clio',
    prNumber: 7,
    reviewerModel: 'claude',
    critical: false,
    reviewSummary: 'Summary',
    reviewBody: 'Body',
    remediationReply: {
      state: 'worker-wrote-reply',
      path: 'data/follow-up-jobs/workspaces/job-1/.adversarial-follow-up/remediation-reply.json',
      arbitraryKey: 'should-not-survive',
      reReview: {
        requested: true,
      },
    },
  }, null, 2)}\n`, 'utf8');

  const normalized = readFollowUpJob(jobPath);
  assert.deepEqual(normalized.remediationReply, {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    state: 'worker-wrote-reply',
    path: 'data/follow-up-jobs/workspaces/job-1/.adversarial-follow-up/remediation-reply.json',
  });
  assert.equal('arbitraryKey' in normalized.remediationReply, false);
  assert.equal('reReview' in normalized.remediationReply, false);
});

test('readFollowUpJob normalizes persisted remediation stop metadata through trusted stop builder', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const jobPath = path.join(rootDir, 'job.json');
  writeFileSync(jobPath, `${JSON.stringify({
    schemaVersion: 2,
    kind: 'adversarial-review-follow-up',
    status: 'stopped',
    jobId: 'job-1',
    createdAt: '2026-04-21T08:00:00.000Z',
    repo: 'laceyenterprises/clio',
    prNumber: 7,
    reviewerModel: 'claude',
    critical: false,
    reviewSummary: 'Summary',
    reviewBody: 'Body',
    remediationPlan: {
      mode: 'bounded-manual-rounds',
      maxRounds: 2,
      currentRound: 1,
      rounds: [{ round: 1, state: 'stopped' }],
      stopReason: 'Persisted reason',
      stop: {
        code: 17,
        reason: ['bad-type'],
        stoppedAt: '2026-04-21T10:00:00.000Z',
        stoppedBy: { type: 'operator', requestedBy: 'paul' },
        sourceStatus: false,
        currentRound: 999,
        maxRounds: 999,
        arbitraryKey: 'should-not-survive',
      },
    },
  }, null, 2)}\n`, 'utf8');

  const normalized = readFollowUpJob(jobPath);
  assert.deepEqual(normalized.remediationPlan.stop, buildStopMetadata({
    code: 17,
    reason: 'Persisted reason',
    stoppedAt: '2026-04-21T10:00:00.000Z',
    stoppedBy: { type: 'operator', requestedBy: 'paul' },
    sourceStatus: false,
    currentRound: 1,
    maxRounds: 2,
  }));
  assert.equal('arbitraryKey' in normalized.remediationPlan.stop, false);
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

test('claimNextFollowUpJob continues past an exhausted job when stopped-marking fails', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob({
    ...makeJobInput(rootDir),
    maxRemediationRounds: 1,
  });
  createFollowUpJob({
    ...makeJobInput(rootDir),
    prNumber: 8,
    reviewPostedAt: '2026-04-21T09:00:00.000Z',
  });

  const exhaustedPath = path.join(getFollowUpJobDir(rootDir, 'pending'), 'laceyenterprises__clio-pr-7-2026-04-21T08-00-00-000Z.json');
  const exhausted = readFollowUpJob(exhaustedPath);
  writeFollowUpJob(exhaustedPath, {
    ...exhausted,
    remediationPlan: {
      ...exhausted.remediationPlan,
      currentRound: 1,
      rounds: [{ round: 1, state: 'completed' }],
    },
  });

  const claimed = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-04-21T10:00:00.000Z',
    markStoppedImpl: () => {
      throw new Error('broken stop move');
    },
  });

  assert.ok(claimed);
  assert.equal(claimed.job.prNumber, 8);
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

test('markFollowUpJobFailed preserves remediationWorker metadata for existing callers', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });
  writeFollowUpJob(claimed.jobPath, {
    ...claimed.job,
    remediationWorker: {
      model: 'codex',
      state: 'spawned',
      processId: 8123,
      outputPath: 'data/follow-up-jobs/workspaces/job/.adversarial-follow-up/codex-last-message.md',
    },
  });

  const failed = markFollowUpJobFailed({
    rootDir,
    jobPath: claimed.jobPath,
    error: new Error('worker crashed'),
    failedAt: '2026-04-21T10:05:00.000Z',
    failure: {
      finalMessagePath: 'data/follow-up-jobs/workspaces/job/.adversarial-follow-up/codex-last-message.md',
    },
  });

  assert.equal(failed.job.remediationWorker.processId, 8123);
  assert.equal(failed.job.failure.finalMessagePath, 'data/follow-up-jobs/workspaces/job/.adversarial-follow-up/codex-last-message.md');
});

test('markFollowUpJobFailed preserves the supplied failureCode even when failure metadata has its own code field', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });

  const failed = markFollowUpJobFailed({
    rootDir,
    jobPath: claimed.jobPath,
    error: new Error('worker reply artifact was invalid'),
    failedAt: '2026-04-21T10:05:00.000Z',
    failureCode: 'invalid-remediation-reply',
    failure: {
      code: 'accidental-override',
      remediationReplyPath: 'data/follow-up-jobs/workspaces/job/.adversarial-follow-up/remediation-reply.json',
    },
  });

  assert.equal(failed.job.failure.code, 'invalid-remediation-reply');
  assert.equal(failed.job.remediationPlan.rounds[0].failure.code, 'invalid-remediation-reply');
});

// R5 review blocking #1: every terminal record must land in failed/
// (or completed/, stopped/) with `commentDelivery` already populated,
// so the retry walker has a recoverable shape if the post step
// crashes before its own pre-stamp. The mark* functions accept an
// owed-delivery shape and embed it atomically with the move.
test('markFollowUpJobFailed embeds commentDelivery atomically with the terminal write', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });

  const owed = {
    posted: false,
    attempting: false,
    attempts: 0,
    body: '### Remediation Worker — failed',
    repo: 'laceyenterprises/clio',
    prNumber: 7,
    workerClass: 'codex',
    owedAt: '2026-04-21T10:05:00.000Z',
  };
  const failed = markFollowUpJobFailed({
    rootDir,
    jobPath: claimed.jobPath,
    error: new Error('artifact missing'),
    failedAt: '2026-04-21T10:05:00.000Z',
    failureCode: 'artifact-missing-completion',
    commentDelivery: owed,
  });

  const onDisk = JSON.parse(readFileSync(failed.jobPath, 'utf8'));
  assert.equal(onDisk.commentDelivery.posted, false);
  assert.equal(onDisk.commentDelivery.body, '### Remediation Worker — failed');
  assert.equal(onDisk.commentDelivery.repo, 'laceyenterprises/clio');
  assert.equal(onDisk.commentDelivery.prNumber, 7);
  assert.equal(onDisk.commentDelivery.workerClass, 'codex');
  assert.equal(onDisk.commentDelivery.owedAt, '2026-04-21T10:05:00.000Z');
});

test('markFollowUpJobCompleted embeds commentDelivery atomically with the terminal write', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });

  const owed = {
    posted: false,
    attempting: false,
    attempts: 0,
    body: '### Remediation Worker — completed',
    repo: 'laceyenterprises/clio',
    prNumber: 7,
    workerClass: 'codex',
    owedAt: '2026-04-21T10:06:00.000Z',
  };
  const completed = markFollowUpJobCompleted({
    rootDir,
    jobPath: claimed.jobPath,
    completedAt: '2026-04-21T10:06:00.000Z',
    commentDelivery: owed,
  });

  const onDisk = JSON.parse(readFileSync(completed.jobPath, 'utf8'));
  assert.equal(onDisk.commentDelivery.body, '### Remediation Worker — completed');
  assert.equal(onDisk.commentDelivery.owedAt, '2026-04-21T10:06:00.000Z');
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

test('validateRemediationReply rejects non-string validation and blocker entries', () => {
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
      validation: ['npm test', { command: 'npm run lint' }],
      blockers: [],
      reReview: {
        requested: false,
        reason: null,
      },
    }, { expectedJob: job }),
    /validation\[1\] must be a non-empty string/
  );

  assert.throws(
    () => validateRemediationReply({
      kind: REMEDIATION_REPLY_KIND,
      schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
      jobId: job.jobId,
      repo: job.repo,
      prNumber: job.prNumber,
      outcome: 'blocked',
      summary: 'Blocked on missing credential.',
      validation: [],
      blockers: ['waiting on token', '   '],
      reReview: {
        requested: false,
        reason: null,
      },
    }, { expectedJob: job }),
    /blockers\[1\] must be a non-empty string/
  );
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

test('readRemediationReplyArtifact wraps filesystem errors with artifact and job context', () => {
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
    () => readRemediationReplyArtifact('/tmp/missing-reply.json', { expectedJob: job }),
    /Failed to read remediation reply artifact at \/tmp\/missing-reply\.json for job .* \(laceyenterprises\/clio#42\): ENOENT/
  );
});

test('readRemediationReplyArtifact wraps parse and validation errors with artifact context', () => {
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
  const badJsonPath = path.join(rootDir, 'bad-reply.json');
  const invalidReplyPath = path.join(rootDir, 'invalid-reply.json');

  writeFileSync(badJsonPath, '{not-json}\n', 'utf8');
  writeFileSync(invalidReplyPath, `${JSON.stringify({
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome: 'completed',
    summary: 'Patched null handling.',
    validation: ['npm test', { command: 'npm run lint' }],
    blockers: [],
    reReview: {
      requested: false,
      reason: null,
    },
  }, null, 2)}\n`, 'utf8');

  assert.throws(
    () => readRemediationReplyArtifact(badJsonPath, { expectedJob: job }),
    /Failed to read remediation reply artifact at .*bad-reply\.json.*JSON.*position|Failed to read remediation reply artifact at .*bad-reply\.json.*Expected property name/
  );
  assert.throws(
    () => readRemediationReplyArtifact(invalidReplyPath, { expectedJob: job }),
    /Failed to read remediation reply artifact at .*invalid-reply\.json.*validation\[1\] must be a non-empty string/
  );
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

test('markFollowUpJobCompleted preserves metadata for finishedAt/completionPreview callers', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });
  writeFollowUpJob(claimed.jobPath, {
    ...claimed.job,
    remediationWorker: {
      model: 'codex',
      state: 'spawned',
      processId: 8123,
    },
  });

  const completed = markFollowUpJobCompleted({
    rootDir,
    jobPath: claimed.jobPath,
    finishedAt: '2026-04-21T10:07:00.000Z',
    completionPreview: 'Patched auth refresh path.',
  });

  assert.equal(completed.job.completedAt, '2026-04-21T10:07:00.000Z');
  assert.equal(completed.job.completion.preview, 'Patched auth refresh path.');
  assert.equal(completed.job.remediationWorker.processId, 8123);
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

test('requeueFollowUpJobForNextRound moves a completed job back to pending for the next bounded round', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });
  const completed = markFollowUpJobCompleted({
    rootDir,
    jobPath: claimed.jobPath,
    finishedAt: '2026-04-21T10:05:00.000Z',
    completionPreview: 'Patched auth refresh path.',
    reReview: {
      requested: true,
      status: 'pending',
      reason: 'Needs another adversarial pass.',
      triggered: true,
      outcomeReason: null,
      reviewRow: null,
      requestedAt: '2026-04-21T10:05:00.000Z',
    },
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

test('requeueFollowUpJobForNextRound stops a completed job when no durable re-review request was recorded', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });
  const completed = markFollowUpJobCompleted({
    rootDir,
    jobPath: claimed.jobPath,
    finishedAt: '2026-04-21T10:05:00.000Z',
    completionPreview: 'Patched auth refresh path.',
    reReview: {
      requested: false,
      status: 'not-requested',
      reason: null,
      triggered: false,
      outcomeReason: 'reply-did-not-request-rereview',
      reviewRow: null,
      requestedAt: null,
    },
  });

  const stopped = requeueFollowUpJobForNextRound({
    rootDir,
    jobPath: completed.jobPath,
    requestedAt: '2026-04-21T10:06:00.000Z',
    requestedBy: 'operator',
    reason: 'Trying another round anyway.',
  });

  assert.match(stopped.jobPath, /data\/follow-up-jobs\/stopped\/.+\.json$/);
  assert.equal(stopped.job.status, 'stopped');
  assert.equal(stopped.job.remediationPlan.stop.code, 'no-progress');
  assert.match(stopped.job.remediationPlan.stop.reason, /No durable re-review request/);
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
  assert.equal(stopped.job.remediationPlan.stop.code, 'max-rounds-reached');
  assert.match(stopped.job.remediationPlan.stopReason, /Reached max remediation rounds \(1\/1\)/);
});

test('requeueFollowUpJobForNextRound rejects non-terminal source statuses', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const created = createFollowUpJob(makeJobInput(rootDir));

  assert.throws(
    () => requeueFollowUpJobForNextRound({
      rootDir,
      jobPath: created.jobPath,
    }),
    /Cannot requeue follow-up job .* from status pending/
  );
});

test('stopFollowUpJob moves a non-terminal job to stopped with operator-visible metadata', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });

  const stopped = stopFollowUpJob({
    rootDir,
    jobPath: claimed.jobPath,
    requestedAt: '2026-04-21T10:01:00.000Z',
    requestedBy: 'paul',
    reason: 'Operator requested stop for manual handling.',
  });

  assert.match(stopped.jobPath, /data\/follow-up-jobs\/stopped\/.+\.json$/);
  assert.equal(stopped.job.status, 'stopped');
  assert.equal(stopped.job.remediationPlan.stop.code, 'operator-stop');
  assert.equal(stopped.job.remediationPlan.stop.stoppedBy.requestedBy, 'paul');
  assert.equal(stopped.job.remediationPlan.rounds[0].state, 'stopped');
  assert.equal(stopped.job.remediationPlan.rounds[0].stop.code, 'operator-stop');
});
