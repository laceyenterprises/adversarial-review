import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAX_REMEDIATION_ROUNDS,
  FOLLOW_UP_JOB_SCHEMA_VERSION,
  ROUND_BUDGET_BY_RISK_CLASS,
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
  salvagePartialRemediationReply,
  readFollowUpJob,
  resolveRoundBudgetForJob,
  requeueFollowUpJobForNextRound,
  stopFollowUpJob,
  summarizePRRemediationLedger,
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

const MISSING_REMEDIATION_WORKER = Symbol('missing-remediation-worker');

function writeLedgerTerminalJob(rootDir, {
  fileName,
  remediationWorker = MISSING_REMEDIATION_WORKER,
  currentRound = 1,
  status = 'completed',
} = {}) {
  const dir = getFollowUpJobDir(rootDir, status);
  mkdirSync(dir, { recursive: true });
  const jobPath = path.join(dir, fileName);
  const job = {
    schemaVersion: FOLLOW_UP_JOB_SCHEMA_VERSION,
    kind: 'adversarial-review-follow-up',
    status,
    jobId: fileName.replace(/\.json$/, ''),
    createdAt: '2026-05-04T12:00:00.000Z',
    completedAt: '2026-05-04T12:05:00.000Z',
    repo: 'laceyenterprises/agent-os',
    prNumber: 199,
    reviewerModel: 'codex',
    critical: true,
    reviewSummary: 'summary',
    reviewBody: 'body',
    recommendedFollowUpAction: {
      type: 'address-adversarial-review',
      priority: 'high',
      executionModel: 'bounded-manual-rounds',
      maxRounds: 3,
    },
    remediationPlan: {
      mode: 'bounded-manual-rounds',
      maxRounds: 3,
      currentRound,
      rounds: [],
      stop: null,
      nextAction: null,
    },
    remediationReply: {
      kind: REMEDIATION_REPLY_KIND,
      schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
      state: 'awaiting-worker-write',
      path: null,
    },
  };

  if (remediationWorker !== MISSING_REMEDIATION_WORKER) {
    job.remediationWorker = remediationWorker;
  }

  writeFollowUpJob(jobPath, job);
}

function writePlanMappingFixture(rootDir, {
  planDir = 'projects/example-project',
  planFile = 'PLAN-track-x.json',
  planTicketId = 'T1',
  linearTicketId = 'LAC-207',
  riskClass = 'medium',
  corruptPlan = false,
} = {}) {
  const planDirPath = path.join(rootDir, planDir);
  const planPath = path.join(planDirPath, planFile);
  const mappingPath = `${planPath}.linear-mapping.json`;

  mkdirSync(planDirPath, { recursive: true });
  writeFileSync(mappingPath, `${JSON.stringify({ [planTicketId]: linearTicketId }, null, 2)}\n`, 'utf8');
  writeFileSync(
    planPath,
    corruptPlan
      ? '{not-json}\n'
      : `${JSON.stringify({
          planSchemaVersion: 1,
          tickets: [{ id: planTicketId, riskClass }],
        }, null, 2)}\n`,
    'utf8'
  );
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
  assert.equal(job.riskClass, null);
  assert.deepEqual(job.remediationPlan.rounds, []);
  assert.equal(job.remediationReply.kind, REMEDIATION_REPLY_KIND);
  assert.equal(job.remediationReply.schemaVersion, REMEDIATION_REPLY_SCHEMA_VERSION);
  assert.equal(job.remediationReply.state, 'awaiting-worker-write');
  assert.equal(job.remediationReply.path, null);
  assert.match(job.jobId, /^laceyenterprises__clio-pr-42-/);
});

test('createFollowUpJob writes the pending job JSON under data/follow-up-jobs/pending', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  writePlanMappingFixture(rootDir, { linearTicketId: 'LAC-207', riskClass: 'high' });
  const { job, jobPath } = createFollowUpJob({
    ...makeJobInput(rootDir),
    linearTicketId: 'LAC-207',
  });

  assert.match(jobPath, /data\/follow-up-jobs\/pending\/.+\.json$/);

  const persisted = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.deepEqual(persisted, job);
  assert.equal(persisted.recommendedFollowUpAction.priority, 'high');
  assert.equal(persisted.riskClass, 'high');
  assert.equal(persisted.remediationPlan.maxRounds, 3);
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
  assert.equal(normalized.remediationPlan.maxRounds, 6);
  assert.equal(normalized.remediationPlan.currentRound, 1);
  assert.equal(normalized.remediationPlan.rounds[0].state, 'completed');
  assert.equal(normalized.remediationPlan.rounds[0].worker.processId, 8123);
  assert.equal(normalized.remediationPlan.rounds[0].completion.preview, 'Legacy completion');
  assert.equal(normalized.recommendedFollowUpAction.executionModel, 'bounded-manual-rounds');
  assert.equal(normalized.remediationReply.kind, REMEDIATION_REPLY_KIND);
  assert.equal(normalized.remediationReply.state, 'awaiting-worker-write');
  assert.equal(normalized.remediationReply.path, null);
});

