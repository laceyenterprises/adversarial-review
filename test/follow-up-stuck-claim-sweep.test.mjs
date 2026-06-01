// LAC-957 / ARP-FUS-01 — stuck-claim sweep + pre-spawn lifecycle recheck.
//
// Tonight (2026-06-01 ~05:02Z) an orphaned in-progress claim blocked
// the follow-up daemon's queue for 35 min because the remediator
// died without releasing its claim. These tests pin the sweep +
// precheck behavior that prevents a repeat.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildFollowUpJob,
  getFollowUpJobDir,
  markFollowUpJobStopped,
  writeFollowUpJob,
} from '../src/follow-up-jobs.mjs';
import {
  DEFAULT_IN_PROGRESS_STUCK_THRESHOLD_MS,
  IN_PROGRESS_STUCK_THRESHOLD_MS_ENV,
  STALE_HEARTBEAT_STOP_CODE,
  applyPreSpawnLifecycleGate,
  emitHeartbeatsForActiveJobs,
  resolveInProgressStuckThresholdMs,
  sweepStuckInProgressClaims,
} from '../src/follow-up-stuck-claim-sweep.mjs';

function makeRoot() {
  return mkdtempSync(path.join(tmpdir(), 'adversarial-review-stuck-sweep-'));
}

function seedInProgressJob(rootDir, {
  jobId = 'laceyenterprises__agent-os-pr-1226-2026-06-01T05-02-00-000Z',
  repo = 'laceyenterprises/agent-os',
  prNumber = 1226,
  lastHeartbeatAt,
  claimedAt,
  spawnedAt,
  mtimeIso,
} = {}) {
  const inProgressDir = getFollowUpJobDir(rootDir, 'inProgress');
  mkdirSync(inProgressDir, { recursive: true });
  const jobPath = path.join(inProgressDir, `${jobId}.json`);
  const baseJob = buildFollowUpJob({
    repo,
    prNumber,
    reviewerModel: 'codex',
    reviewBody: '## Summary\nLAC-957 fixture',
    reviewPostedAt: '2026-06-01T05:01:00.000Z',
    critical: false,
  });
  const job = {
    ...baseJob,
    jobId,
    status: 'in_progress',
    claimedAt: claimedAt ?? '2026-06-01T05:01:30.000Z',
    claimedBy: { workerType: 'codex-remediation', launcherPid: 12345 },
    remediationWorker: {
      model: 'codex',
      state: 'spawned',
      spawnedAt: spawnedAt ?? '2026-06-01T05:01:31.000Z',
      processId: 99999,
    },
  };
  if (lastHeartbeatAt !== undefined) {
    job.lastHeartbeatAt = lastHeartbeatAt;
  }
  writeFollowUpJob(jobPath, job);
  if (mtimeIso) {
    const mtime = new Date(mtimeIso);
    utimesSync(jobPath, mtime, mtime);
  }
  return { job, jobPath };
}

function readJobAtPath(jobPath) {
  return JSON.parse(readFileSync(jobPath, 'utf8'));
}

