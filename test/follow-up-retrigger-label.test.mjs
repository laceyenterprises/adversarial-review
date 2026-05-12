import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  claimNextFollowUpJob,
  createFollowUpJob,
  readFollowUpJob,
  writeFollowUpJob,
} from '../src/follow-up-jobs.mjs';
import {
  RETRIGGER_REMEDIATION_LABEL,
  retryPendingRetriggerAckComments,
  tryRetriggerRemediationFromLabel,
} from '../src/follow-up-retrigger-label.mjs';

const COMMENT_ONLY_REVIEW_BODY = '## Summary\nsummary\n\n## Verdict\nComment only';

function makeHaltedJob(rootDir, {
  status = 'stopped',
  stopCode = 'max-rounds-reached',
  reReviewRequested = false,
  maxRounds = 2,
  currentRound = 2,
  riskClass = 'medium',
  reviewBody = '## Summary\nsummary',
} = {}) {
  const created = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    reviewerModel: 'claude',
    reviewBody,
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
    headSha: 'sha-retrigger',
    ...overrides,
  };
}

function readOnlyLabelConsumption(rootDir) {
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', 'label-consumptions');
  const names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.equal(names.length, 1);
  return JSON.parse(readFileSync(path.join(dir, names[0]), 'utf8'));
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
    revisionRef: 'sha-retrigger',
    execFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    appendAuditRow: (auditRoot, row) => {
      auditRows.push({ auditRoot, row });
    },
    now: () => '2026-05-06T18:00:00.000Z',
  });

  assert.equal(result.outcome, 'bumped-and-requeued');
  assert.equal(result.labelRemoved, true);
  assert.equal(result.newMaxRounds, 3);

  // gh removes the label first, then checks for and posts the ack comment.
  assert.equal(ghCalls.length, 3);
  assert.equal(ghCalls[0].cmd, 'gh');
  assert.deepEqual(ghCalls[0].args, [
    'pr',
    'edit',
    '238',
    '--repo',
    'laceyenterprises/agent-os',
    '--remove-label',
    RETRIGGER_REMEDIATION_LABEL,
  ]);
  assert.equal(ghCalls[1].cmd, 'gh');
  assert.deepEqual(ghCalls[1].args.slice(0, 3), [
    'api',
    '--paginate',
    'repos/laceyenterprises/agent-os/issues/238/comments',
  ]);
  assert.equal(ghCalls[2].cmd, 'gh');
  assert.deepEqual(ghCalls[2].args.slice(0, 6), [
    'pr',
    'comment',
    '238',
    '--repo',
    'laceyenterprises/agent-os',
    '--body',
  ]);
  assert.match(ghCalls[2].args[6], /Remediation retrigger accepted/);
  assert.match(ghCalls[2].args[6], /Remediation budget: `2 -> 3` rounds/);
  assert.match(ghCalls[2].args[6], /Remediation queue: `requeued`/);
  assert.match(ghCalls[2].args[6], /remediation worker will respond to the latest adversarial review/i);

  // Audit rows record the durable bump first, then the terminal requeue outcome.
  assert.equal(auditRows.length, 2);
  assert.equal(auditRows[0].row.source, 'pr-label');
  assert.equal(auditRows[0].row.operator, 'pr-label:VirtualPaul');
  assert.equal(auditRows[0].row.outcome, 'bumped-requeue-pending');
  assert.equal(auditRows[0].row.requeueOutcome, 'not-attempted');
  assert.equal(auditRows[1].row.source, 'pr-label');
  assert.equal(auditRows[1].row.operator, 'pr-label:VirtualPaul');
  assert.equal(auditRows[1].row.outcome, 'bumped-and-requeued');
  assert.equal(auditRows[1].row.requeueOutcome, 'requeued');
  assert.equal(result.ackComment.posted, true);
  assert.equal(result.requeueOutcome, 'requeued');

  // Job's persisted maxRounds was bumped.
  const updated = readFollowUpJob(result.jobPath);
  assert.equal(updated.remediationPlan.maxRounds, 3);
  assert.equal(updated.status, 'pending');
  assert.equal(updated.remediationPlan.nextAction.operatorOverride, true);
});

test('tryRetriggerRemediationFromLabel requeues stopped:review-settled jobs for explicit operator flags', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  makeHaltedJob(rootDir, {
    stopCode: 'review-settled',
    currentRound: 1,
    maxRounds: 2,
    reviewBody: COMMENT_ONLY_REVIEW_BODY,
  });

  const ghCalls = [];
  const result = await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    labelActor: 'VirtualPaul',
    labelEvent: makeLabelEvent({ id: 'evt-review-settled' }),
    revisionRef: 'sha-retrigger',
    execFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    appendAuditRow: () => {},
    now: () => '2026-05-06T18:00:00.000Z',
  });

  assert.equal(result.outcome, 'bumped-and-requeued');
  assert.equal(result.labelRemoved, true);
  assert.equal(result.requeueOutcome, 'requeued');
  assert.deepEqual(ghCalls.map((call) => call.args[1]), ['edit', '--paginate', 'comment']);
  assert.equal(readFollowUpJob(result.jobPath).remediationPlan.nextAction.operatorOverride, true);

  const claimed = claimNextFollowUpJob({
    rootDir,
    workerType: 'codex-remediation',
    claimedAt: '2026-05-06T18:00:01.000Z',
  });
  assert.equal(claimed.job.status, 'in_progress');
  assert.equal(claimed.job.remediationPlan.currentRound, 2);
  assert.deepEqual(claimed.job.remediationPlan.nextAction, {
    type: 'worker-spawn',
    round: 2,
    operatorVisibility: 'explicit',
  });
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
    revisionRef: 'sha-retrigger',
    execFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    appendAuditRow: () => {},
  });

  assert.equal(result.outcome, 'bumped-and-requeued');
  assert.equal(ghCalls.length, 3);
  assert.deepEqual(ghCalls.map((call) => call.args[1]), ['edit', '--paginate', 'comment']);
});

