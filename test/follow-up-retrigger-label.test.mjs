import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createFollowUpJob,
  readFollowUpJob,
  writeFollowUpJob,
} from '../src/follow-up-jobs.mjs';
import {
  RETRIGGER_REMEDIATION_LABEL,
  tryRetriggerRemediationFromLabel,
} from '../src/follow-up-retrigger-label.mjs';

function makeHaltedJob(rootDir, {
  status = 'stopped',
  stopCode = 'max-rounds-reached',
  reReviewRequested = false,
  maxRounds = 2,
  currentRound = 2,
  riskClass = 'medium',
} = {}) {
  const created = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    reviewerModel: 'claude',
    reviewBody: '## Summary\nsummary',
    reviewPostedAt: '2026-05-05T04:00:00.000Z',
    critical: false,
    maxRemediationRounds: maxRounds,
  });
  const job = {
    ...created.job,
    status,
    riskClass,
    remediationPlan: {
      ...created.job.remediationPlan,
      currentRound,
      maxRounds,
      stop: status === 'stopped' ? { code: stopCode } : null,
    },
    reReview: { requested: reReviewRequested },
  };
  writeFollowUpJob(created.jobPath, job);
  return { jobPath: created.jobPath, job };
}

function makeActiveJob(rootDir) {
  const created = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    reviewerModel: 'claude',
    reviewBody: '## Summary\nactive',
    reviewPostedAt: '2026-05-05T04:00:00.000Z',
    critical: false,
    maxRemediationRounds: 2,
  });
  // createFollowUpJob defaults to 'pending' status, which is "active".
  return { jobPath: created.jobPath, job: created.job };
}

function makeLabelEvent(overrides = {}) {
  return {
    id: 'evt-retrigger-1',
    nodeId: 'LE_retrigger_1',
    actor: 'VirtualPaul',
    createdAt: '2026-05-06T17:59:00.000Z',
    label: RETRIGGER_REMEDIATION_LABEL,
    ...overrides,
  };
}

test('tryRetriggerRemediationFromLabel bumps + requeues + removes label on halted-stopped:max-rounds-reached job', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const { jobPath } = makeHaltedJob(rootDir, { stopCode: 'max-rounds-reached' });

  const ghCalls = [];
  const auditRows = [];

  const result = await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    labelActor: 'VirtualPaul',
    labelEvent: makeLabelEvent(),
    execFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    appendAuditRow: (auditRoot, row) => {
      auditRows.push({ auditRoot, row });
    },
    now: () => '2026-05-06T18:00:00.000Z',
  });

  assert.equal(result.outcome, 'bumped-and-rearmed');
  assert.equal(result.labelRemoved, true);
  assert.equal(result.newMaxRounds, 3);

  // gh was called to post an ack comment, then remove the label.
  assert.equal(ghCalls.length, 2);
  assert.equal(ghCalls[0].cmd, 'gh');
  assert.deepEqual(ghCalls[0].args.slice(0, 6), [
    'pr',
    'comment',
    '238',
    '--repo',
    'laceyenterprises/agent-os',
    '--body',
  ]);
  assert.match(ghCalls[0].args[6], /Remediation retrigger accepted/);
  assert.match(ghCalls[0].args[6], /Remediation budget: `2 -> 3` rounds/);
  assert.equal(ghCalls[1].cmd, 'gh');
  assert.deepEqual(ghCalls[1].args, [
    'pr',
    'edit',
    '238',
    '--repo',
    'laceyenterprises/agent-os',
    '--remove-label',
    RETRIGGER_REMEDIATION_LABEL,
  ]);

  // Audit row recorded.
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].row.source, 'pr-label');
  assert.equal(auditRows[0].row.operator, 'pr-label:VirtualPaul');
  assert.equal(auditRows[0].row.outcome, 'bumped-and-rearmed');
  assert.equal(auditRows[0].row.rereviewOutcome, 'blocked');
  assert.equal(result.ackComment.posted, true);
  assert.equal(result.rereviewOutcome, 'blocked');

  // Job's persisted maxRounds was bumped.
  const updated = readFollowUpJob(jobPath);
  assert.equal(updated.remediationPlan.maxRounds, 3);
});

test('tryRetriggerRemediationFromLabel works on stopped:round-budget-exhausted', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  makeHaltedJob(rootDir, { stopCode: 'round-budget-exhausted' });

  const ghCalls = [];
  const result = await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    labelEvent: makeLabelEvent(),
    execFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    appendAuditRow: () => {},
  });

  assert.equal(result.outcome, 'bumped-and-rearmed');
  assert.equal(ghCalls.length, 2);
  assert.deepEqual(ghCalls.map((call) => call.args[1]), ['comment', 'edit']);
});