test('resolveRoundBudgetForJob maps each supported risk class to the expected round budget', () => {
  for (const [riskClass, expectedBudget] of Object.entries(ROUND_BUDGET_BY_RISK_CLASS)) {
    const resolution = resolveRoundBudgetForJob({
      riskClass,
      remediationPlan: { maxRounds: expectedBudget },
    }, { rootDir: '/tmp' });
    assert.equal(resolution.riskClass, riskClass);
    assert.equal(resolution.roundBudget, expectedBudget);
  }
});

test('resolveRoundBudgetForJob falls back to medium for spec-less jobs', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const resolution = resolveRoundBudgetForJob({
    repo: 'laceyenterprises/clio',
    prNumber: 7,
    linearTicketId: null,
  }, { rootDir, preferPersisted: false });

  assert.equal(resolution.riskClass, 'medium');
  assert.equal(resolution.roundBudget, 1);
});

test('resolveRoundBudgetForJob resolves risk class from plan mapping sidecars', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  writePlanMappingFixture(rootDir, {
    linearTicketId: 'LAC-501',
    planTicketId: 'PMO-A1',
    riskClass: 'critical',
  });

  const resolution = resolveRoundBudgetForJob({
    repo: 'laceyenterprises/clio',
    prNumber: 7,
    linearTicketId: 'LAC-501',
  }, { rootDir, preferPersisted: false });

  assert.equal(resolution.riskClass, 'critical');
  assert.equal(resolution.roundBudget, 3);
});

test('resolveRoundBudgetForJob falls back to medium when the linked plan file is corrupt', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  writePlanMappingFixture(rootDir, {
    linearTicketId: 'LAC-999',
    planTicketId: 'BROKEN-1',
    riskClass: 'critical',
    corruptPlan: true,
  });

  const resolution = resolveRoundBudgetForJob({
    repo: 'laceyenterprises/clio',
    prNumber: 7,
    linearTicketId: 'LAC-999',
  }, { rootDir, preferPersisted: false });

  assert.equal(resolution.riskClass, 'medium');
  assert.equal(resolution.roundBudget, 1);
});

test('summarizePRRemediationLedger excludes terminal jobs without a spawned remediation worker', () => {
  const cases = [
    ['null remediationWorker', null, 0],
    ['missing remediationWorker', MISSING_REMEDIATION_WORKER, 0],
    ['never-spawned remediationWorker', { state: 'never-spawned' }, 0],
    ['spawned remediationWorker', { state: 'spawned' }, 2],
    ['completed remediationWorker', { state: 'completed' }, 2],
    ['array remediationWorker', [], 0],
    ['malformed remediationWorker', 'corrupt-worker-shape', 0],
  ];

  for (const [label, remediationWorker, expectedRounds] of cases) {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
    try {
      writeLedgerTerminalJob(rootDir, {
        fileName: `${label.replace(/\s+/g, '-')}.json`,
        remediationWorker,
        currentRound: 2,
      });

      const summary = summarizePRRemediationLedger(rootDir, {
        repo: 'laceyenterprises/agent-os',
        prNumber: 199,
      });

      assert.equal(summary.completedRoundsForPR, expectedRounds, label);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
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

test('validateRemediationReply rejects non-string validation entries', () => {
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
});

test('validateRemediationReply accepts legacy string-array blockers under schemaVersion 1 (backward compat)', () => {
  // The blockers field carries two shapes under `schemaVersion: 1`:
  // - structured objects { finding, reasoning?, needsHumanInput? } —
  //   the new per-finding accountability form.
  // - legacy non-empty strings — predates the structured form and is
  //   what previously-persisted reply artifacts on disk hold. The
  //   reconciler re-reads those artifacts during retry / comment
  //   recovery, so rejecting the legacy shape outright would render
  //   valid persisted data invalid mid-deploy. Keeping schemaVersion 1
  //   backward-compatible (the reviewer's recommended fix) avoids a
  //   schema bump + branched validation + migration tests.
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 42,
    reviewerModel: 'codex',
    reviewBody: '## Summary\nTighten null handling.',
    reviewPostedAt: '2026-04-21T07:46:00.000Z',
    critical: false,
  });

  const legacyReply = {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome: 'blocked',
    summary: 'Blocked on missing credential.',
    validation: [],
    blockers: ['waiting on token'],
    reReview: { requested: false, reason: null },
    // No addressed[]/pushback[] — legacy reply, coverage check skipped.
  };

  assert.deepEqual(validateRemediationReply(legacyReply, { expectedJob: job }), legacyReply);
});

test('validateRemediationReply rejects blank string entries in legacy blockers form', () => {
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 43,
    reviewerModel: 'codex',
    reviewBody: '## Summary\nTighten null handling.',
    reviewPostedAt: '2026-04-21T07:47:00.000Z',
    critical: false,
  });

  assert.throws(
    () => validateRemediationReply({
      kind: REMEDIATION_REPLY_KIND,
      schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
      jobId: job.jobId,
      repo: job.repo,
      prNumber: job.prNumber,
      outcome: 'blocked',
      summary: 'Blocked on something.',
      validation: [],
      blockers: ['   '],
      reReview: { requested: false, reason: null },
    }, { expectedJob: job }),
    /blockers\[0\] must be a non-empty string/
  );
});