test('tryRetriggerRemediationFromLabel requeues stopped:daemon-bounce-safety for the next claim', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  makeHaltedJob(rootDir, {
    stopCode: 'daemon-bounce-safety',
    currentRound: 1,
    maxRounds: 2,
  });

  const result = await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    labelEvent: makeLabelEvent({ id: 'evt-stopped-terminal' }),
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    appendAuditRow: () => {},
    now: () => '2026-05-09T18:00:00.000Z',
  });

  assert.equal(result.outcome, 'bumped-and-requeued');
  const requeued = readFollowUpJob(result.jobPath);
  assert.equal(requeued.status, 'pending');

  const claimed = claimNextFollowUpJob({
    rootDir,
    workerType: 'codex-remediation',
    claimedAt: '2026-05-09T18:00:01.000Z',
  });
  assert.equal(claimed.job.status, 'in_progress');
  assert.match(claimed.jobPath, /data\/follow-up-jobs\/in-progress\/.+\.json$/);
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
    revisionRef: 'sha-retrigger',
    execFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    appendAuditRow: () => {},
  });

  assert.equal(result.outcome, 'bumped-and-requeued');
  assert.equal(ghCalls.length, 3);
  assert.deepEqual(ghCalls.map((call) => call.args[1]), ['edit', '--paginate', 'comment']);
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
    revisionRef: 'sha-retrigger',
    execFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    appendAuditRow: () => {},
  });

  assert.equal(result.outcome, 'bumped-and-requeued');
  assert.equal(ghCalls.length, 3);
  assert.deepEqual(ghCalls.map((call) => call.args[1]), ['edit', '--paginate', 'comment']);
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

test('tryRetriggerRemediationFromLabel leaves label in place for non-retriggerable stopped jobs', async () => {
  for (const stopCode of ['operator-stop', 'rereview-blocked']) {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
    makeHaltedJob(rootDir, {
      stopCode,
      currentRound: 0,
      maxRounds: 2,
    });

    const ghCalls = [];
    const result = await tryRetriggerRemediationFromLabel({
      rootDir,
      repo: 'laceyenterprises/agent-os',
      prNumber: 238,
      labelEvent: makeLabelEvent({ id: `evt-${stopCode}` }),
      execFileImpl: async (cmd, args) => {
        ghCalls.push({ cmd, args });
        return { stdout: '', stderr: '' };
      },
      appendAuditRow: () => {},
    });

    assert.equal(result.outcome, 'job-active');
    assert.equal(ghCalls.length, 0);
  }
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

test('tryRetriggerRemediationFromLabel refuses missing revisionRef before consuming label', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  makeHaltedJob(rootDir);

  const ghCalls = [];
  const result = await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    labelEvent: makeLabelEvent({ id: 'evt-missing-revision', headSha: null }),
    execFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    appendAuditRow: () => {},
  });

  assert.equal(result.outcome, 'missing-revision-ref');
  assert.equal(result.ackComment.reason, 'missing-revision-ref');
  assert.equal(ghCalls.length, 0);
});

