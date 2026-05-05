import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  claimNextFollowUpJob,
  createFollowUpJob,
  markFollowUpJobCompleted,
  markFollowUpJobStopped,
  readFollowUpJob,
} from '../src/follow-up-jobs.mjs';
import { main } from '../src/retrigger-remediation.mjs';

function makeTerminalJob(rootDir, status = 'completed', reReviewRequested = true) {
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
        requested: reReviewRequested,
        status: reReviewRequested ? 'pending' : 'not-requested',
        reason: reReviewRequested ? 'another pass' : null,
        triggered: reReviewRequested,
        outcomeReason: reReviewRequested ? null : 'reply-did-not-request-rereview',
        reviewRow: null,
        requestedAt: reReviewRequested ? '2026-05-05T04:05:00.000Z' : null,
      },
    });
  }
  return markFollowUpJobStopped({
    rootDir,
    jobPath: claimed.jobPath,
    stoppedAt: '2026-05-05T04:05:00.000Z',
    stopCode: 'max-rounds-reached',
    sourceStatus: 'in_progress',
    stopReason: 'cap',
  });
}

function capture() {
  const chunks = [];
  return {
    write(chunk) { chunks.push(String(chunk)); return true; },
    text() { return chunks.join(''); },
  };
}

test('retrigger-remediation bumps a terminal job, requeues it, and appends audit output', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-remediation-'));
  const auditRoot = mkdtempSync(path.join(tmpdir(), 'operator-audit-root-'));
  const completed = makeTerminalJob(rootDir, 'completed', true);
  const out = capture();
  const rc = main([
    '--repo', completed.job.repo,
    '--pr', String(completed.job.prNumber),
    '--reason', 'operator approved one more pass',
    '--root-dir', rootDir,
    '--audit-root-dir', auditRoot,
    '--operator', 'paul@laceyenterprises.com',
  ], { stdout: out, stderr: capture() });

  assert.equal(rc, 0);
  assert.match(out.text(), /requeued/);
  const pending = readFollowUpJob(path.join(rootDir, 'data', 'follow-up-jobs', 'pending', `${completed.job.jobId}.json`));
  assert.equal(pending.status, 'pending');
  assert.equal(pending.remediationPlan.maxRounds, 2);
  assert.equal(pending.operatorRetriggerAudit.at(-1).outcome, 'requeued');
  const auditText = readFileSync(path.join(auditRoot, 'data', 'operator-mutations', 'audit', '2026-05', `${encodeURIComponent(pending.operatorRetriggerAudit.at(-1).idempotencyKey).replace(/%/g, '_')}.json`), 'utf8');
  assert.match(auditText, /hq\.adversarial\.retrigger-remediation/);
});

test('retrigger-remediation refuses when no follow-up job exists', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-remediation-'));
  const err = capture();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--root-dir', rootDir,
  ], { stdout: capture(), stderr: err });

  assert.equal(rc, 1);
  assert.match(err.text(), /no-job/);
});

test('retrigger-remediation refuses completed jobs without a durable rereview request', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-remediation-'));
  const completed = makeTerminalJob(rootDir, 'completed', false);
  const err = capture();
  const rc = main([
    '--repo', completed.job.repo,
    '--pr', String(completed.job.prNumber),
    '--reason', 'retry',
    '--root-dir', rootDir,
  ], { stdout: capture(), stderr: err });

  assert.equal(rc, 1);
  assert.match(err.text(), /completed-no-rereview/);
});

test('retrigger-remediation replays a committed idempotency key as a no-op success', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-remediation-'));
  const completed = makeTerminalJob(rootDir, 'completed', true);
  const idempotencyKey = 'sha256:replay-test';

  const firstRc = main([
    '--repo', completed.job.repo,
    '--pr', String(completed.job.prNumber),
    '--reason', 'operator approved one more pass',
    '--root-dir', rootDir,
    '--idempotency-key', idempotencyKey,
  ], { stdout: capture(), stderr: capture() });
  assert.equal(firstRc, 0);

  const out = capture();
  const rc = main([
    '--repo', completed.job.repo,
    '--pr', String(completed.job.prNumber),
    '--reason', 'operator approved one more pass',
    '--root-dir', rootDir,
    '--idempotency-key', idempotencyKey,
  ], { stdout: out, stderr: capture() });

  assert.equal(rc, 0);
  assert.match(out.text(), /replayed/);
  const pending = readFollowUpJob(path.join(rootDir, 'data', 'follow-up-jobs', 'pending', `${completed.job.jobId}.json`));
  assert.equal(pending.remediationPlan.maxRounds, 2);
});