test('validateRemediationReply accepts structured blockers with finding+reasoning', () => {
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 60,
    reviewerModel: 'codex',
    reviewBody: '## Summary\nThree findings.',
    reviewPostedAt: '2026-05-02T14:00:00.000Z',
    critical: false,
  });

  const reply = {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome: 'blocked',
    summary: 'Hard exit on finding 3.',
    validation: ['npm test'],
    blockers: [
      {
        finding: 'Reviewer wants a destructive schema migration on a 50M-row table.',
        reasoning: 'Migration requires DBA approval; not within worker authority.',
        needsHumanInput: 'DBA approval + maintenance window',
      },
    ],
    reReview: { requested: false, reason: null },
  };

  assert.deepEqual(validateRemediationReply(reply, { expectedJob: job }), reply);
});

test('validateRemediationReply rejects malformed blockers[] entries', () => {
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 61,
    reviewerModel: 'codex',
    reviewBody: '## Summary\nx',
    reviewPostedAt: '2026-05-02T15:00:00.000Z',
    critical: false,
  });

  const baseReply = {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome: 'blocked',
    summary: 'Stopped on a hard exit.',
    validation: [],
    addressed: [],
    pushback: [],
    reReview: { requested: false, reason: null },
  };

  // Missing finding.
  assert.throws(
    () => validateRemediationReply(
      { ...baseReply, blockers: [{ reasoning: 'no finding here' }] },
      { expectedJob: job }
    ),
    /blockers\[0\]\.finding must be a non-empty string/
  );

  // Has finding but neither reasoning nor needsHumanInput.
  assert.throws(
    () => validateRemediationReply(
      { ...baseReply, blockers: [{ finding: 'X' }] },
      { expectedJob: job }
    ),
    /blockers\[0\] must include a non-empty reasoning or needsHumanInput field/
  );

  // Array (not an object, not a string) rejected.
  assert.throws(
    () => validateRemediationReply(
      { ...baseReply, blockers: [['nested', 'array']] },
      { expectedJob: job }
    ),
    /blockers\[0\] must be a non-empty string or an object/
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

test('buildRemediationReply carries addressed[] and pushback[] entries through to the durable reply', () => {
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 51,
    reviewerModel: 'codex',
    linearTicketId: 'LAC-51',
    reviewBody: '## Summary\nThree blocking issues.',
    reviewPostedAt: '2026-05-02T10:00:00.000Z',
    critical: false,
  });

  const reply = buildRemediationReply({
    job,
    outcome: 'completed',
    summary: 'Two findings fixed; pushed back on the third.',
    validation: ['npm test'],
    addressed: [
      {
        finding: 'Race in retry path can double-submit.',
        action: 'Added an idempotency token + dedupe check.',
        files: ['src/worker.mjs'],
      },
      {
        finding: 'Missing null check on auth header.',
        action: 'Added explicit guard + regression test.',
      },
    ],
    pushback: [
      {
        finding: 'Reviewer asked to refactor the entire dispatch module.',
        reasoning: 'Out of scope for this PR; tracked as separate ticket LAC-99.',
      },
    ],
    blockers: [],
    reReviewRequested: true,
    reReviewReason: 'Two of three addressed, one pushback recorded — ready for re-review.',
  });

  assert.equal(reply.addressed.length, 2);
  assert.equal(reply.addressed[0].finding, 'Race in retry path can double-submit.');
  assert.deepEqual(reply.addressed[0].files, ['src/worker.mjs']);
  assert.equal(reply.pushback.length, 1);
  assert.equal(reply.pushback[0].reasoning, 'Out of scope for this PR; tracked as separate ticket LAC-99.');
  assert.deepEqual(validateRemediationReply(reply, { expectedJob: job }), reply);
});

test('validateRemediationReply tolerates a reply that omits addressed/pushback entirely (legacy compat)', () => {
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 52,
    reviewerModel: 'codex',
    reviewBody: '## Summary\nOne tiny fix.',
    reviewPostedAt: '2026-05-02T11:00:00.000Z',
    critical: false,
  });

  const legacyReply = {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome: 'completed',
    summary: 'Fixed.',
    validation: ['npm test'],
    blockers: [],
    reReview: { requested: true, reason: 'ready for confirmation' },
    // No addressed[], no pushback[].
  };

  assert.deepEqual(validateRemediationReply(legacyReply, { expectedJob: job }), legacyReply);
});

