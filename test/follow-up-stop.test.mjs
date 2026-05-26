import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  buildCancellationRefusalMessage,
  parseArgs,
  resolveFollowUpJobPath,
  shouldCancelSpawnedWorker,
  stopFollowUpJobWithWorkerCancel,
} from '../src/follow-up-stop.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeJobFile(relativeDir, name = 'job.json') {
  const dir = path.join(ROOT, relativeDir);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  writeFileSync(filePath, '{}\n', 'utf8');
  return filePath;
}

test('resolveFollowUpJobPath accepts stoppable follow-up job records under the repo root', (t) => {
  const createdPaths = [
    makeJobFile('data/follow-up-jobs/pending', 'resolve-pending.json'),
    makeJobFile('data/follow-up-jobs/in-progress', 'resolve-in-progress.json'),
    makeJobFile('data/follow-up-jobs/completed', 'resolve-completed.json'),
    makeJobFile('data/follow-up-jobs/failed', 'resolve-failed.json'),
  ];
  t.after(() => {
    createdPaths.forEach((filePath) => rmSync(filePath, { force: true }));
  });
  const pendingPath = resolveFollowUpJobPath(ROOT, 'data/follow-up-jobs/pending/resolve-pending.json');
  const inProgressPath = resolveFollowUpJobPath(ROOT, 'data/follow-up-jobs/in-progress/resolve-in-progress.json');
  const completedPath = resolveFollowUpJobPath(ROOT, 'data/follow-up-jobs/completed/resolve-completed.json');
  const failedPath = resolveFollowUpJobPath(ROOT, 'data/follow-up-jobs/failed/resolve-failed.json');

  assert.match(pendingPath, /data\/follow-up-jobs\/pending\/resolve-pending\.json$/);
  assert.match(inProgressPath, /data\/follow-up-jobs\/in-progress\/resolve-in-progress\.json$/);
  assert.match(completedPath, /data\/follow-up-jobs\/completed\/resolve-completed\.json$/);
  assert.match(failedPath, /data\/follow-up-jobs\/failed\/resolve-failed\.json$/);
});

test('resolveFollowUpJobPath rejects non-job or disallowed follow-up paths', () => {
  mkdirSync(path.join(ROOT, 'data', 'follow-up-jobs', 'pending'), { recursive: true });
  mkdirSync(path.join(ROOT, 'data', 'follow-up-jobs', 'in-progress'), { recursive: true });
  mkdirSync(path.join(ROOT, 'data', 'follow-up-jobs', 'completed'), { recursive: true });
  mkdirSync(path.join(ROOT, 'data', 'follow-up-jobs', 'failed'), { recursive: true });
  assert.throws(
    () => resolveFollowUpJobPath(ROOT, 'data/follow-up-jobs/stopped/job.json'),
    /Job path must point to a pending, in-progress, completed, or failed follow-up job JSON/
  );
  assert.throws(
    () => resolveFollowUpJobPath(ROOT, '../outside.json'),
    /Job path must point to a pending, in-progress, completed, or failed follow-up job JSON/
  );
});