test('tryRetriggerRemediationFromLabel works on completed jobs that requested re-review', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  makeHaltedJob(rootDir, {
    status: 'completed',
    reReviewRequested: true,
    stopCode: null,
  });

  const ghCalls = [];
  const result = await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    labelEvent: makeLabelEvent(),
    execFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    appendAuditRow: () => {},
  });

  assert.equal(result.outcome, 'bumped-and-rearmed');
  assert.equal(ghCalls.length, 2);
  assert.deepEqual(ghCalls.map((call) => call.args[1]), ['comment', 'edit']);
});

test('tryRetriggerRemediationFromLabel works on failed jobs', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  makeHaltedJob(rootDir, { status: 'failed', stopCode: null });

  const ghCalls = [];
  const result = await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    labelEvent: makeLabelEvent(),
    execFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    appendAuditRow: () => {},
  });

  assert.equal(result.outcome, 'bumped-and-rearmed');
  assert.equal(ghCalls.length, 2);
  assert.deepEqual(ghCalls.map((call) => call.args[1]), ['comment', 'edit']);
});

test('tryRetriggerRemediationFromLabel leaves label in place when job is still active', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  makeActiveJob(rootDir);

  const ghCalls = [];
  const result = await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    labelEvent: makeLabelEvent(),
    execFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    appendAuditRow: () => {},
  });

  // No bump, no requeue, no label removal.
  assert.equal(result.outcome, 'job-active');
  assert.equal(ghCalls.length, 0);
});

test('tryRetriggerRemediationFromLabel returns no-job when there is no follow-up job for the PR', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));

  const ghCalls = [];
  const result = await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 999,
    labelEvent: makeLabelEvent(),
    execFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    appendAuditRow: () => {},
  });

  assert.equal(result.outcome, 'no-job');
  assert.equal(ghCalls.length, 0);
});

test('tryRetriggerRemediationFromLabel refuses unattributed labels', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  makeHaltedJob(rootDir);

  const result = await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    appendAuditRow: () => {},
  });

  assert.equal(result.outcome, 'label-event-missing');
});

test('tryRetriggerRemediationFromLabel surfaces label-removal failure but reports the requeue succeeded', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const { jobPath } = makeHaltedJob(rootDir);

  const result = await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    labelEvent: makeLabelEvent(),
    execFileImpl: async () => {
      throw new Error('gh: simulated network failure');
    },
    appendAuditRow: () => {},
  });

  // The bump+requeue landed; only label removal failed.
  assert.equal(result.outcome, 'bumped-label-removal-failed');
  assert.match(result.detail, /label removal failed/);

  const afterFirst = readFollowUpJob(jobPath);
  assert.equal(afterFirst.remediationPlan.maxRounds, 3);

  const haltedAgain = {
    ...afterFirst,
    status: 'stopped',
    remediationPlan: {
      ...afterFirst.remediationPlan,
      stop: { code: 'max-rounds-reached' },
    },
  };
  writeFollowUpJob(jobPath, haltedAgain);

  const retry = await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    labelEvent: makeLabelEvent(),
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    appendAuditRow: () => {},
  });

  assert.equal(retry.outcome, 'label-already-consumed');
  assert.equal(readFollowUpJob(jobPath).remediationPlan.maxRounds, 3);
});

test('tryRetriggerRemediationFromLabel keeps consumed label state retryable when terminal audit append fails', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const { jobPath } = makeHaltedJob(rootDir);

  const ghCalls = [];
  const first = await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    labelEvent: makeLabelEvent({ id: 'evt-audit-failure' }),
    execFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    appendAuditRow: () => {
      throw new Error('disk full');
    },
  });

  assert.equal(first.outcome, 'bumped-audit-failed');
  assert.equal(ghCalls.length, 0, 'label stays until the terminal audit row is durable');
  assert.equal(readFollowUpJob(jobPath).remediationPlan.maxRounds, 3);

  const retry = await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    labelEvent: makeLabelEvent({ id: 'evt-audit-failure' }),
    execFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    appendAuditRow: () => {},
  });

  assert.equal(retry.outcome, 'label-already-consumed');
  assert.equal(ghCalls.length, 1);
  assert.equal(readFollowUpJob(jobPath).remediationPlan.maxRounds, 3);
});

test('tryRetriggerRemediationFromLabel is idempotent across re-applications', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  makeHaltedJob(rootDir);

  const ghCalls = [];
  const args = {
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    labelEvent: makeLabelEvent(),
    execFileImpl: async (cmd, callArgs) => {
      ghCalls.push({ cmd, callArgs });
      return { stdout: '', stderr: '' };
    },
    appendAuditRow: () => {},
    now: () => '2026-05-06T18:00:00.000Z',
  };

  const first = await tryRetriggerRemediationFromLabel(args);
  assert.equal(first.outcome, 'bumped-and-rearmed');

  // Second call with the same `now` produces the same idempotency key.
  // bumpRemediationBudget detects the existing audit entry and returns
  // an idempotent result; we should not double-bump.
  const second = await tryRetriggerRemediationFromLabel(args);
  assert.notEqual(second.outcome, 'bumped-and-rearmed', 'second call must not double-bump');
});