test('validateRemediationReply rejects malformed addressed[] entries', () => {
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 53,
    reviewerModel: 'codex',
    reviewBody: '## Summary\nx',
    reviewPostedAt: '2026-05-02T12:00:00.000Z',
    critical: false,
  });

  const baseReply = {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome: 'completed',
    summary: 'Fix.',
    validation: ['npm test'],
    blockers: [],
    pushback: [],
    reReview: { requested: true, reason: 'go' },
  };

  // Missing action.
  assert.throws(
    () => validateRemediationReply(
      { ...baseReply, addressed: [{ finding: 'X', action: '' }] },
      { expectedJob: job }
    ),
    /addressed\[0\]\.action must be a non-empty string/
  );

  // Missing finding.
  assert.throws(
    () => validateRemediationReply(
      { ...baseReply, addressed: [{ finding: '', action: 'did the thing' }] },
      { expectedJob: job }
    ),
    /addressed\[0\]\.finding must be a non-empty string/
  );

  // files present but not an array.
  assert.throws(
    () => validateRemediationReply(
      { ...baseReply, addressed: [{ finding: 'X', action: 'Y', files: 'a.js' }] },
      { expectedJob: job }
    ),
    /addressed\[0\]\.files must be an array if provided/
  );

  // files contains a blank string.
  assert.throws(
    () => validateRemediationReply(
      { ...baseReply, addressed: [{ finding: 'X', action: 'Y', files: ['a.js', '   '] }] },
      { expectedJob: job }
    ),
    /addressed\[0\]\.files\[1\] must be a non-empty string/
  );

  // Entry is a string (workers sometimes try to send the legacy
  // string-array shape).
  assert.throws(
    () => validateRemediationReply(
      { ...baseReply, addressed: ['Just a string'] },
      { expectedJob: job }
    ),
    /addressed\[0\] must be an object/
  );
});

test('validateRemediationReply rejects malformed pushback[] entries', () => {
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 54,
    reviewerModel: 'codex',
    reviewBody: '## Summary\nx',
    reviewPostedAt: '2026-05-02T13:00:00.000Z',
    critical: false,
  });

  const baseReply = {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome: 'completed',
    summary: 'Fix.',
    validation: ['npm test'],
    addressed: [],
    blockers: [],
    reReview: { requested: true, reason: 'go' },
  };

  // Missing reasoning.
  assert.throws(
    () => validateRemediationReply(
      { ...baseReply, pushback: [{ finding: 'X', reasoning: '' }] },
      { expectedJob: job }
    ),
    /pushback\[0\]\.reasoning must be a non-empty string/
  );

  // Missing finding.
  assert.throws(
    () => validateRemediationReply(
      { ...baseReply, pushback: [{ finding: '', reasoning: 'because' }] },
      { expectedJob: job }
    ),
    /pushback\[0\]\.finding must be a non-empty string/
  );

  // Entry is an array, not an object.
  assert.throws(
    () => validateRemediationReply(
      { ...baseReply, pushback: [['X', 'Y']] },
      { expectedJob: job }
    ),
    /pushback\[0\] must be an object/
  );
});

// ── Cross-field semantic invariants ─────────────────────────────────────────
//
// The contract claims: populated `blockers` is a hard exit, so
// `reReview.requested` must be false. Without these tests the contract
// is documentation-only — a contradictory reply slips through and
// corrupts queue state (rereview re-arms while the PR comment also
// claims human intervention is required).

test('validateRemediationReply rejects populated blockers + reReview.requested = true', () => {
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 71,
    reviewerModel: 'codex',
    reviewBody: '## Summary\nx',
    reviewPostedAt: '2026-05-02T16:00:00.000Z',
    critical: false,
  });

  assert.throws(
    () => validateRemediationReply({
      kind: REMEDIATION_REPLY_KIND,
      schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
      jobId: job.jobId,
      repo: job.repo,
      prNumber: job.prNumber,
      outcome: 'partial',
      summary: 'Asking for re-review while also marking a hard exit.',
      validation: ['npm test'],
      blockers: [
        { finding: 'Need DBA window', reasoning: 'cannot proceed without it' },
      ],
      reReview: { requested: true, reason: 'wants confirmation' },
    }, { expectedJob: job }),
    /blockers are populated but reReview\.requested is true/
  );
});

test('validateRemediationReply rejects outcome=blocked with empty blockers', () => {
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 72,
    reviewerModel: 'codex',
    reviewBody: '## Summary\nx',
    reviewPostedAt: '2026-05-02T16:01:00.000Z',
    critical: false,
  });

  assert.throws(
    () => validateRemediationReply({
      kind: REMEDIATION_REPLY_KIND,
      schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
      jobId: job.jobId,
      repo: job.repo,
      prNumber: job.prNumber,
      outcome: 'blocked',
      summary: 'Blocked but no blockers listed.',
      validation: [],
      blockers: [],
      reReview: { requested: false, reason: null },
    }, { expectedJob: job }),
    /outcome is "blocked" but blockers is empty/
  );
});