test('tryRetriggerRemediationFromLabel consumes label and audits bump when requeue fails', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const { jobPath } = makeHaltedJob(rootDir);

  const ghCalls = [];
  const auditRows = [];
  const result = await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    labelEvent: makeLabelEvent({ id: 'evt-requeue-failure' }),
    revisionRef: 'sha-retrigger',
    execFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    appendAuditRow: (auditRoot, row) => {
      auditRows.push({ auditRoot, row });
    },
    requeueImpl: () => {
      throw new Error('simulated queue write failure');
    },
    now: () => '2026-05-06T18:00:00.000Z',
  });

  assert.equal(result.outcome, 'bumped-requeue-failed');
  assert.equal(result.labelRemoved, true);
  assert.equal(result.requeueOutcome, 'requeue-failed');
  assert.equal(readFollowUpJob(jobPath).remediationPlan.maxRounds, 3);

  assert.equal(auditRows.length, 2);
  assert.equal(auditRows[0].row.outcome, 'bumped-requeue-pending');
  assert.equal(auditRows[1].row.outcome, 'bumped-requeue-failed');
  assert.match(auditRows[1].row.requeueError, /simulated queue write failure/);

  assert.equal(ghCalls.length, 3);
  assert.deepEqual(ghCalls.map((call) => call.args[1]), ['edit', '--paginate', 'comment']);
  assert.match(ghCalls[2].args[6], /Remediation retrigger needs operator attention/);
  assert.match(ghCalls[2].args[6], /could not requeue the follow-up worker/);

  const consumption = readOnlyLabelConsumption(rootDir);
  assert.equal(consumption.labelRemoved, true);
  assert.equal(consumption.auditRow.outcome, 'bumped-requeue-failed');
  assert.equal(consumption.ackComment.context.requeueResult.outcome, 'requeue-failed');

  const retry = await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    labelEvent: makeLabelEvent({ id: 'evt-requeue-failure' }),
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    appendAuditRow: () => {},
  });

  assert.equal(retry.outcome, 'label-already-consumed');
  assert.equal(readFollowUpJob(jobPath).remediationPlan.maxRounds, 3);
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

  const afterFirst = readFollowUpJob(result.jobPath);
  assert.equal(afterFirst.remediationPlan.maxRounds, 3);
  assert.equal(afterFirst.status, 'pending');

  const haltedAgain = {
    ...afterFirst,
    status: 'stopped',
    remediationPlan: {
      ...afterFirst.remediationPlan,
      stop: { code: 'max-rounds-reached' },
    },
  };
  writeFollowUpJob(result.jobPath, haltedAgain);

  const retry = await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    labelEvent: makeLabelEvent(),
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    appendAuditRow: () => {},
  });

  assert.equal(retry.outcome, 'label-already-consumed');
  assert.equal(readFollowUpJob(result.jobPath).remediationPlan.maxRounds, 3);
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
    revisionRef: 'sha-retrigger',
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
  assert.equal(ghCalls.length, 3);
  assert.deepEqual(ghCalls.map((call) => call.args[1]), ['edit', '--paginate', 'comment']);
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
  assert.equal(first.outcome, 'bumped-and-requeued');

  // Second call with the same `now` produces the same idempotency key.
  // bumpRemediationBudget detects the existing audit entry and returns
  // an idempotent result; we should not double-bump.
  const second = await tryRetriggerRemediationFromLabel(args);
  assert.notEqual(second.outcome, 'bumped-and-requeued', 'second call must not double-bump');
});

test('tryRetriggerRemediationFromLabel dedupes ack comments by marker before posting', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  makeHaltedJob(rootDir);

  const ghCalls = [];
  const result = await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    labelEvent: makeLabelEvent({ id: 'evt-deduped-ack' }),
    execFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      if (args[0] === 'gh') throw new Error('bad test seam');
      if (args[0] === 'api') {
        const consumption = readOnlyLabelConsumption(rootDir);
        return {
          stdout: `${JSON.stringify({
            id: 12345,
            body: `<!-- ${consumption.ackComment.marker} -->\nprevious ack`,
          })}\n`,
          stderr: '',
        };
      }
      assert.notEqual(args[1], 'comment', 'existing marker must skip gh pr comment');
      return { stdout: '', stderr: '' };
    },
    appendAuditRow: () => {},
  });

  assert.equal(result.outcome, 'bumped-and-requeued');
  assert.equal(result.ackComment.posted, true);
  assert.equal(result.ackComment.deduped, true);
  assert.equal(result.ackComment.commentId, 12345);
  assert.deepEqual(ghCalls.map((call) => call.args[1]), ['edit', '--paginate']);
});

test('retryPendingRetriggerAckComments retries pending ack records after label removal', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  makeHaltedJob(rootDir);

  await tryRetriggerRemediationFromLabel({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    labelEvent: makeLabelEvent({
      id: 'evt-pending-ack',
      actor: 'Bad`Actor',
    }),
    revisionRef: 'sha-retrigger',
    reason: 'operator note\n# hidden\n</details>',
    execFileImpl: async (_cmd, args) => {
      if (args[1] === 'comment') throw new Error('simulated comment outage');
      return { stdout: '', stderr: '' };
    },
    appendAuditRow: () => {},
  });

  const pending = readOnlyLabelConsumption(rootDir);
  assert.equal(pending.labelRemoved, true);
  assert.equal(pending.ackComment.posted, false);
  assert.equal(pending.ackComment.context.requeueResult.outcome, 'requeued');

  const bodies = [];
  const retry = await retryPendingRetriggerAckComments({
    rootDir,
    execFileImpl: async (_cmd, args) => {
      if (args[0] === 'api') return { stdout: '', stderr: '' };
      if (args[1] === 'comment') bodies.push(args[6]);
      return { stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(retry, { attempted: 1, posted: 1 });
  assert.equal(bodies.length, 1);
  assert.doesNotMatch(bodies[0], /<\/details>/);
  assert.doesNotMatch(bodies[0], /\n# hidden/);
  assert.match(bodies[0], /Requested by: `Bad'Actor`/);
  assert.match(bodies[0], /Remediation queue: `requeued`/);

  const afterRetry = readOnlyLabelConsumption(rootDir);
  assert.equal(afterRetry.ackComment.posted, true);
});