test('sweepStuckInProgressClaims: stale lastHeartbeatAt moves claim to stopped/', () => {
  const rootDir = makeRoot();
  const { jobPath } = seedInProgressJob(rootDir, {
    lastHeartbeatAt: '2026-06-01T05:00:00.000Z',
  });
  const nowMs = Date.parse('2026-06-01T05:35:00.000Z');
  const logs = [];
  const result = sweepStuckInProgressClaims({
    rootDir,
    nowMs,
    log: { log: (msg) => logs.push(msg) },
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.reclaimed, 1);
  assert.equal(result.skipped, 0);
  assert.equal(existsSync(jobPath), false, 'in-progress file removed');
  const stoppedPath = path.join(getFollowUpJobDir(rootDir, 'stopped'), path.basename(jobPath));
  assert.equal(existsSync(stoppedPath), true, 'file moved to stopped/');
  const stoppedJob = readJobAtPath(stoppedPath);
  assert.equal(stoppedJob.status, 'stopped');
  assert.equal(stoppedJob.remediationPlan?.stop?.code, STALE_HEARTBEAT_STOP_CODE);
  assert.equal(stoppedJob.remediationWorker?.state, 'reclaimed-stale-heartbeat');
  assert.equal(stoppedJob.remediationWorker?.reclaimReason, STALE_HEARTBEAT_STOP_CODE);
  assert.equal(stoppedJob.remediationWorker?.reclaimSource, 'lastHeartbeatAt');
  assert.equal(typeof stoppedJob.remediationWorker?.reclaimedAt, 'string');
  assert.equal(typeof stoppedJob.remediationWorker?.reclaimAgeMs, 'number');
  assert.ok(stoppedJob.remediationWorker.reclaimAgeMs >= 35 * 60 * 1000);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /stale-claim-reclaimed/);
  assert.match(logs[0], /source=lastHeartbeatAt/);
});