test('validateRemediationReply rejects outcome=blocked with reReview.requested = true', () => {
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 73,
    reviewerModel: 'codex',
    reviewBody: '## Summary\nx',
    reviewPostedAt: '2026-05-02T16:02:00.000Z',
    critical: false,
  });

  assert.throws(
    () => validateRemediationReply({
      kind: REMEDIATION_REPLY_KIND,
      schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
      jobId: job.jobId,
      repo: job.repo,
      prNumber: job.prNumber,
      outcome: 'blocked',
      summary: 'Hard exit but also re-queue.',
      validation: [],
      // Note: this trips the populated-blockers-with-rereview rule
      // first; both rules cover this combination.
      blockers: [
        { finding: 'X', reasoning: 'cannot proceed' },
      ],
      reReview: { requested: true, reason: 'still want a pass' },
    }, { expectedJob: job }),
    /blockers are populated but reReview\.requested is true|outcome is "blocked" but reReview\.requested is true/
  );
});

test('validateRemediationReply rejects outcome=completed with non-empty blockers', () => {
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 74,
    reviewerModel: 'codex',
    reviewBody: '## Summary\nx',
    reviewPostedAt: '2026-05-02T16:03:00.000Z',
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
      summary: 'Claims completion while listing blockers.',
      validation: ['npm test'],
      blockers: [
        { finding: 'X', reasoning: 'still pending' },
      ],
      reReview: { requested: false, reason: null },
    }, { expectedJob: job }),
    /outcome is "completed" but blockers is non-empty/
  );
});

test('validateRemediationReply accepts outcome=blocked with reReview.requested = false and a populated blockers list', () => {
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 75,
    reviewerModel: 'codex',
    reviewBody: '## Summary\nx',
    reviewPostedAt: '2026-05-02T16:04:00.000Z',
    critical: false,
  });

  const reply = {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome: 'blocked',
    summary: 'Hit a hard exit on the destructive migration finding.',
    validation: ['npm test'],
    blockers: [
      {
        finding: 'Reviewer asks for a destructive schema change.',
        reasoning: 'Worker has no authority to schedule a DBA window.',
      },
    ],
    reReview: { requested: false, reason: null },
  };

  assert.deepEqual(validateRemediationReply(reply, { expectedJob: job }), reply);
});

// ── Placeholder/template-text rejection ─────────────────────────────────────

test('validateRemediationReply rejects placeholder summary text from the prompt template', () => {
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 80,
    reviewerModel: 'codex',
    reviewBody: '## Summary\nx',
    reviewPostedAt: '2026-05-02T17:00:00.000Z',
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
      // Verbatim from the prompt's contract example.
      summary: 'Replace this with a short remediation summary.',
      validation: ['npm test'],
      blockers: [],
      reReview: { requested: false, reason: null },
    }, { expectedJob: job }),
    /summary contains placeholder\/example text/
  );
});

test('validateRemediationReply rejects placeholder text in addressed/pushback/blockers entries', () => {
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 81,
    reviewerModel: 'codex',
    reviewBody: '## Summary\nx',
    reviewPostedAt: '2026-05-02T17:01:00.000Z',
    critical: false,
  });

  const baseReply = {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome: 'completed',
    summary: 'Did the work.',
    validation: ['npm test'],
    pushback: [],
    blockers: [],
    reReview: { requested: true, reason: 'ready' },
  };

  // Placeholder copied from the prompt into addressed[].finding.
  assert.throws(
    () => validateRemediationReply(
      {
        ...baseReply,
        addressed: [
          {
            finding: 'Replace with the review finding this entry addresses.',
            action: 'Real action.',
          },
        ],
      },
      { expectedJob: job }
    ),
    /addressed\[0\]\.finding contains placeholder\/example text/
  );

  // Placeholder copied into addressed[].action.
  assert.throws(
    () => validateRemediationReply(
      {
        ...baseReply,
        addressed: [
          {
            finding: 'Real finding.',
            action: 'Replace with what you did to address it.',
          },
        ],
      },
      { expectedJob: job }
    ),
    /addressed\[0\]\.action contains placeholder\/example text/
  );

  // Placeholder copied into addressed[].files[].
  assert.throws(
    () => validateRemediationReply(
      {
        ...baseReply,
        addressed: [
          {
            finding: 'Real finding.',
            action: 'Real action.',
            files: ['Optional list of files changed for this finding.'],
          },
        ],
      },
      { expectedJob: job }
    ),
    /addressed\[0\]\.files\[0\] contains placeholder\/example text/
  );

  // Placeholder copied into pushback[].finding.
  assert.throws(
    () => validateRemediationReply(
      {
        ...baseReply,
        addressed: [],
        pushback: [
          {
            finding: 'Replace with a finding you deliberately did NOT change the code on.',
            reasoning: 'Out of scope.',
          },
        ],
      },
      { expectedJob: job }
    ),
    /pushback\[0\]\.finding contains placeholder\/example text/
  );

  // Placeholder copied into blockers[].reasoning.
  assert.throws(
    () => validateRemediationReply(
      {
        ...baseReply,
        addressed: [],
        outcome: 'blocked',
        reReview: { requested: false, reason: null },
        blockers: [
          {
            finding: 'Real blocker finding.',
            reasoning: 'Replace with one sharp sentence on why you disagreed.',
          },
        ],
      },
      { expectedJob: job }
    ),
    /blockers\[0\]\.reasoning contains placeholder\/example text/
  );
});

