import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createFollowUpJob,
  claimNextFollowUpJob,
  markFollowUpJobCompleted,
  markFollowUpJobFailed,
  markFollowUpJobStopped,
  readFollowUpJob,
} from '../src/follow-up-jobs.mjs';
import {
  beginIdempotentMutation,
  bumpRemediationBudget,
  currentMaxRounds,
  defaultIdempotencyKey,
  emitOperatorMutationAudit,
  ensureIdempotency,
  latestFollowUpJobForPr,
  recordIdempotentMutation,
  requestFingerprint,
} from '../src/operator-retrigger-helpers.mjs';

function seedJob(rootDir, status = 'completed') {
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    reviewerModel: 'claude',
    reviewBody: '## Summary\nSeed job.',
    maxRemediationRounds: 1,
  });
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-05-05T04:00:00.000Z' });
  if (status === 'completed') {
    return markFollowUpJobCompleted({
      rootDir,
      jobPath: claimed.jobPath,
      finishedAt: '2026-05-05T04:05:00.000Z',
      completionPreview: 'done',
      reReview: {
        requested: true,
        status: 'pending',
        reason: 'another pass',
        triggered: true,
        outcomeReason: null,
        reviewRow: null,
        requestedAt: '2026-05-05T04:05:00.000Z',
      },
    });
  }
  if (status === 'failed') {
    return markFollowUpJobFailed({
      rootDir,
      jobPath: claimed.jobPath,
      failedAt: '2026-05-05T04:05:00.000Z',
      errorMessage: 'boom',
    });
  }
  return markFollowUpJobStopped({
    rootDir,
    jobPath: claimed.jobPath,
    stoppedAt: '2026-05-05T04:05:00.000Z',
    stopCode: 'max-rounds-reached',
    sourceStatus: claimed.job.status,
    stopReason: 'cap',
  });
}

test('bumpRemediationBudget increments terminal jobs atomically', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-bump-'));
  const completed = seedJob(rootDir, 'completed');
  const result = bumpRemediationBudget({
    rootDir,
    repo: completed.job.repo,
    pr: completed.job.prNumber,
    bumpBy: 2,
  });
  assert.equal(result.bumped, true);
  assert.equal(result.priorMaxRounds, 1);
  assert.equal(result.newMaxRounds, 3);
  assert.equal(currentMaxRounds(readFollowUpJob(result.jobPath)), 3);
});

test('bumpRemediationBudget refuses in-progress jobs', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-bump-'));
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    reviewerModel: 'claude',
    reviewBody: '## Summary\nSeed job.',
  });
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-05-05T04:00:00.000Z' });
  const before = readFileSync(claimed.jobPath, 'utf8');
  const result = bumpRemediationBudget({
    rootDir,
    repo: claimed.job.repo,
    pr: claimed.job.prNumber,
  });
  assert.deepEqual(result, {
    bumped: false,
    reason: 'job-active',
    job: result.job,
    jobPath: claimed.jobPath,
  });
  assert.equal(readFileSync(claimed.jobPath, 'utf8'), before);
});

test('bumpRemediationBudget refuses pending jobs', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-bump-'));
  const created = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    reviewerModel: 'claude',
    reviewBody: '## Summary\nSeed job.',
  });
  const before = readFileSync(created.jobPath, 'utf8');
  const result = bumpRemediationBudget({
    rootDir,
    repo: created.job.repo,
    pr: created.job.prNumber,
  });
  assert.equal(result.bumped, false);
  assert.equal(result.reason, 'job-active');
  assert.equal(readFileSync(created.jobPath, 'utf8'), before);
});

test('bumpRemediationBudget reports no-job when no follow-up record exists', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-bump-'));
  assert.deepEqual(
    bumpRemediationBudget({ rootDir, repo: 'laceyenterprises/agent-os', pr: 238 }),
    { bumped: false, reason: 'no-job-found' }
  );
});

test('latestFollowUpJobForPr returns the newest terminal record for a PR', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-latest-'));
  seedJob(rootDir, 'failed');
  const stopped = seedJob(rootDir, 'stopped');
  const latest = latestFollowUpJobForPr(rootDir, { repo: stopped.job.repo, pr: stopped.job.prNumber });
  assert.equal(latest.job.jobId, stopped.job.jobId);
});

test('operator mutation idempotency replays the same audit row for the same key', () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'operator-idempotency-'));
  const ts = '2026-05-05T04:30:00.000Z';
  const idempotencyKey = defaultIdempotencyKey({
    verb: 'hq.adversarial.retrigger-remediation',
    repo: 'laceyenterprises/agent-os',
    pr: 238,
    reason: 'retry',
  });
  const fingerprint = requestFingerprint({
    verb: 'hq.adversarial.retrigger-remediation',
    repo: 'laceyenterprises/agent-os',
    pr: 238,
    reason: 'retry',
    bumpBudget: 1,
    bumpBudgetEnabled: true,
  });
  const auditRow = {
    ts,
    verb: 'hq.adversarial.retrigger-remediation',
    repo: 'laceyenterprises/agent-os',
    pr: 238,
    reason: 'retry',
    operator: 'paul@laceyenterprises.com',
    priorMaxRounds: 1,
    newMaxRounds: 2,
    jobKey: 'job-1',
    idempotencyKey,
    outcome: 'bumped',
  };
  beginIdempotentMutation(hqRoot, {
    ts,
    idempotencyKey,
    requestFingerprint: fingerprint,
  });
  emitOperatorMutationAudit(hqRoot, auditRow);
  recordIdempotentMutation(hqRoot, { ts, idempotencyKey, requestFingerprint: fingerprint, auditRow });
  assert.deepEqual(
    ensureIdempotency(hqRoot, { ts, idempotencyKey, requestFingerprint: fingerprint }),
    auditRow
  );
});

test('operator mutation idempotency refuses same key with different fingerprint', () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'operator-idempotency-'));
  const ts = '2026-05-05T04:30:00.000Z';
  const idempotencyKey = 'sha256:test';
  const auditRow = {
    ts,
    verb: 'hq.adversarial.retrigger-remediation',
    repo: 'laceyenterprises/agent-os',
    pr: 238,
    reason: 'retry',
    operator: 'paul@laceyenterprises.com',
    priorMaxRounds: 1,
    newMaxRounds: 2,
    jobKey: 'job-1',
    idempotencyKey,
    outcome: 'bumped',
  };
  beginIdempotentMutation(hqRoot, {
    ts,
    idempotencyKey,
    requestFingerprint: 'sha256:one',
  });
  recordIdempotentMutation(hqRoot, {
    ts,
    idempotencyKey,
    requestFingerprint: 'sha256:one',
    auditRow,
  });
  assert.throws(
    () => ensureIdempotency(hqRoot, {
      ts,
      idempotencyKey,
      requestFingerprint: 'sha256:two',
    }),
    /IDEMPOTENCY_KEY_MISMATCH/
  );
});

test('operator mutation idempotency blocks replay while a record is still in-flight', () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'operator-idempotency-'));
  beginIdempotentMutation(hqRoot, {
    ts: '2026-05-31T23:59:59.000Z',
    idempotencyKey: 'sha256:test',
    requestFingerprint: 'sha256:one',
  });
  assert.throws(
    () => ensureIdempotency(hqRoot, {
      ts: '2026-06-01T00:00:01.000Z',
      idempotencyKey: 'sha256:test',
      requestFingerprint: 'sha256:one',
    }),
    /IDEMPOTENCY_KEY_IN_FLIGHT/
  );
});