test('sweepStuckInProgressClaims: fresh lastHeartbeatAt leaves claim in place', () => {
  const rootDir = makeRoot();
  const { jobPath } = seedInProgressJob(rootDir, {
    lastHeartbeatAt: '2026-06-01T05:34:00.000Z',
  });
  const nowMs = Date.parse('2026-06-01T05:35:00.000Z');
  const result = sweepStuckInProgressClaims({ rootDir, nowMs });

  assert.equal(result.scanned, 1);
  assert.equal(result.reclaimed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(existsSync(jobPath), true, 'in-progress file untouched');
  const stoppedDir = getFollowUpJobDir(rootDir, 'stopped');
  assert.equal(existsSync(stoppedDir) ? readdirSync(stoppedDir).length : 0, 0);
});

test('sweepStuckInProgressClaims: HQ-dispatched jobs are exempt from stale reclaim', () => {
  const rootDir = makeRoot();
  const { jobPath } = seedInProgressJob(rootDir, {
    jobId: 'laceyenterprises__agent-os-pr-1226-hq',
    lastHeartbeatAt: '2026-06-01T05:00:00.000Z',
  });
  const job = readJobAtPath(jobPath);
  writeFollowUpJob(jobPath, {
    ...job,
    remediationWorker: {
      ...job.remediationWorker,
      dispatchMode: 'hq',
      processId: null,
    },
  });

  const nowMs = Date.parse('2026-06-01T05:35:00.000Z');
  const result = sweepStuckInProgressClaims({ rootDir, nowMs });

  assert.equal(result.scanned, 1);
  assert.equal(result.reclaimed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(existsSync(jobPath), true, 'HQ claim stays in in-progress/');
});

test('sweepStuckInProgressClaims: missing lastHeartbeatAt falls back to file mtime', () => {
  const rootDir = makeRoot();
  // No lastHeartbeatAt, no claimedAt, no spawnedAt — only mtime.
  const oldMtime = '2026-06-01T04:00:00.000Z';
  const { jobPath } = seedInProgressJob(rootDir, {
    jobId: 'laceyenterprises__agent-os-pr-1227-no-heartbeat',
    prNumber: 1227,
    claimedAt: null,
    spawnedAt: null,
    mtimeIso: oldMtime,
  });
  // strip the timestamps the seeder writes so only mtime remains
  const job = readJobAtPath(jobPath);
  delete job.claimedAt;
  delete job.remediationWorker.spawnedAt;
  writeFollowUpJob(jobPath, job);
  const mtime = new Date(oldMtime);
  utimesSync(jobPath, mtime, mtime);

  const nowMs = Date.parse('2026-06-01T05:35:00.000Z');
  const result = sweepStuckInProgressClaims({ rootDir, nowMs });

  assert.equal(result.reclaimed, 1);
  const stoppedPath = path.join(getFollowUpJobDir(rootDir, 'stopped'), path.basename(jobPath));
  const stoppedJob = readJobAtPath(stoppedPath);
  assert.equal(stoppedJob.remediationWorker?.reclaimSource, 'mtime');
});

test('emitHeartbeatsForActiveJobs before sweep preserves a live detached worker after daemon downtime', () => {
  const rootDir = makeRoot();
  const { jobPath } = seedInProgressJob(rootDir, {
    jobId: 'laceyenterprises__agent-os-pr-1227-bounce-survivor',
    prNumber: 1227,
    lastHeartbeatAt: '2026-06-01T05:00:00.000Z',
  });
  const heartbeatMs = Date.parse('2026-06-01T05:34:59.000Z');
  const sweepMs = Date.parse('2026-06-01T05:35:00.000Z');

  const heartbeatResult = emitHeartbeatsForActiveJobs({
    rootDir,
    nowMs: heartbeatMs,
    isWorkerAlive: (pid) => pid === 99999,
  });
  const sweepResult = sweepStuckInProgressClaims({ rootDir, nowMs: sweepMs });

  assert.equal(heartbeatResult.touched, 1);
  assert.equal(sweepResult.reclaimed, 0);
  assert.equal(existsSync(jobPath), true, 'live worker must remain claimable after restart');
  const job = readJobAtPath(jobPath);
  assert.equal(job.lastHeartbeatAt, '2026-06-01T05:34:59.000Z');
});

test('sweepStuckInProgressClaims: env var threshold is honored', () => {
  const rootDir = makeRoot();
  // Heartbeat is 2s old at nowMs.
  seedInProgressJob(rootDir, {
    lastHeartbeatAt: '2026-06-01T05:34:58.000Z',
  });
  const nowMs = Date.parse('2026-06-01T05:35:00.000Z');

  // Default threshold (10m) leaves it alone.
  const defaultResult = sweepStuckInProgressClaims({ rootDir, nowMs });
  assert.equal(defaultResult.reclaimed, 0);

  // 1-second threshold via env var resolution.
  const previous = process.env[IN_PROGRESS_STUCK_THRESHOLD_MS_ENV];
  process.env[IN_PROGRESS_STUCK_THRESHOLD_MS_ENV] = '1000';
  try {
    const thresholdMs = resolveInProgressStuckThresholdMs(process.env);
    assert.equal(thresholdMs, 1000);
    const result = sweepStuckInProgressClaims({ rootDir, nowMs, thresholdMs });
    assert.equal(result.reclaimed, 1);
  } finally {
    if (previous === undefined) {
      delete process.env[IN_PROGRESS_STUCK_THRESHOLD_MS_ENV];
    } else {
      process.env[IN_PROGRESS_STUCK_THRESHOLD_MS_ENV] = previous;
    }
  }
});

test('resolveInProgressStuckThresholdMs returns the default when env var is unset or invalid', () => {
  const env = {};
  assert.equal(resolveInProgressStuckThresholdMs(env), DEFAULT_IN_PROGRESS_STUCK_THRESHOLD_MS);
  assert.equal(
    resolveInProgressStuckThresholdMs({ [IN_PROGRESS_STUCK_THRESHOLD_MS_ENV]: 'not-a-number' }),
    DEFAULT_IN_PROGRESS_STUCK_THRESHOLD_MS,
  );
  assert.equal(
    resolveInProgressStuckThresholdMs({ [IN_PROGRESS_STUCK_THRESHOLD_MS_ENV]: '-5' }),
    DEFAULT_IN_PROGRESS_STUCK_THRESHOLD_MS,
  );
});

test('applyPreSpawnLifecycleGate: merged lifecycle delegates to canonical stopped/operator-merged-pr path', async () => {
  const rootDir = makeRoot();
  const { job, jobPath } = seedInProgressJob(rootDir, {
    lastHeartbeatAt: '2026-06-01T05:35:00.000Z',
  });
  const logs = [];
  const stopCalls = [];
  const result = await applyPreSpawnLifecycleGate({
    rootDir,
    job,
    jobPath,
    resolvePRLifecycleImpl: async () => ({
      source: 'mirror',
      prState: 'merged',
      mergedAt: '2026-06-01T05:01:49.000Z',
      closedAt: null,
    }),
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    stopConsumedJobWithCommentImpl: async (args) => {
      stopCalls.push(args);
      return markFollowUpJobStopped({
        rootDir: args.rootDir,
        jobPath: args.jobPath,
        stoppedAt: args.stoppedAt,
        stopCode: args.stopCode,
        stopReason: args.stopReason,
        sourceStatus: args.sourceStatus,
        remediationWorker: args.remediationWorker,
        commentDelivery: {
          body: 'owed comment',
          posted: false,
          action: 'stopped',
          attempts: [],
        },
      });
    },
    now: () => '2026-06-01T05:01:51.000Z',
    log: { log: (msg) => logs.push(msg) },
  });

  assert.equal(result.action, 'stopped');
  assert.equal(existsSync(jobPath), false);
  assert.equal(stopCalls.length, 1);
  assert.equal(stopCalls[0].stopCode, 'operator-merged-pr');
  const stoppedPath = path.join(getFollowUpJobDir(rootDir, 'stopped'), path.basename(jobPath));
  assert.equal(existsSync(stoppedPath), true);
  const stoppedJob = readJobAtPath(stoppedPath);
  assert.equal(stoppedJob.status, 'stopped');
  assert.equal(stoppedJob.remediationPlan?.stop?.code, 'operator-merged-pr');
  assert.equal(stoppedJob.remediationWorker?.state, 'never-spawned');
  assert.equal(stoppedJob.remediationPlan?.stop?.reason.includes('source=mirror'), true);
  assert.equal(stoppedJob.remediationWorker?.preSpawnLifecycleCheckAt, '2026-06-01T05:01:51.000Z');
  assert.equal(stoppedJob.remediationWorker?.prMergedAt, '2026-06-01T05:01:49.000Z');
  assert.equal(stoppedJob.commentDelivery?.posted, false);
  assert.match(logs[0], /pre-spawn-lifecycle-stop/);
  assert.match(logs[0], /operator-merged-pr/);
});

test('applyPreSpawnLifecycleGate: closed lifecycle delegates to canonical stopped/operator-closed-pr path', async () => {
  const rootDir = makeRoot();
  const { job, jobPath } = seedInProgressJob(rootDir, {
    jobId: 'laceyenterprises__agent-os-pr-1228-closed',
    prNumber: 1228,
    lastHeartbeatAt: '2026-06-01T05:35:00.000Z',
  });
  const result = await applyPreSpawnLifecycleGate({
    rootDir,
    job,
    jobPath,
    resolvePRLifecycleImpl: async () => ({
      source: 'live',
      prState: 'closed',
      mergedAt: null,
      closedAt: '2026-06-01T05:01:49.000Z',
    }),
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    stopConsumedJobWithCommentImpl: async (args) => markFollowUpJobStopped({
      rootDir: args.rootDir,
      jobPath: args.jobPath,
      stoppedAt: args.stoppedAt,
      stopCode: args.stopCode,
      stopReason: args.stopReason,
      sourceStatus: args.sourceStatus,
      remediationWorker: args.remediationWorker,
      commentDelivery: {
        body: 'owed comment',
        posted: false,
        action: 'stopped',
        attempts: [],
      },
    }),
    now: () => '2026-06-01T05:01:51.000Z',
  });

  assert.equal(result.action, 'stopped');
  assert.equal(existsSync(jobPath), false);
  const stoppedPath = path.join(getFollowUpJobDir(rootDir, 'stopped'), path.basename(jobPath));
  const stoppedJob = readJobAtPath(stoppedPath);
  assert.equal(stoppedJob.status, 'stopped');
  assert.equal(stoppedJob.remediationPlan?.stop?.code, 'operator-closed-pr');
  assert.equal(stoppedJob.remediationWorker?.state, 'never-spawned');
  assert.equal(stoppedJob.remediationWorker?.prClosedAt, '2026-06-01T05:01:49.000Z');
  assert.equal(stoppedJob.commentDelivery?.posted, false);
});

test('applyPreSpawnLifecycleGate: stale-review-head uses the canonical consume-time stop', async () => {
  const rootDir = makeRoot();
  const { job, jobPath } = seedInProgressJob(rootDir, {
    jobId: 'laceyenterprises__agent-os-pr-1229-stale-head',
    prNumber: 1229,
    lastHeartbeatAt: '2026-06-01T05:35:00.000Z',
  });
  const result = await applyPreSpawnLifecycleGate({
    rootDir,
    job: { ...job, revisionRef: 'sha-before' },
    jobPath,
    resolvePRLifecycleImpl: async () => ({
      source: 'live',
      prState: 'open',
      mergedAt: null,
      closedAt: null,
      headSha: 'sha-after',
    }),
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    now: () => '2026-06-01T05:01:51.000Z',
  });

  assert.equal(result.action, 'stopped');
  assert.equal(existsSync(jobPath), false);
  const stoppedPath = path.join(getFollowUpJobDir(rootDir, 'stopped'), path.basename(jobPath));
  const stoppedJob = readJobAtPath(stoppedPath);
  assert.equal(stoppedJob.remediationPlan?.stop?.code, 'stale-review-head');
  assert.match(stoppedJob.remediationPlan?.stop?.reason, /sha-before/);
  assert.match(stoppedJob.remediationPlan?.stop?.reason, /sha-after/);
  assert.equal(stoppedJob.remediationWorker?.state, 'never-spawned');
});

test('applyPreSpawnLifecycleGate: stale-drift uses the canonical consume-time stop', async () => {
  const rootDir = makeRoot();
  const { job, jobPath } = seedInProgressJob(rootDir, {
    jobId: 'laceyenterprises__agent-os-pr-1230-stale-drift',
    prNumber: 1230,
    lastHeartbeatAt: '2026-06-01T05:35:00.000Z',
  });
  const logs = [];
  const result = await applyPreSpawnLifecycleGate({
    rootDir,
    job,
    jobPath,
    resolvePRLifecycleImpl: async () => ({
      source: 'mirror',
      prState: 'open',
      mergedAt: null,
      closedAt: null,
      labels: [{ name: 'stale-drift' }],
    }),
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    now: () => '2026-06-01T05:01:51.000Z',
    log: { log: (msg) => logs.push(msg) },
  });

  assert.equal(result.action, 'stopped');
  assert.equal(existsSync(jobPath), false);
  const stoppedPath = path.join(getFollowUpJobDir(rootDir, 'stopped'), path.basename(jobPath));
  const stoppedJob = readJobAtPath(stoppedPath);
  assert.equal(stoppedJob.remediationPlan?.stop?.code, 'stale-drift');
  assert.match(stoppedJob.remediationPlan?.stop?.reason, /stale-drift label/);
  assert.match(logs[0], /stale-drift/);
});

test('applyPreSpawnLifecycleGate: unresolved lifecycle still falls through to continue', async () => {
  const rootDir = makeRoot();
  const { job, jobPath } = seedInProgressJob(rootDir, {
    jobId: 'laceyenterprises__agent-os-pr-1231-no-lifecycle',
    prNumber: 1231,
    lastHeartbeatAt: '2026-06-01T05:35:00.000Z',
  });
  const logs = [];
  const result = await applyPreSpawnLifecycleGate({
    rootDir,
    job,
    jobPath,
    resolvePRLifecycleImpl: async () => {
      throw new Error('gh: network unreachable');
    },
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    now: () => '2026-06-01T05:01:51.000Z',
    log: { error: (msg) => logs.push(msg) },
  });

  assert.equal(result.action, 'continue');
  assert.equal(result.reason, 'pr-open');
  assert.equal(existsSync(jobPath), true);
  assert.match(logs[0], /PR lifecycle resolve threw/);
});