test('validateRemediationReply rejects placeholder text in reReview.reason', () => {
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 82,
    reviewerModel: 'codex',
    reviewBody: '## Summary\nx',
    reviewPostedAt: '2026-05-02T17:02:00.000Z',
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
      summary: 'Fixed everything.',
      validation: ['npm test'],
      blockers: [],
      reReview: {
        requested: true,
        reason: 'Replace with the reason this PR should receive another adversarial review pass.',
      },
    }, { expectedJob: job }),
    /reReview\.reason contains placeholder\/example text/
  );
});

// ── Placeholder false-positive guard ────────────────────────────────────────
//
// The earlier prefix-pattern detector rejected any string starting
// with `Replace with…` or `Optional list of files…`. That fired on
// legitimate review language ("Replace with parameterized queries",
// "Replace this regex; it can backtrack exponentially", etc.) and
// would hard-fail real remediation rounds as `invalid-remediation-
// reply`. The exact-string detector below MUST accept these strings.

test('validateRemediationReply accepts legitimate review language that the old prefix detector falsely rejected', () => {
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 90,
    reviewerModel: 'codex',
    reviewBody: '## Summary\nx',
    reviewPostedAt: '2026-05-02T18:00:00.000Z',
    critical: false,
  });

  const reply = {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome: 'completed',
    // Plausible legitimate phrasing the old prefix detector caught.
    summary: 'Replace this regex; it can backtrack exponentially.',
    validation: ['Replace with parameterized queries was applied; npm test green.'],
    addressed: [
      {
        finding: 'Replace this regex; it can backtrack exponentially.',
        action: 'Replace with parameterized queries.',
        files: ['Optional list of files for the migration.'],
      },
    ],
    pushback: [],
    blockers: [],
    reReview: { requested: true, reason: 'Replace this regex was the right fix; ready for re-review.' },
  };

  assert.deepEqual(validateRemediationReply(reply, { expectedJob: job }), reply);
});

// ── Per-finding coverage enforcement ────────────────────────────────────────
//
// The reviewer's blocking findings are the primary contract the worker
// must respond to. The validator parses the `## Blocking Issues` section
// of the review body and verifies the reply records exactly one entry
// per blocking finding across `addressed[]`, `pushback[]`, and
// `blockers[]`. Without this enforcement the prompt's accountability
// contract is documentation-only.

test('validateRemediationReply rejects a reply that fails to account for every blocking finding', () => {
  const reviewBody = [
    '## Summary',
    'Three problems.',
    '',
    '## Blocking Issues',
    '- File: src/a.mjs',
    '  Lines: 1-5',
    '  Problem: First problem.',
    '- File: src/b.mjs',
    '  Lines: 10-20',
    '  Problem: Second problem.',
    '- File: src/c.mjs',
    '  Lines: 30-40',
    '  Problem: Third problem.',
  ].join('\n');

  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 91,
    reviewerModel: 'codex',
    reviewBody,
    reviewPostedAt: '2026-05-02T18:01:00.000Z',
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
      summary: 'Fixed two of three.',
      validation: ['npm test'],
      addressed: [
        { finding: 'First problem.', action: 'Fixed.' },
        { finding: 'Second problem.', action: 'Fixed.' },
      ],
      pushback: [],
      blockers: [],
      reReview: { requested: true, reason: 'Two of three addressed.' },
    }, { expectedJob: job }),
    /does not account for every blocking finding.*review has 3 blocking issue\(s\), reply records 2/
  );
});

test('validateRemediationReply accepts a reply that accounts for every blocking finding (one per list permitted)', () => {
  const reviewBody = [
    '## Summary',
    'Two problems.',
    '',
    '## Blocking Issues',
    '- File: src/a.mjs',
    '  Problem: First.',
    '- File: src/b.mjs',
    '  Problem: Second.',
  ].join('\n');

  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 92,
    reviewerModel: 'codex',
    reviewBody,
    reviewPostedAt: '2026-05-02T18:02:00.000Z',
    critical: false,
  });

  const reply = {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome: 'completed',
    summary: 'One fixed; pushed back on the other.',
    validation: ['npm test'],
    addressed: [{ finding: 'First.', action: 'Fixed.' }],
    pushback: [{ finding: 'Second.', reasoning: 'Out of scope for this PR.' }],
    blockers: [],
    reReview: { requested: true, reason: 'One addressed, one deliberately deferred.' },
  };

  assert.deepEqual(validateRemediationReply(reply, { expectedJob: job }), reply);
});