test('resolveFollowUpJobPath rejects symlink escapes from allowed job directories', (t) => {
  const outsideDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-stop-'));
  const outsideFile = path.join(outsideDir, 'job.json');
  writeFileSync(outsideFile, '{}\n', 'utf8');
  const symlinkPath = path.join(ROOT, 'data', 'follow-up-jobs', 'pending', 'symlink-job.json');
  mkdirSync(path.dirname(symlinkPath), { recursive: true });
  symlinkSync(outsideFile, symlinkPath);
  t.after(() => {
    rmSync(symlinkPath, { force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  assert.throws(
    () => resolveFollowUpJobPath(ROOT, 'data/follow-up-jobs/pending/symlink-job.json'),
    /Job path must not be a symbolic link/
  );
});

test('parseArgs resolves the stop job path and default reason', (t) => {
  const jobPath = makeJobFile('data/follow-up-jobs/in-progress', 'parse-args.json');
  t.after(() => rmSync(jobPath, { force: true }));
  const parsed = parseArgs(['data/follow-up-jobs/in-progress/parse-args.json']);

  assert.match(parsed.jobPath, /data\/follow-up-jobs\/in-progress\/parse-args\.json$/);
  assert.equal(parsed.reason, 'Operator requested stop.');
  assert.equal(parsed.signal, 'SIGTERM');
  assert.equal(parsed.cancelWorker, true);
});

test('parseArgs supports signal override and explicit no-cancel escape hatch', (t) => {
  const jobPath = makeJobFile('data/follow-up-jobs/in-progress', 'parse-signal.json');
  t.after(() => rmSync(jobPath, { force: true }));
  const parsed = parseArgs([
    '--signal=SIGKILL',
    '--no-cancel-worker',
    'data/follow-up-jobs/in-progress/parse-signal.json',
    'manual takeover',
  ]);

  assert.match(parsed.jobPath, /data\/follow-up-jobs\/in-progress\/parse-signal\.json$/);
  assert.equal(parsed.reason, 'manual takeover');
  assert.equal(parsed.signal, 'SIGKILL');
  assert.equal(parsed.cancelWorker, false);
});

test('parseArgs rejects invalid signals before inspecting worker state', (t) => {
  const jobPath = makeJobFile('data/follow-up-jobs/in-progress', 'parse-invalid-signal.json');
  t.after(() => rmSync(jobPath, { force: true }));

  assert.throws(
    () => parseArgs([
      '--signal=garbage',
      '--no-cancel-worker',
      'data/follow-up-jobs/in-progress/parse-invalid-signal.json',
    ]),
    /Unsupported signal "garbage"/
  );
});

test('shouldCancelSpawnedWorker is limited to in-progress spawned remediation workers', () => {
  assert.equal(shouldCancelSpawnedWorker({
    status: 'in_progress',
    remediationWorker: { state: 'spawned' },
  }), true);
  assert.equal(shouldCancelSpawnedWorker({
    status: 'pending',
    remediationWorker: { state: 'spawned' },
  }), false);
  assert.equal(shouldCancelSpawnedWorker({
    status: 'in_progress',
    remediationWorker: { state: 'never-spawned' },
  }), false);
});

test('follow-up-stop CLI moves an in-progress job into stopped with operator reason', (t) => {
  const inProgressDir = path.join(ROOT, 'data', 'follow-up-jobs', 'in-progress');
  const stoppedDir = path.join(ROOT, 'data', 'follow-up-jobs', 'stopped');
  mkdirSync(inProgressDir, { recursive: true });
  mkdirSync(stoppedDir, { recursive: true });
  const jobPath = path.join(inProgressDir, 'cli-stop-job.json');
  const stoppedPath = path.join(stoppedDir, 'cli-stop-job.json');
  rmSync(jobPath, { force: true });
  rmSync(stoppedPath, { force: true });
  t.after(() => {
    rmSync(jobPath, { force: true });
    rmSync(stoppedPath, { force: true });
  });

  writeFileSync(jobPath, `${JSON.stringify({
    schemaVersion: 2,
    kind: 'adversarial-review-follow-up',
    status: 'in_progress',
    jobId: 'job-stop-cli',
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
      rounds: [{ round: 1, state: 'never-spawned' }],
      nextAction: { type: 'reconcile-worker', round: 1, operatorVisibility: 'explicit' },
    },
    remediationWorker: {
      state: 'never-spawned',
    },
  }, null, 2)}\n`, 'utf8');

  const stdout = execFileSync(
    process.execPath,
    [path.join(ROOT, 'src', 'follow-up-stop.mjs'), path.relative(ROOT, jobPath), 'Need manual operator handling.'],
    { cwd: ROOT, encoding: 'utf8' }
  );

  const stopped = JSON.parse(readFileSync(stoppedPath, 'utf8'));
  assert.match(stdout, /\[follow-up-stop\] job-stop-cli: stopped -> /);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.remediationPlan.stop.code, 'operator-stop');
  assert.equal(stopped.remediationPlan.stop.reason, 'Need manual operator handling.');
});

test('follow-up-stop CLI records cancellation receipt before stopping spawned jobs', (t) => {
  const inProgressDir = path.join(ROOT, 'data', 'follow-up-jobs', 'in-progress');
  const stoppedDir = path.join(ROOT, 'data', 'follow-up-jobs', 'stopped');
  mkdirSync(inProgressDir, { recursive: true });
  mkdirSync(stoppedDir, { recursive: true });
  const jobPath = path.join(inProgressDir, 'cli-cancel-before-stop.json');
  const stoppedPath = path.join(stoppedDir, 'cli-cancel-before-stop.json');
  rmSync(jobPath, { force: true });
  rmSync(stoppedPath, { force: true });
  let receiptPath = null;
  t.after(() => {
    rmSync(jobPath, { force: true });
    rmSync(stoppedPath, { force: true });
    if (receiptPath) rmSync(receiptPath, { force: true });
  });

  writeFileSync(jobPath, `${JSON.stringify({
    schemaVersion: 2,
    kind: 'adversarial-review-follow-up',
    status: 'in_progress',
    jobId: 'job-cli-cancel-before-stop',
    createdAt: '2026-04-21T08:00:00.000Z',
    repo: 'laceyenterprises/clio',
    prNumber: 7,
    reviewerModel: 'codex',
    critical: false,
    reviewSummary: 'Summary',
    reviewBody: 'Body',
    remediationWorker: {
      state: 'spawned',
      processId: 999999999,
      processGroupId: 999999999,
      spawnedAt: '2026-04-21T08:01:00.000Z',
    },
    remediationPlan: {
      mode: 'bounded-manual-rounds',
      maxRounds: 2,
      currentRound: 1,
      rounds: [{ round: 1, state: 'spawned' }],
      nextAction: { type: 'reconcile-worker', round: 1, operatorVisibility: 'explicit' },
    },
  }, null, 2)}\n`, 'utf8');

  const stdout = execFileSync(
    process.execPath,
    [path.join(ROOT, 'src', 'follow-up-stop.mjs'), path.relative(ROOT, jobPath), 'Need manual operator handling.'],
    { cwd: ROOT, encoding: 'utf8' }
  );
  receiptPath = stdout.match(/receipt=(\S+)/)?.[1] || null;

  assert.match(stdout, /workerSignalDelivered=false/);
  assert.ok(receiptPath);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.result.error, 'process-group-not-found');
  const stopped = JSON.parse(readFileSync(stoppedPath, 'utf8'));
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.remediationPlan.stop.reason, 'Need manual operator handling.');
});

test('buildCancellationRefusalMessage includes retry and override guidance', () => {
  const message = buildCancellationRefusalMessage(
    { jobId: 'job-cancel-failed' },
    {
      signalled: false,
      error: 'identity-unconfirmed',
      identity: {
        match: false,
        reason: 'ps probe failed: command timed out',
      },
    }
  );

  assert.match(message, /worker cancellation failed \(identity-unconfirmed\)/);
  assert.match(message, /retry the stop command/);
  assert.match(message, /--signal SIGKILL/);
  assert.match(message, /--no-cancel-worker/);
});

test('stopFollowUpJobWithWorkerCancel cancels spawned worker before stopping', async (t) => {
  const inProgressDir = path.join(ROOT, 'data', 'follow-up-jobs', 'in-progress');
  const stoppedDir = path.join(ROOT, 'data', 'follow-up-jobs', 'stopped');
  mkdirSync(inProgressDir, { recursive: true });
  mkdirSync(stoppedDir, { recursive: true });
  const jobPath = path.join(inProgressDir, 'cancel-before-stop.json');
  const stoppedPath = path.join(stoppedDir, 'cancel-before-stop.json');
  rmSync(jobPath, { force: true });
  rmSync(stoppedPath, { force: true });
  t.after(() => {
    rmSync(jobPath, { force: true });
    rmSync(stoppedPath, { force: true });
  });

  writeFileSync(jobPath, `${JSON.stringify({
    schemaVersion: 2,
    kind: 'adversarial-review-follow-up',
    status: 'in_progress',
    jobId: 'job-cancel-before-stop',
    createdAt: '2026-04-21T08:00:00.000Z',
    repo: 'laceyenterprises/clio',
    prNumber: 7,
    reviewerModel: 'codex',
    critical: false,
    reviewSummary: 'Summary',
    reviewBody: 'Body',
    remediationWorker: {
      state: 'spawned',
      processId: 1234,
      processGroupId: 1234,
      spawnedAt: '2026-04-21T08:01:00.000Z',
    },
    remediationPlan: {
      mode: 'bounded-manual-rounds',
      maxRounds: 2,
      currentRound: 1,
      rounds: [{ round: 1, state: 'spawned' }],
      nextAction: { type: 'reconcile-worker', round: 1, operatorVisibility: 'explicit' },
    },
  }, null, 2)}\n`, 'utf8');

  const calls = [];
  const result = await stopFollowUpJobWithWorkerCancel({
    rootDir: ROOT,
    jobPath,
    requestedAt: '2026-04-21T08:05:00.000Z',
    reason: 'manual rescue',
    signal: 'SIGTERM',
    cancelFollowUpWorkerImpl: async (args) => {
      calls.push(args);
      assert.equal(readFileSync(jobPath, 'utf8').includes('"status": "in_progress"'), true);
      return {
        signalled: true,
        receiptPath: path.join(ROOT, 'data', 'follow-up-jobs', 'worker-cancellations', 'receipt.json'),
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal, 'SIGTERM');
  assert.equal(calls[0].reason, 'Stopping follow-up job: manual rescue');
  assert.equal(result.job.status, 'stopped');
  assert.equal(result.cancellation.signalled, true);
  const stopped = JSON.parse(readFileSync(stoppedPath, 'utf8'));
  assert.equal(stopped.remediationPlan.stop.reason, 'manual rescue');
});

test('stopFollowUpJobWithWorkerCancel refuses to stop when live worker cancellation is not verified', async (t) => {
  const inProgressDir = path.join(ROOT, 'data', 'follow-up-jobs', 'in-progress');
  const stoppedDir = path.join(ROOT, 'data', 'follow-up-jobs', 'stopped');
  mkdirSync(inProgressDir, { recursive: true });
  mkdirSync(stoppedDir, { recursive: true });
  const jobPath = path.join(inProgressDir, 'cancel-failed.json');
  const stoppedPath = path.join(stoppedDir, 'cancel-failed.json');
  rmSync(jobPath, { force: true });
  rmSync(stoppedPath, { force: true });
  t.after(() => {
    rmSync(jobPath, { force: true });
    rmSync(stoppedPath, { force: true });
  });

  writeFileSync(jobPath, `${JSON.stringify({
    schemaVersion: 2,
    kind: 'adversarial-review-follow-up',
    status: 'in_progress',
    jobId: 'job-cancel-failed',
    createdAt: '2026-04-21T08:00:00.000Z',
    repo: 'laceyenterprises/clio',
    prNumber: 7,
    reviewerModel: 'codex',
    critical: false,
    reviewSummary: 'Summary',
    reviewBody: 'Body',
    remediationWorker: {
      state: 'spawned',
      processId: 1234,
      processGroupId: 1234,
      spawnedAt: '2026-04-21T08:01:00.000Z',
    },
    remediationPlan: {
      mode: 'bounded-manual-rounds',
      maxRounds: 2,
      currentRound: 1,
      rounds: [{ round: 1, state: 'spawned' }],
      nextAction: { type: 'reconcile-worker', round: 1, operatorVisibility: 'explicit' },
    },
  }, null, 2)}\n`, 'utf8');

  await assert.rejects(
    () => stopFollowUpJobWithWorkerCancel({
      rootDir: ROOT,
      jobPath,
      reason: 'manual rescue',
      cancelFollowUpWorkerImpl: async () => ({
        signalled: false,
        error: 'identity-unconfirmed',
      }),
    }),
    /Refusing to stop in-progress follow-up job job-cancel-failed: worker cancellation failed \(identity-unconfirmed\).*--no-cancel-worker/
  );

  assert.equal(JSON.parse(readFileSync(jobPath, 'utf8')).status, 'in_progress');
  assert.throws(() => readFileSync(stoppedPath, 'utf8'), /ENOENT/);
});
