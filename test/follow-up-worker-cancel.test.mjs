import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cancelFollowUpWorker,
  parseArgs,
  resolveFollowUpJobPath,
  sendWorkerSignal,
  workerCancelHandle,
} from '../src/follow-up-worker-cancel.mjs';

function makeInProgressJob(rootDir, overrides = {}) {
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', 'in-progress');
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(rootDir, 'data', 'follow-up-jobs', 'worker-cancellations'), { recursive: true });
  const job = {
    schemaVersion: 1,
    kind: 'adversarial-review-follow-up',
    status: 'in_progress',
    jobId: 'laceyenterprises__adversarial-review-pr-149-2026-05-24T14-50-37-236Z',
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 149,
    remediationWorker: {
      model: 'codex',
      state: 'spawned',
      processId: 1234,
      processGroupId: 1234,
      spawnedAt: '2026-05-24T14:55:00.000Z',
      workspaceDir: '/tmp/workspace',
      outputPath: '/tmp/workspace/.adversarial-follow-up/codex-last-message.md',
      logPath: '/tmp/workspace/.adversarial-follow-up/codex-worker.log',
    },
    ...overrides,
  };
  const jobPath = path.join(dir, `${job.jobId}.json`);
  writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
  return { job, jobPath };
}

test('cancelFollowUpWorker signals the persisted process group and leaves job state untouched', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const { jobPath } = makeInProgressJob(rootDir);
  const before = readFileSync(jobPath, 'utf8');
  const signals = [];

  const result = await cancelFollowUpWorker({
    rootDir,
    jobPath,
    requestedAt: '2026-05-24T15:00:00.000Z',
    requestedBy: 'placey',
    reason: 'duplicate worker',
    execFileImpl: async () => ({ stdout: `${new Date('2026-05-24T14:55:00.000Z').toString()}\n` }),
    processKill: (pid, signal) => {
      signals.push({ pid, signal });
      return true;
    },
  });

  assert.equal(result.signalled, true);
  assert.deepEqual(result.target, { kind: 'process-group', id: 1234 });
  assert.deepEqual(signals, [
    { pid: -1234, signal: 0 },
    { pid: -1234, signal: 'SIGTERM' },
  ]);
  assert.equal(readFileSync(jobPath, 'utf8'), before);
  assert.ok(result.receiptPath.includes('/data/follow-up-jobs/worker-cancellations/'));
  assert.ok(existsSync(result.receiptPath));
  const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
  assert.equal(receipt.kind, 'adversarial-review-follow-up-worker-cancellation');
  assert.equal(receipt.job.status, 'in_progress');
  assert.equal(receipt.reason, 'duplicate worker');
});

test('sendWorkerSignal refuses recycled process groups when identity is unconfirmed', async () => {
  const calls = [];
  const result = await sendWorkerSignal({
    processGroupId: 4321,
    processId: 9876,
    spawnedAt: '2026-05-24T15:00:00.000Z',
    signal: 'SIGKILL',
    processKill: (pid, signal) => {
      calls.push({ pid, signal });
      return true;
    },
    execFileImpl: async () => ({ stdout: 'Sat May 24 15:10:00 2026\n' }),
  });

  assert.equal(result.signalled, false);
  assert.deepEqual(result.target, { kind: 'process-group', id: 4321 });
  assert.equal(result.error, 'identity-unconfirmed');
  assert.deepEqual(calls, [{ pid: -4321, signal: 0 }]);
});

test('workerCancelHandle accepts legacy jobs without explicit processGroupId', () => {
  const handle = workerCancelHandle({
    remediationWorker: {
      processId: 2468,
      state: 'spawned',
    },
  });

  assert.equal(handle.processGroupId, 2468);
  assert.equal(handle.processId, 2468);
});

test('parseArgs supports signal flags and reason text', () => {
  assert.deepEqual(parseArgs([
    '--signal=SIGKILL',
    'data/follow-up-jobs/in-progress/job.json',
    'duplicate',
    'worker',
  ]), {
    jobPathArg: 'data/follow-up-jobs/in-progress/job.json',
    signal: 'SIGKILL',
    reason: 'duplicate worker',
  });
});

test('resolveFollowUpJobPath refuses terminal job directories', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  mkdirSync(path.join(rootDir, 'data', 'follow-up-jobs', 'in-progress'), { recursive: true });
  const stoppedDir = path.join(rootDir, 'data', 'follow-up-jobs', 'stopped');
  mkdirSync(stoppedDir, { recursive: true });
  const stoppedPath = path.join(stoppedDir, 'job.json');
  writeFileSync(stoppedPath, '{}\n', 'utf8');

  assert.throws(
    () => resolveFollowUpJobPath(rootDir, stoppedPath),
    /in-progress follow-up job JSON/
  );
});