test('validateRemediationReply tolerates two distinct findings that collapse to the same paraphrase', () => {
  // Two distinct review findings (different files, same root cause)
  // can legitimately reduce to the same `finding` string in the
  // worker reply. Free-form-text uniqueness was previously enforced
  // here and rejected such replies; that check was removed because
  // distinct strings are not the same as correct strings, so the
  // dedup added no real coverage and produced false rejections.
  const reviewBody = [
    '## Summary',
    'Same bug, two files.',
    '',
    '## Blocking Issues',
    '- File: src/a.mjs',
    '  Problem: Null pointer dereference on retry.',
    '- File: src/b.mjs',
    '  Problem: Null pointer dereference on retry.',
  ].join('\n');

  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 93,
    reviewerModel: 'codex',
    reviewBody,
    reviewPostedAt: '2026-05-02T18:03:00.000Z',
    critical: false,
  });

  const reply = {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome: 'completed',
    summary: 'Fixed the null deref in both files.',
    validation: ['npm test'],
    addressed: [
      { finding: 'Null pointer dereference on retry.', action: 'Guarded the retry path in src/a.mjs.' },
      { finding: 'Null pointer dereference on retry.', action: 'Guarded the retry path in src/b.mjs.' },
    ],
    pushback: [],
    blockers: [],
    reReview: { requested: true, reason: 'Ready.' },
  };

  assert.deepEqual(validateRemediationReply(reply, { expectedJob: job }), reply);
});

test('validateRemediationReply skips coverage enforcement when blocking section is empty (`- None.` sentinel)', () => {
  // The reviewer prompt mandates `- None.` as the explicit empty
  // sentinel for any zero-finding section. The coverage validator
  // must recognize it as zero findings; otherwise every valid
  // remediation reply for a clean review would fail validation and
  // be routed through `invalid-remediation-reply` instead of
  // rereview, stalling the convergence loop.
  const reviewBody = [
    '## Summary',
    'No blockers found.',
    '',
    '## Blocking Issues',
    '- None.',
    '',
    '## Non-blocking Issues',
    '- File: src/a.mjs',
    '  Problem: Style nit.',
    '',
    '## Verdict',
    'Comment only',
  ].join('\n');

  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 95,
    reviewerModel: 'codex',
    reviewBody,
    reviewPostedAt: '2026-05-02T18:05:00.000Z',
    critical: false,
  });

  // Worker opts into the new schema with empty addressed[]/pushback[]
  // because there are zero blocking findings to address. This is the
  // exact shape that previously failed (counted `- None.` as 1 finding,
  // demanded 1 entry, rejected as `invalid-remediation-reply`).
  const reply = {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome: 'completed',
    summary: 'No blocking findings; nothing to address.',
    validation: ['npm test'],
    addressed: [],
    pushback: [],
    blockers: [],
    reReview: { requested: true, reason: 'Clean review; ready to confirm.' },
  };

  assert.deepEqual(validateRemediationReply(reply, { expectedJob: job }), reply);
});

test('validateRemediationReply counts each issue once when fields are emitted as five top-level bullets per issue', () => {
  // The reviewer prompt does not mandate the indented-continuation
  // style. A compliant review can emit each per-issue field as its
  // own top-level `- ` bullet. The previous validator counted every
  // top-level `- ` line as a finding, so a single issue rendered as
  // five field bullets was miscounted as five findings, forcing the
  // worker to fabricate four extra accountability entries to pass.
  const reviewBody = [
    '## Summary',
    'Two issues, each rendered as five top-level field bullets.',
    '',
    '## Blocking Issues',
    '- File: src/a.mjs',
    '- Lines: 1-5',
    '- Problem: First problem.',
    '- Why it matters: First risk.',
    '- Recommended fix: First fix.',
    '- File: src/b.mjs',
    '- Lines: 10-20',
    '- Problem: Second problem.',
    '- Why it matters: Second risk.',
    '- Recommended fix: Second fix.',
  ].join('\n');

  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 96,
    reviewerModel: 'codex',
    reviewBody,
    reviewPostedAt: '2026-05-02T18:06:00.000Z',
    critical: false,
  });

  const reply = {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome: 'completed',
    summary: 'Fixed both findings.',
    validation: ['npm test'],
    addressed: [
      { finding: 'First problem.', action: 'Applied first fix.' },
      { finding: 'Second problem.', action: 'Applied second fix.' },
    ],
    pushback: [],
    blockers: [],
    reReview: { requested: true, reason: 'Ready.' },
  };

  assert.deepEqual(validateRemediationReply(reply, { expectedJob: job }), reply);
});

test('validateRemediationReply skips coverage enforcement on legacy replies that omit addressed[]/pushback[]', () => {
  const reviewBody = [
    '## Summary',
    'Two problems.',
    '',
    '## Blocking Issues',
    '- File: src/a.mjs',
    '  Problem: First.',
    '- File: src/b.mjs',
    '  Problem: Second.',
  ].join('\n');

  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 94,
    reviewerModel: 'codex',
    reviewBody,
    reviewPostedAt: '2026-05-02T18:04:00.000Z',
    critical: false,
  });

  // Legacy reply: no addressed[], no pushback[], legacy string-form
  // blockers. Coverage check is skipped because the reply does not opt
  // into the new schema. This is what previously-persisted reply
  // artifacts on disk look like.
  const legacyReply = {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome: 'completed',
    summary: 'Did the work.',
    validation: ['npm test'],
    blockers: [],
    reReview: { requested: true, reason: 'Ready.' },
  };

  assert.deepEqual(validateRemediationReply(legacyReply, { expectedJob: job }), legacyReply);
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

test('salvagePartialRemediationReply returns null when the file is not parseable JSON', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const replyPath = path.join(rootDir, 'reply.json');
  writeFileSync(replyPath, '{ not-json', 'utf8');
  assert.equal(salvagePartialRemediationReply(replyPath), null);
});

test('salvagePartialRemediationReply returns null when the JSON is not an object', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const replyPath = path.join(rootDir, 'reply.json');
  writeFileSync(replyPath, '"a string"', 'utf8');
  assert.equal(salvagePartialRemediationReply(replyPath), null);
  writeFileSync(replyPath, '[1,2,3]', 'utf8');
  assert.equal(salvagePartialRemediationReply(replyPath), null);
});

test('salvagePartialRemediationReply returns null when the JSON object has no renderable fields', () => {
  // Garbage object — no summary / addressed / pushback / blockers /
  // validation. Salvage path returns null so the renderer falls back
  // to the plain failure message.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const replyPath = path.join(rootDir, 'reply.json');
  writeFileSync(replyPath, JSON.stringify({ kind: 'something-else', random: 'noise' }), 'utf8');
  assert.equal(salvagePartialRemediationReply(replyPath), null);
});

test('salvagePartialRemediationReply extracts renderable fields from a malformed reply', () => {
  // The exact failure mode that landed PR #168 in failed/: the worker
  // produced a structurally valid JSON with addressed[] entries and a
  // summary, but reReview.reason was null while requested was true so
  // strict validation rejected it. The salvage path should still
  // return the renderable subset.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const replyPath = path.join(rootDir, 'reply.json');
  writeFileSync(replyPath, JSON.stringify({
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    jobId: 'lac__demo-pr-168-2026-05-04T03-05-43-585Z',
    repo: 'laceyenterprises/agent-os',
    prNumber: 168,
    outcome: 'completed',
    summary: 'Preserved opened_at; idempotent events; cascade verified.',
    validation: ['python3 platform/session-ledger/tests/test_turn_observability.py'],
    addressed: [
      {
        finding: 'turn_attempts upsert overwrites opened_at on partial updates.',
        action: 'Changed conflict update to preserve opened_at and other nullable fields.',
        files: ['platform/session-ledger/src/session_ledger/db.py'],
      },
    ],
    pushback: [],
    blockers: [],
    reReview: { requested: true, reason: null },
  }), 'utf8');

  const partial = salvagePartialRemediationReply(replyPath);
  assert.ok(partial, 'salvage must return a partial reply object');
  assert.equal(partial.summary, 'Preserved opened_at; idempotent events; cascade verified.');
  assert.deepEqual(partial.validation, ['python3 platform/session-ledger/tests/test_turn_observability.py']);
  assert.equal(partial.addressed.length, 1);
  assert.equal(partial.addressed[0].finding, 'turn_attempts upsert overwrites opened_at on partial updates.');
  // Empty arrays should be omitted (so the renderer doesn't print an
  // empty section header).
  assert.equal(partial.pushback, undefined);
  assert.equal(partial.blockers, undefined);
});

test('salvagePartialRemediationReply drops malformed entries inside arrays', () => {
  // Type-checks per entry: a wrong-shape addressed item must be
  // filtered out so the renderer never receives a half-formed object.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const replyPath = path.join(rootDir, 'reply.json');
  writeFileSync(replyPath, JSON.stringify({
    summary: 'mixed',
    addressed: [
      { finding: 'good', action: 'fixed it' },
      { finding: 'no action' }, // missing action
      'string-not-object', // not an object
      { finding: '', action: 'empty finding' }, // empty finding
    ],
    blockers: [
      'legacy-string-blocker',
      { finding: 'structured-blocker', reasoning: 'why' },
      { reasoning: 'no finding' }, // missing finding
    ],
  }), 'utf8');

  const partial = salvagePartialRemediationReply(replyPath);
  assert.ok(partial);
  assert.equal(partial.addressed.length, 1);
  assert.equal(partial.addressed[0].action, 'fixed it');
  assert.equal(partial.blockers.length, 2);
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
  createFollowUpJob({
    ...makeJobInput(rootDir),
    maxRemediationRounds: 2,
  });
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
  createFollowUpJob({
    ...makeJobInput(rootDir),
    maxRemediationRounds: 2,
  });
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
