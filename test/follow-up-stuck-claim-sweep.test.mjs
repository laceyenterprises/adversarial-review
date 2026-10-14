// LAC-957 / ARP-FUS-01 — stuck-claim sweep + pre-spawn lifecycle recheck.
//
// Tonight (2026-06-01 ~05:02Z) an orphaned in-progress claim blocked
// the follow-up daemon's queue for 35 min because the remediator
// died without releasing its claim. These tests pin the sweep +
// precheck behavior that prevents a repeat.

import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
  attemptDirtyMerge,
  emitHeartbeatsForActiveJobs,
  normalizeWorkerArtifactProgressMs,
  readWorkerCpuPercent,
  pushDirtyMergeWithRetry,
  resolveDirtyConflictSpecContext,
  resolveInProgressStuckThresholdMs,
  resolveWorkerArtifactProgressMs,
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
  worker = {},
  plan = {},
  jobUpdates = {},
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
      ...worker,
    },
    remediationPlan: {
      ...(baseJob.remediationPlan || {}),
      ...plan,
    },
    ...jobUpdates,
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

function pendingPathFor(rootDir, jobPath) {
  return path.join(getFollowUpJobDir(rootDir, 'pending'), path.basename(jobPath));
}

function stoppedPathFor(rootDir, jobPath) {
  return path.join(getFollowUpJobDir(rootDir, 'stopped'), path.basename(jobPath));
}

function assertStaleJobRequeued(rootDir, jobPath, { source = 'lastHeartbeatAt' } = {}) {
  assert.equal(existsSync(jobPath), false, 'in-progress file removed');
  const pendingPath = pendingPathFor(rootDir, jobPath);
  assert.equal(existsSync(pendingPath), true, 'file moved back to pending/');
  assert.equal(existsSync(stoppedPathFor(rootDir, jobPath)), false, 'file not moved to stopped/');
  const pendingJob = readJobAtPath(pendingPath);
  assert.equal(pendingJob.status, 'pending');
  assert.equal(pendingJob.remediationWorker, null);
  assert.equal(pendingJob.remediationPlan?.transientRetries, 1);
  assert.equal(pendingJob.remediationPlan?.retryHistory?.at(-1)?.retryMetadata?.code, STALE_HEARTBEAT_STOP_CODE);
  assert.equal(pendingJob.remediationPlan?.retryHistory?.at(-1)?.retryMetadata?.reclaimSource, source);
  return pendingJob;
}

async function successfulStaleSignal() {
  return {
    signalled: true,
    target: { kind: 'process-group', id: 99999 },
    error: null,
  };
}

test('sweepStuckInProgressClaims: stale lastHeartbeatAt requeues direct remediator before terminal stop', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedInProgressJob(rootDir, {
    lastHeartbeatAt: '2026-06-01T05:00:00.000Z',
  });
  const nowMs = Date.parse('2026-06-01T05:35:00.000Z');
  const logs = [];
  const result = await sweepStuckInProgressClaims({
    rootDir,
    nowMs,
    log: { log: (msg) => logs.push(msg) },
    sendWorkerSignalImpl: successfulStaleSignal,
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.reclaimed, 1);
  assert.equal(result.requeued, 1);
  assert.equal(result.terminalStopped, 0);
  assert.equal(result.skipped, 0);
  const pendingJob = assertStaleJobRequeued(rootDir, jobPath);
  const retryWorker = pendingJob.remediationPlan.retryHistory.at(-1).worker;
  assert.equal(retryWorker?.state, 'spawned');
  assert.deepEqual(pendingJob.remediationPlan?.retryHistory?.at(-1)?.retryMetadata?.staleReclaimSignal?.target, {
    kind: 'process-group',
    id: 99999,
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /stale-claim-requeued/);
  assert.match(logs[0], /source=lastHeartbeatAt/);
  assert.match(logs[0], /signalled=true/);
});

test('sweepStuckInProgressClaims: exhausted stale retry budget stops and posts owed comment', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedInProgressJob(rootDir, {
    lastHeartbeatAt: '2026-06-01T05:00:00.000Z',
    plan: { currentRound: 2, maxRounds: undefined, transientRetries: 1 },
  });
  const nowMs = Date.parse('2026-06-01T05:35:00.000Z');
  const posts = [];
  const result = await sweepStuckInProgressClaims({
    rootDir,
    nowMs,
    maxTransientRetries: 1,
    sendWorkerSignalImpl: successfulStaleSignal,
    postCommentImpl: async (args) => {
      posts.push(args);
      return { posted: true, url: 'https://github.test/comment/1' };
    },
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.reclaimed, 1);
  assert.equal(result.requeued, 0);
  assert.equal(result.terminalStopped, 1);
  assert.equal(existsSync(jobPath), false, 'in-progress file removed');
  const stoppedPath = stoppedPathFor(rootDir, jobPath);
  assert.equal(existsSync(stoppedPath), true, 'file moved to stopped/');
  const stoppedJob = readJobAtPath(stoppedPath);
  assert.equal(stoppedJob.status, 'stopped');
  assert.equal(stoppedJob.remediationPlan?.stop?.code, STALE_HEARTBEAT_STOP_CODE);
  assert.match(stoppedJob.remediationPlan?.stop?.reason, /Exhausted stale heartbeat retry budget/);
  assert.equal(stoppedJob.remediationPlan?.stop?.sourceStatus, 'in_progress');
  assert.ok(stoppedJob.remediationPlan?.stop?.maxRounds > 0);
  assert.equal(stoppedJob.commentDelivery?.posted, true);
  assert.equal(stoppedJob.commentDelivery?.reason, null);
  assert.match(stoppedJob.commentDelivery?.body, /stale-heartbeat/);
  assert.match(stoppedJob.commentDelivery?.body, /round 2 of 2/);
  assert.equal(posts.length, 1);
  assert.match(posts[0].body, /stale-heartbeat/);
  assert.match(posts[0].body, /round 2 of 2/);
});

test('sweepStuckInProgressClaims: posted in-progress delivery is not posted again', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedInProgressJob(rootDir, {
    lastHeartbeatAt: '2026-06-01T05:00:00.000Z',
    plan: { currentRound: 2, maxRounds: undefined, transientRetries: 1 },
    jobUpdates: {
      commentDelivery: {
        posted: true,
        attempts: 1,
        body: 'already posted stale-heartbeat comment',
        repo: 'laceyenterprises/agent-os',
        prNumber: 1226,
        workerClass: 'codex',
        reason: null,
      },
    },
  });
  const nowMs = Date.parse('2026-06-01T05:35:00.000Z');
  const result = await sweepStuckInProgressClaims({
    rootDir,
    nowMs,
    maxTransientRetries: 1,
    sendWorkerSignalImpl: successfulStaleSignal,
    recordInitialCommentDeliveryImpl: async () => {
      throw new Error('must not repost an already posted terminal comment');
    },
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.reclaimed, 1);
  assert.equal(result.requeued, 0);
  assert.equal(result.terminalStopped, 1);
  assert.equal(existsSync(jobPath), false, 'in-progress file removed');
  const stoppedJob = readJobAtPath(stoppedPathFor(rootDir, jobPath));
  assert.equal(stoppedJob.status, 'stopped');
  assert.equal(stoppedJob.commentDelivery?.posted, true);
  assert.equal(stoppedJob.commentDelivery?.body, 'already posted stale-heartbeat comment');
  assert.equal(stoppedJob.remediationPlan?.stop?.maxRounds, 2);
});

test('sweepStuckInProgressClaims: terminal comment delivery throw leaves stale claim recoverable', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedInProgressJob(rootDir, {
    lastHeartbeatAt: '2026-06-01T05:00:00.000Z',
    plan: { currentRound: 2, maxRounds: undefined, transientRetries: 1 },
  });
  const nowMs = Date.parse('2026-06-01T05:35:00.000Z');
  const warnings = [];
  const result = await sweepStuckInProgressClaims({
    rootDir,
    nowMs,
    maxTransientRetries: 1,
    log: { warn: (msg) => warnings.push(msg) },
    sendWorkerSignalImpl: successfulStaleSignal,
    recordInitialCommentDeliveryImpl: async () => {
      throw new Error('transient GitHub outage');
    },
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.reclaimed, 0);
  assert.equal(result.requeued, 0);
  assert.equal(result.terminalStopped, 0);
  assert.equal(result.skipped, 1);
  assert.equal(existsSync(jobPath), true, 'in-progress file remains for retry');
  assert.equal(existsSync(stoppedPathFor(rootDir, jobPath)), false, 'file not moved to stopped/');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /stale-claim-terminal-comment-failed/);
  assert.match(warnings[0], /transient GitHub outage/);
});

test('sweepStuckInProgressClaims: failed terminal comment delivery leaves stale claim recoverable', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedInProgressJob(rootDir, {
    lastHeartbeatAt: '2026-06-01T05:00:00.000Z',
    plan: { currentRound: 2, maxRounds: undefined, transientRetries: 1 },
  });
  const nowMs = Date.parse('2026-06-01T05:35:00.000Z');
  const warnings = [];
  const result = await sweepStuckInProgressClaims({
    rootDir,
    nowMs,
    maxTransientRetries: 1,
    log: { warn: (msg) => warnings.push(msg) },
    sendWorkerSignalImpl: successfulStaleSignal,
    recordInitialCommentDeliveryImpl: async () => ({
      posted: false,
      reason: 'gh-cli-failure',
      body: 'owed stale-heartbeat comment',
    }),
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.reclaimed, 0);
  assert.equal(result.requeued, 0);
  assert.equal(result.terminalStopped, 0);
  assert.equal(result.skipped, 1);
  assert.equal(existsSync(jobPath), true, 'in-progress file remains for retry');
  assert.equal(existsSync(stoppedPathFor(rootDir, jobPath)), false, 'file not moved to stopped/');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /stale-claim-terminal-comment-deferred/);
  assert.match(warnings[0], /deliveryReason=gh-cli-failure/);
});

test('sweepStuckInProgressClaims: failed stale-worker signal leaves claim in progress', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedInProgressJob(rootDir, {
    lastHeartbeatAt: '2026-06-01T05:00:00.000Z',
  });
  const nowMs = Date.parse('2026-06-01T05:35:00.000Z');
  const warnings = [];
  const result = await sweepStuckInProgressClaims({
    rootDir,
    nowMs,
    log: { warn: (msg) => warnings.push(msg) },
    sendWorkerSignalImpl: async () => {
      throw new Error('launchctl EIO');
    },
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.reclaimed, 0);
  assert.equal(result.signalFailed, 1);
  assert.equal(result.signalled, 0);
  assert.equal(existsSync(jobPath), true, 'in-progress file remains for retry');
  const stoppedDir = getFollowUpJobDir(rootDir, 'stopped');
  assert.equal(existsSync(stoppedDir) ? readdirSync(stoppedDir).length : 0, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /stale-claim-signal-failed/);
  assert.match(warnings[0], /launchctl EIO/);
});

test('sweepStuckInProgressClaims: already-dead stale worker still reclaims claim', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedInProgressJob(rootDir, {
    lastHeartbeatAt: '2026-06-01T05:00:00.000Z',
  });
  const nowMs = Date.parse('2026-06-01T05:35:00.000Z');
  const logs = [];
  const result = await sweepStuckInProgressClaims({
    rootDir,
    nowMs,
    log: { log: (msg) => logs.push(msg) },
    sendWorkerSignalImpl: async () => ({
      signalled: false,
      target: { kind: 'process-group', id: 99999 },
      error: 'process-group-not-found',
    }),
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.reclaimed, 1);
  assert.equal(result.requeued, 1);
  assert.equal(result.signalFailed, 0);
  assert.equal(result.signalSkipped, 1);
  const pendingJob = assertStaleJobRequeued(rootDir, jobPath);
  const retryMetadata = pendingJob.remediationPlan.retryHistory.at(-1).retryMetadata;
  assert.equal(retryMetadata?.staleReclaimSignal?.skipped, true);
  assert.equal(retryMetadata?.staleReclaimSignal?.error, 'process-group-not-found');
  assert.match(logs[0], /stale-claim-requeued/);
});

test('sweepStuckInProgressClaims: ESRCH stale-worker signal still reclaims claim', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedInProgressJob(rootDir, {
    lastHeartbeatAt: '2026-06-01T05:00:00.000Z',
  });
  const nowMs = Date.parse('2026-06-01T05:35:00.000Z');
  const result = await sweepStuckInProgressClaims({
    rootDir,
    nowMs,
    sendWorkerSignalImpl: async () => {
      const err = new Error('kill ESRCH: No such process');
      err.code = 'ESRCH';
      throw err;
    },
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.reclaimed, 1);
  assert.equal(result.requeued, 1);
  assert.equal(result.signalFailed, 0);
  assert.equal(result.signalSkipped, 1);
  assertStaleJobRequeued(rootDir, jobPath);
});

test('sweepStuckInProgressClaims: fresh lastHeartbeatAt leaves claim in place', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedInProgressJob(rootDir, {
    lastHeartbeatAt: '2026-06-01T05:34:00.000Z',
  });
  const nowMs = Date.parse('2026-06-01T05:35:00.000Z');
  const result = await sweepStuckInProgressClaims({ rootDir, nowMs });

  assert.equal(result.scanned, 1);
  assert.equal(result.reclaimed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(existsSync(jobPath), true, 'in-progress file untouched');
  const stoppedDir = getFollowUpJobDir(rootDir, 'stopped');
  assert.equal(existsSync(stoppedDir) ? readdirSync(stoppedDir).length : 0, 0);
});

test('sweepStuckInProgressClaims: HQ-dispatched jobs are exempt from stale reclaim', async () => {
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
  const result = await sweepStuckInProgressClaims({
    rootDir,
    nowMs,
    sendWorkerSignalImpl: successfulStaleSignal,
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.reclaimed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(existsSync(jobPath), true, 'HQ claim stays in in-progress/');
});

test('sweepStuckInProgressClaims: missing lastHeartbeatAt falls back to file mtime', async () => {
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
  const result = await sweepStuckInProgressClaims({
    rootDir,
    nowMs,
    sendWorkerSignalImpl: successfulStaleSignal,
  });

  assert.equal(result.reclaimed, 1);
  assert.equal(result.requeued, 1);
  assertStaleJobRequeued(rootDir, jobPath, { source: 'mtime' });
});

test('emitHeartbeatsForActiveJobs before sweep preserves a live detached worker after daemon downtime', async () => {
  const rootDir = makeRoot();
  const artifactDir = path.join(rootDir, 'artifacts');
  mkdirSync(artifactDir, { recursive: true });
  const logPath = path.join(artifactDir, 'codex-worker.log');
  writeFileSync(logPath, 'still making progress\n', 'utf8');
  const progressTime = new Date('2026-06-01T05:34:30.000Z');
  utimesSync(logPath, progressTime, progressTime);
  const { jobPath } = seedInProgressJob(rootDir, {
    jobId: 'laceyenterprises__agent-os-pr-1227-bounce-survivor',
    prNumber: 1227,
    lastHeartbeatAt: '2026-06-01T05:00:00.000Z',
    worker: {
      logPath: path.relative(rootDir, logPath),
    },
  });
  const heartbeatMs = Date.parse('2026-06-01T05:34:59.000Z');
  const sweepMs = Date.parse('2026-06-01T05:35:00.000Z');

  const heartbeatResult = emitHeartbeatsForActiveJobs({
    rootDir,
    nowMs: heartbeatMs,
    isWorkerAlive: (pid) => pid === 99999,
  });
  const sweepResult = await sweepStuckInProgressClaims({ rootDir, nowMs: sweepMs });

  assert.equal(heartbeatResult.touched, 1);
  assert.equal(sweepResult.reclaimed, 0);
  assert.equal(existsSync(jobPath), true, 'live worker must remain claimable after restart');
  const job = readJobAtPath(jobPath);
  assert.equal(job.lastHeartbeatAt, '2026-06-01T05:34:59.000Z');
  assert.equal(job.lastWorkerArtifactProgressAt, '2026-06-01T05:34:30.000Z');
  assert.equal(job.lastWorkerArtifactProgressSource, 'remediationWorker.logPath');
});

test('sweep consults advancing transcript even when the persisted heartbeat is stale', async () => {
  const rootDir = makeRoot();
  const transcriptPath = path.join(rootDir, 'session-events.jsonl');
  writeFileSync(transcriptPath, '{"event":"progress"}\n');
  const recent = new Date('2026-06-01T05:34:30.000Z');
  utimesSync(transcriptPath, recent, recent);
  const { jobPath } = seedInProgressJob(rootDir, {
    lastHeartbeatAt: '2026-06-01T05:00:00.000Z',
    worker: { sessionEventsPath: transcriptPath },
  });
  const result = await sweepStuckInProgressClaims({
    rootDir,
    nowMs: Date.parse('2026-06-01T05:35:00.000Z'),
    readWorkerCpuImpl: () => 0,
  });
  assert.equal(result.reclaimed, 0);
  assert.equal(existsSync(jobPath), true);
});

test('sweep retains a CPU-active worker but reclaims it when CPU and artifacts stop', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedInProgressJob(rootDir, {
    lastHeartbeatAt: '2026-06-01T05:00:00.000Z',
  });
  const nowMs = Date.parse('2026-06-01T05:20:00.000Z');
  const active = await sweepStuckInProgressClaims({ rootDir, nowMs, readWorkerCpuImpl: () => 4 });
  assert.equal(active.reclaimed, 0);
  const idle = await sweepStuckInProgressClaims({
    rootDir, nowMs, readWorkerCpuImpl: () => 0, sendWorkerSignalImpl: successfulStaleSignal,
  });
  assert.equal(idle.reclaimed, 1);
  assertStaleJobRequeued(rootDir, jobPath);
});

test('sweep reclaims a CPU-active worker after the bounded progress grace period', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedInProgressJob(rootDir, { lastHeartbeatAt: '2026-06-01T05:00:00.000Z' });
  const result = await sweepStuckInProgressClaims({
    rootDir,
    nowMs: Date.parse('2026-06-01T06:00:00.000Z'),
    readWorkerCpuImpl: () => 100,
    sendWorkerSignalImpl: successfulStaleSignal,
  });
  assert.equal(result.reclaimed, 1);
  assertStaleJobRequeued(rootDir, jobPath);
});

test('CPU probe ignores a reused PID with the wrong process identity', () => {
  const job = { remediationWorker: {
    processId: 123, processGroupId: 123, spawnedAt: new Date(Date.parse('Mon Jun  1 05:00:00 2026')).toISOString(),
  } };
  const probe = (output) => readWorkerCpuPercent(job, { execFileSyncImpl: () => output });
  assert.equal(probe('123 Mon Jun  1 05:00:00 2026 84.0'), 84);
  assert.equal(probe('456 Mon Jun  1 05:00:00 2026 84.0'), 0);
  assert.equal(probe('123 Mon Jun  1 06:00:00 2026 84.0'), 0);
});

test('emitHeartbeatsForActiveJobs does not refresh a silent alive worker with empty artifacts', async () => {
  const rootDir = makeRoot();
  const artifactDir = path.join(rootDir, 'artifacts');
  mkdirSync(artifactDir, { recursive: true });
  const logPath = path.join(artifactDir, 'codex-worker.log');
  writeFileSync(logPath, '', 'utf8');
  const logMtime = new Date('2026-06-01T05:34:30.000Z');
  utimesSync(logPath, logMtime, logMtime);
  const { jobPath } = seedInProgressJob(rootDir, {
    jobId: 'laceyenterprises__agent-os-pr-1227-silent-worker',
    prNumber: 1227,
    spawnedAt: '2026-06-01T05:00:00.000Z',
    lastHeartbeatAt: '2026-06-01T05:00:00.000Z',
    worker: {
      logPath: path.relative(rootDir, logPath),
    },
  });

  const heartbeatResult = emitHeartbeatsForActiveJobs({
    rootDir,
    nowMs: Date.parse('2026-06-01T05:34:59.000Z'),
    isWorkerAlive: (pid) => pid === 99999,
  });
  const sweepResult = await sweepStuckInProgressClaims({
    rootDir,
    nowMs: Date.parse('2026-06-01T05:35:00.000Z'),
    sendWorkerSignalImpl: successfulStaleSignal,
  });

  assert.equal(heartbeatResult.touched, 0);
  assert.equal(sweepResult.reclaimed, 1);
  assert.equal(sweepResult.requeued, 1);
  assertStaleJobRequeued(rootDir, jobPath, { source: 'lastHeartbeatAt' });
});

test('sweepStuckInProgressClaims prefers artifact progress over synthetic heartbeat freshness', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedInProgressJob(rootDir, {
    jobId: 'laceyenterprises__agent-os-pr-1227-stale-artifact-progress',
    prNumber: 1227,
    lastHeartbeatAt: '2026-06-01T05:34:59.000Z',
  });
  const job = readJobAtPath(jobPath);
  writeFollowUpJob(jobPath, {
    ...job,
    lastWorkerArtifactProgressAt: '2026-06-01T05:00:00.000Z',
  });

  const result = await sweepStuckInProgressClaims({
    rootDir,
    nowMs: Date.parse('2026-06-01T05:35:00.000Z'),
    sendWorkerSignalImpl: successfulStaleSignal,
  });

  assert.equal(result.reclaimed, 1);
  assert.equal(result.requeued, 1);
  assertStaleJobRequeued(rootDir, jobPath, { source: 'lastWorkerArtifactProgressAt' });
});

test('resolveWorkerArtifactProgressMs ignores empty artifacts', () => {
  const rootDir = makeRoot();
  const artifactDir = path.join(rootDir, 'artifacts');
  mkdirSync(artifactDir, { recursive: true });
  const emptyLogPath = path.join(artifactDir, 'codex-worker.log');
  const outputPath = path.join(artifactDir, 'codex-last-message.md');
  writeFileSync(emptyLogPath, '', 'utf8');
  writeFileSync(outputPath, 'done\n', 'utf8');
  const emptyMtime = new Date('2026-06-01T05:34:30.000Z');
  const outputMtime = new Date('2026-06-01T05:34:00.000Z');
  utimesSync(emptyLogPath, emptyMtime, emptyMtime);
  utimesSync(outputPath, outputMtime, outputMtime);
  const { job } = seedInProgressJob(rootDir, {
    worker: {
      logPath: path.relative(rootDir, emptyLogPath),
      outputPath,
    },
  });

  const progress = resolveWorkerArtifactProgressMs(rootDir, job);

  assert.equal(progress.source, 'remediationWorker.outputPath');
  assert.equal(new Date(progress.sourceMs).toISOString(), '2026-06-01T05:34:00.000Z');
});

test('normalizeWorkerArtifactProgressMs floors fractional stat timestamps', () => {
  assert.equal(normalizeWorkerArtifactProgressMs(1_717_238_070_123.987), 1_717_238_070_123);
  assert.equal(normalizeWorkerArtifactProgressMs(Number.NaN), null);
});

test('sweepStuckInProgressClaims: env var threshold is honored', async () => {
  const rootDir = makeRoot();
  // Heartbeat is 2s old at nowMs.
  seedInProgressJob(rootDir, {
    lastHeartbeatAt: '2026-06-01T05:34:58.000Z',
  });
  const nowMs = Date.parse('2026-06-01T05:35:00.000Z');

  // Default threshold (10m) leaves it alone.
  const defaultResult = await sweepStuckInProgressClaims({ rootDir, nowMs });
  assert.equal(defaultResult.reclaimed, 0);

  // 1-second threshold via env var resolution.
  const previous = process.env[IN_PROGRESS_STUCK_THRESHOLD_MS_ENV];
  process.env[IN_PROGRESS_STUCK_THRESHOLD_MS_ENV] = '1000';
  try {
    const thresholdMs = resolveInProgressStuckThresholdMs(process.env);
    assert.equal(thresholdMs, 1000);
    const result = await sweepStuckInProgressClaims({
      rootDir,
      nowMs,
      thresholdMs,
      sendWorkerSignalImpl: successfulStaleSignal,
    });
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

test('applyPreSpawnLifecycleGate: stale-review-head beats DIRTY repair and uses the canonical stop', async () => {
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
      mergeStateStatus: 'DIRTY',
    }),
    dirtyMergeImpl: async () => { throw new Error('stale head must stop before dirty repair'); },
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

test('applyPreSpawnLifecycleGate: stale-drift beats DIRTY repair and uses the canonical stop', async () => {
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
      mergeStateStatus: 'DIRTY',
    }),
    dirtyMergeImpl: async () => { throw new Error('stale drift must stop before dirty repair'); },
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

test('applyPreSpawnLifecycleGate: DIRTY clean auto-merge pushes and lets remediation proceed', async () => {
  const rootDir = makeRoot();
  const workspaceDir = path.join(rootDir, 'workspace');
  mkdirSync(path.join(workspaceDir, '.git'), { recursive: true });
  const { job, jobPath } = seedInProgressJob(rootDir, {
    jobId: 'laceyenterprises__agent-os-pr-1232-dirty-clean',
    prNumber: 1232,
    lastHeartbeatAt: '2026-06-01T05:35:00.000Z',
  });
  const result = await applyPreSpawnLifecycleGate({
    rootDir,
    job: { ...job, baseBranch: 'main', branch: 'feature/dirty-clean' },
    jobPath,
    workspaceDir,
    baseBranch: 'main',
    resolvePRLifecycleImpl: async () => ({
      source: 'live',
      prState: 'open',
      mergeStateStatus: 'DIRTY',
    }),
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    dirtyMergeImpl: async (args) => {
      assert.equal(args.workspaceDir, workspaceDir);
      assert.equal(args.baseBranch, 'main');
      assert.equal(args.branch, 'feature/dirty-clean');
      return { outcome: 'clean-merged', push: { attempts: 2 } };
    },
    now: () => '2026-06-01T05:02:00.000Z',
  });

  assert.equal(result.action, 'continue');
  assert.equal(result.reason, 'dirty-clean-merged');
  assert.equal(existsSync(jobPath), true);
  const persisted = readJobAtPath(jobPath);
  assert.equal(persisted.remediationWorker?.dirtyMergeResolution?.outcome, 'clean-merged');
  assert.equal(persisted.remediationWorker?.dirtyMergeResolution?.pushAttempts, 2);
});

test('applyPreSpawnLifecycleGate: exhausted transient DIRTY setup requeues instead of stopping', async () => {
  const rootDir = makeRoot();
  const workspaceDir = path.join(rootDir, 'workspace');
  mkdirSync(path.join(workspaceDir, '.git'), { recursive: true });
  const { job, jobPath } = seedInProgressJob(rootDir, {
    jobId: 'laceyenterprises__agent-os-pr-1232-dirty-transient',
    prNumber: 1232,
    lastHeartbeatAt: '2026-06-01T05:35:00.000Z',
  });
  const logs = [];
  const transient = Object.assign(new Error('fatal: unable to access https://github.com/laceyenterprises/agent-os.git'), {
    dirtyTransientExhausted: true,
    dirtyTransientPhase: 'fetch',
    dirtyTransientAttempts: 4,
    dirtyFetchAttempts: 4,
  });

  const result = await applyPreSpawnLifecycleGate({
    rootDir,
    job: { ...job, baseBranch: 'main', branch: 'feature/transient-dirty' },
    jobPath,
    workspaceDir,
    baseBranch: 'main',
    resolvePRLifecycleImpl: async () => ({
      source: 'live',
      prState: 'open',
      mergeStateStatus: 'DIRTY',
    }),
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    dirtyMergeImpl: async () => {
      throw transient;
    },
    now: () => '2026-06-01T05:02:00.000Z',
    log: { warn: (msg) => logs.push(msg) },
  });

  assert.equal(result.action, 'requeued');
  assert.equal(result.reason, 'dirty-merge-transient-failed');
  assert.equal(existsSync(jobPath), false);
  const pendingPath = path.join(getFollowUpJobDir(rootDir, 'pending'), path.basename(jobPath));
  assert.equal(existsSync(pendingPath), true);
  assert.equal(existsSync(path.join(getFollowUpJobDir(rootDir, 'stopped'), path.basename(jobPath))), false);
  const pending = readJobAtPath(pendingPath);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.remediationWorker, null);
  assert.equal(pending.remediationPlan?.transientRetries, 1);
  assert.equal(pending.remediationPlan?.retryAfter, '2026-06-01T05:03:00.000Z');
  assert.equal(pending.remediationPlan?.retryHistory?.[0]?.retryMetadata?.code, 'dirty-merge-transient');
  assert.equal(pending.remediationPlan?.retryHistory?.[0]?.retryMetadata?.phase, 'fetch');
  assert.equal(pending.remediationPlan?.retryHistory?.[0]?.retryMetadata?.dirtyMergeResolution?.outcome, 'transient-failed');
  assert.match(logs[0], /dirty-pr-transient-requeued/);
});

test('applyPreSpawnLifecycleGate: DIRTY conflict writes spec-guided hammer prompt', async () => {
  const rootDir = makeRoot();
  const workspaceDir = path.join(rootDir, 'workspace');
  mkdirSync(path.join(workspaceDir, '.git'), { recursive: true });
  mkdirSync(path.join(workspaceDir, 'projects', 'pipeline-stall-hardening'), { recursive: true });
  mkdirSync(path.join(workspaceDir, 'modules', 'worker-pool'), { recursive: true });
  writeFileSync(
    path.join(workspaceDir, 'projects', 'pipeline-stall-hardening', 'SPEC.md'),
    '# Pipeline Stall Hardening\n\n## Acceptance Criteria\n- DIRTY conflicts use spec-guided hammer remediation.\n',
    'utf8'
  );
  writeFileSync(
    path.join(workspaceDir, 'modules', 'worker-pool', 'AGENTS.md'),
    '# Worker Pool Agents\n\nFollow worker-pool dispatch ownership rules.\n',
    'utf8'
  );
  writeFileSync(
    path.join(workspaceDir, 'modules', 'worker-pool', 'SPEC.md'),
    '# Worker Pool Spec\n\n## Acceptance Criteria\n- Dispatch workers recreate branch state in isolated workspaces.\n',
    'utf8'
  );
  const promptPath = path.join(rootDir, 'prompt.md');
  writeFileSync(promptPath, 'original prompt\n', 'utf8');
  const { job, jobPath } = seedInProgressJob(rootDir, {
    jobId: 'laceyenterprises__agent-os-pr-1233-dirty-conflict',
    prNumber: 1233,
    lastHeartbeatAt: '2026-06-01T05:35:00.000Z',
  });
  const callOrder = [];

  const result = await applyPreSpawnLifecycleGate({
    rootDir,
    job: {
      ...job,
      baseBranch: 'main',
      branch: 'feature/conflict',
      specRef: 'pipeline-stall-hardening@1fa49446d3b0',
    },
    jobPath,
    workspaceDir,
    promptPath,
    baseBranch: 'main',
    resolvePRLifecycleImpl: async () => ({
      source: 'live',
      prState: 'open',
      mergeStateStatus: 'DIRTY',
    }),
    execFileImpl: async (cmd, args) => {
      callOrder.push(['exec', cmd, ...args]);
      return { stdout: '', stderr: '' };
    },
    dirtyMergeImpl: async () => ({
      outcome: 'conflict',
      error: Object.assign(new Error('Automatic merge failed'), { stderr: 'CONFLICT (content): modules/worker-pool/lib/python/cwp_dispatch/goal_lineage.py' }),
      conflictedFiles: ['modules/worker-pool/lib/python/cwp_dispatch/goal_lineage.py'],
    }),
    listConflictedFilesImpl: async () => {
      callOrder.push(['list-conflicts']);
      return ['modules/worker-pool/lib/python/cwp_dispatch/goal_lineage.py'];
    },
    now: () => '2026-06-01T05:02:00.000Z',
  });

  assert.equal(result.action, 'continue');
  assert.equal(result.reason, 'dirty-conflict-hammer');
  assert.deepEqual(callOrder, []);
  const prompt = readFileSync(promptPath, 'utf8');
  assert.match(prompt, /DIRTY PR Conflict Remediation HAMMER/);
  assert.match(prompt, /git merge origin\/main/);
  assert.match(prompt, /Never use `-X ours`/);
  assert.match(prompt, /projects\/pipeline-stall-hardening\/SPEC\.md/);
  assert.match(prompt, /modules\/worker-pool\/AGENTS\.md/);
  assert.match(prompt, /modules\/worker-pool\/SPEC\.md/);
  assert.match(prompt, /recreate the conflicted working tree first/);
  const persisted = readJobAtPath(jobPath);
  assert.equal(persisted.remediationWorker?.dirtyMergeResolution?.outcome, 'conflict-hammer-dispatch');
  assert.deepEqual(persisted.remediationWorker?.dirtyMergeResolution?.specsConsulted.sort(), [
    'modules/worker-pool/AGENTS.md',
    'modules/worker-pool/SPEC.md',
    'projects/pipeline-stall-hardening/SPEC.md',
  ].sort());
});

test('applyPreSpawnLifecycleGate: DIRTY conflict with missing specs escalates without prompt overwrite', async () => {
  const rootDir = makeRoot();
  const workspaceDir = path.join(rootDir, 'workspace');
  mkdirSync(path.join(workspaceDir, '.git'), { recursive: true });
  const promptPath = path.join(rootDir, 'prompt.md');
  writeFileSync(promptPath, 'original prompt\n', 'utf8');
  const { job, jobPath } = seedInProgressJob(rootDir, {
    jobId: 'laceyenterprises__agent-os-pr-1234-dirty-missing-spec',
    prNumber: 1234,
    lastHeartbeatAt: '2026-06-01T05:35:00.000Z',
  });

  const result = await applyPreSpawnLifecycleGate({
    rootDir,
    job: { ...job, baseBranch: 'main', branch: 'feature/conflict', specRef: 'missing-project@abc123' },
    jobPath,
    workspaceDir,
    promptPath,
    baseBranch: 'main',
    resolvePRLifecycleImpl: async () => ({
      source: 'live',
      prState: 'open',
      mergeStateStatus: 'DIRTY',
    }),
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    dirtyMergeImpl: async () => ({
      outcome: 'conflict',
      error: Object.assign(new Error('Automatic merge failed'), { stderr: 'CONFLICT (content)' }),
      conflictedFiles: ['modules/unknown/lib/file.py'],
    }),
    listConflictedFilesImpl: async () => ['modules/unknown/lib/file.py'],
    now: () => '2026-06-01T05:02:00.000Z',
  });

  assert.equal(result.action, 'stopped');
  assert.equal(result.reason, 'dirty-conflict-spec-context-missing');
  assert.equal(readFileSync(promptPath, 'utf8'), 'original prompt\n');
  const stoppedPath = path.join(getFollowUpJobDir(rootDir, 'stopped'), path.basename(jobPath));
  const stoppedJob = readJobAtPath(stoppedPath);
  assert.equal(stoppedJob.remediationPlan?.stop?.code, 'dirty-conflict-spec-context-missing');
  assert.deepEqual(stoppedJob.failure, {
    code: 'dirty-conflict-spec-context-missing',
    message: 'Remediation worker did not spawn because DIRTY conflict ownership lacks complete spec context: PR spec missing-project@abc123, modules/unknown SPEC.md.',
  });
  assert.equal(stoppedJob.remediationWorker?.dirtyMergeResolution?.outcome, 'conflict-spec-context-missing');
  assert.equal(stoppedJob.remediationWorker?.dirtyMergeResolution?.specsConsulted.length, 0);
});

test('attemptDirtyMerge retries transient fetch failures before merging and pushing', async () => {
  const rootDir = makeRoot();
  const workspaceDir = path.join(rootDir, 'workspace');
  mkdirSync(path.join(workspaceDir, '.git'), { recursive: true });
  const calls = [];

  const result = await attemptDirtyMerge({
    workspaceDir,
    baseBranch: 'main',
    branch: 'feature/retry-fetch',
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (args.includes('fetch') && calls.filter((call) => call.args.includes('fetch')).length === 1) {
        const err = new Error('TLS handshake timeout');
        err.stderr = 'TLS handshake timeout';
        throw err;
      }
      return { stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(result.outcome, 'clean-merged');
  assert.equal(result.fetch.attempts, 2);
  assert.deepEqual(calls.map((call) => call.args[2]), [
    'fetch',
    'fetch',
    'worktree',
    'merge',
    'push',
    'worktree',
  ]);
  const fetchArgs = calls[1].args;
  assert.ok(fetchArgs.some((arg) => arg.includes('refs/heads/main')));
  assert.ok(fetchArgs.some((arg) => arg.includes('refs/heads/feature/retry-fetch')));
  const worktreeAdd = calls.find((call) => call.args[2] === 'worktree' && call.args.includes('add'));
  assert.ok(worktreeAdd.args.includes('--detach'));
  assert.ok(worktreeAdd.args.includes('origin/feature/retry-fetch'));
  const pushCall = calls.find((call) => call.args[2] === 'push');
  assert.notEqual(pushCall.args[1], workspaceDir, 'push runs from isolated worktree, not daemon checkout');
  assert.ok(calls.some((call) => call.args[2] === 'worktree' && call.args.includes('remove')));
});

test('attemptDirtyMerge retries fetch failures from unable-to-access and lock errors', async () => {
  const cases = [
    ['unable-access', 'fatal: unable to access https://github.com/laceyenterprises/agent-os.git: Could not resolve host: github.com'],
    ['index-lock', 'fatal: Unable to create .git/index.lock: File exists.'],
  ];

  for (const [name, stderr] of cases) {
    const rootDir = makeRoot();
    const workspaceDir = path.join(rootDir, 'workspace');
    mkdirSync(path.join(workspaceDir, '.git'), { recursive: true });
    const calls = [];

    const result = await attemptDirtyMerge({
      workspaceDir,
      baseBranch: 'main',
      branch: `feature/retry-fetch-${name}`,
      execFileImpl: async (cmd, args) => {
        calls.push({ cmd, args });
        if (args.includes('fetch') && calls.filter((call) => call.args.includes('fetch')).length === 1) {
          const err = new Error(stderr);
          err.stderr = stderr;
          throw err;
        }
        return { stdout: 'ok', stderr: '' };
      },
    });

    assert.equal(result.outcome, 'clean-merged');
    assert.equal(result.fetch.attempts, 2);
    assert.equal(calls.filter((call) => call.args.includes('fetch')).length, 2);
  }
});

test('attemptDirtyMerge retries transient worktree add failures before merging', async () => {
  const rootDir = makeRoot();
  const workspaceDir = path.join(rootDir, 'workspace');
  mkdirSync(path.join(workspaceDir, '.git'), { recursive: true });
  const calls = [];

  const result = await attemptDirtyMerge({
    workspaceDir,
    baseBranch: 'main',
    branch: 'feature/retry-worktree-add',
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[2] === 'worktree' && args.includes('add') && calls.filter((call) => call.args[2] === 'worktree' && call.args.includes('add')).length === 1) {
        const err = new Error('Unable to create .git/index.lock');
        err.stderr = 'fatal: Unable to create .git/index.lock: File exists.';
        throw err;
      }
      return { stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(result.outcome, 'clean-merged');
  assert.equal(result.worktreeAdd.attempts, 2);
  assert.equal(calls.filter((call) => call.args[2] === 'worktree' && call.args.includes('add')).length, 2);
});

test('attemptDirtyMerge preserves physical worktree when git worktree remove fails', async () => {
  const rootDir = makeRoot();
  const workspaceDir = path.join(rootDir, 'workspace');
  mkdirSync(path.join(workspaceDir, '.git'), { recursive: true });
  let worktreeDir = null;

  await assert.rejects(
    attemptDirtyMerge({
      workspaceDir,
      baseBranch: 'main',
      branch: 'feature/cleanup-failure',
      execFileImpl: async (cmd, args) => {
        if (args[2] === 'worktree' && args.includes('add')) {
          worktreeDir = args[5];
          mkdirSync(worktreeDir, { recursive: true });
          writeFileSync(path.join(worktreeDir, '.git'), 'gitdir: ../.git/worktrees/cleanup-failure\n', 'utf8');
          return { stdout: 'ok', stderr: '' };
        }
        if (args[2] === 'worktree' && args.includes('remove')) {
          const err = new Error('permission denied removing worktree');
          err.stderr = 'fatal: validation failed, cannot remove worktree';
          throw err;
        }
        return { stdout: 'ok', stderr: '' };
      },
    }),
    /permission denied removing worktree/
  );

  assert.ok(worktreeDir, 'captured worktree dir');
  assert.equal(existsSync(path.dirname(worktreeDir)), true, 'parent temp dir is preserved for git metadata-safe cleanup');
  rmSync(path.dirname(worktreeDir), { recursive: true, force: true });
});

test('attemptDirtyMerge captures conflicts from isolated worktree and removes it', async () => {
  const rootDir = makeRoot();
  const workspaceDir = path.join(rootDir, 'workspace');
  mkdirSync(path.join(workspaceDir, '.git'), { recursive: true });
  const calls = [];

  const result = await attemptDirtyMerge({
    workspaceDir,
    baseBranch: 'main',
    branch: 'feature/conflict',
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[2] === 'merge') {
        const err = new Error('Automatic merge failed');
        err.stderr = 'CONFLICT (content): Merge conflict in modules/worker-pool/index.js';
        throw err;
      }
      if (args[2] === 'diff') {
        return { stdout: 'modules/worker-pool/index.js\n', stderr: '' };
      }
      return { stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(result.outcome, 'conflict');
  assert.deepEqual(result.conflictedFiles, ['modules/worker-pool/index.js']);
  assert.ok(calls.some((call) => call.args[2] === 'worktree' && call.args.includes('add')));
  assert.ok(calls.some((call) => call.args[2] === 'diff'));
  assert.ok(calls.some((call) => call.args[2] === 'worktree' && call.args.includes('remove')));
});

test('attemptDirtyMerge retries transient local merge lock failures', async () => {
  const rootDir = makeRoot();
  const workspaceDir = path.join(rootDir, 'workspace');
  mkdirSync(path.join(workspaceDir, '.git'), { recursive: true });
  const calls = [];

  const result = await attemptDirtyMerge({
    workspaceDir,
    baseBranch: 'main',
    branch: 'feature/retry-merge',
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[2] === 'merge' && calls.filter((call) => call.args[2] === 'merge').length === 1) {
        const err = new Error('Unable to create .git/index.lock');
        err.stderr = 'fatal: Unable to create .git/index.lock: File exists.';
        throw err;
      }
      return { stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(result.outcome, 'clean-merged');
  assert.equal(result.merge.attempts, 2);
  assert.equal(calls.filter((call) => call.args[2] === 'merge').length, 2);
});

test('attemptDirtyMerge does not classify branch-name conflict text as a merge conflict', async () => {
  const rootDir = makeRoot();
  const workspaceDir = path.join(rootDir, 'workspace');
  mkdirSync(path.join(workspaceDir, '.git'), { recursive: true });
  const calls = [];

  const result = await attemptDirtyMerge({
    workspaceDir,
    baseBranch: 'main',
    branch: 'feature/conflict-retry-merge',
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[2] === 'merge' && calls.filter((call) => call.args[2] === 'merge').length === 1) {
        const err = new Error("Command failed: git merge origin/main on feature/conflict-retry-merge");
        err.stderr = 'fatal: Unable to create .git/index.lock: File exists.';
        throw err;
      }
      return { stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(result.outcome, 'clean-merged');
  assert.equal(result.merge.attempts, 2);
  assert.equal(calls.filter((call) => call.args[2] === 'merge').length, 2);
});

test('resolveDirtyConflictSpecContext skips malformed project plans while finding later module specs', async () => {
  const repoRoot = makeRoot();
  mkdirSync(path.join(repoRoot, 'projects', 'aaa-bad'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'projects', 'aaa-bad', 'plan.json'), '{not-json', 'utf8');
  mkdirSync(path.join(repoRoot, 'projects', 'zzz-worker-domain'), { recursive: true });
  writeFileSync(
    path.join(repoRoot, 'projects', 'zzz-worker-domain', 'plan.json'),
    JSON.stringify({ notes: ['covers modules/worker-pool runtime'] }),
    'utf8'
  );
  writeFileSync(
    path.join(repoRoot, 'projects', 'zzz-worker-domain', 'SPEC.md'),
    '# Worker Domain Spec\n',
    'utf8'
  );

  const context = await resolveDirtyConflictSpecContext({
    repoRoot,
    job: {},
    conflictedFiles: ['modules/worker-pool/lib/python/cwp_dispatch/goal_lineage.py'],
  });

  assert.deepEqual(context.missing, ['PR specRef']);
  assert.deepEqual(context.entries.map((entry) => entry.path), ['projects/zzz-worker-domain/SPEC.md']);
});

test('resolveDirtyConflictSpecContext reports entries omitted by the spec cap', async () => {
  const repoRoot = makeRoot();
  mkdirSync(path.join(repoRoot, 'projects', 'pipeline-stall-hardening'), { recursive: true });
  writeFileSync(
    path.join(repoRoot, 'projects', 'pipeline-stall-hardening', 'SPEC.md'),
    '# Pipeline Stall Hardening\n',
    'utf8'
  );
  mkdirSync(path.join(repoRoot, 'modules', 'worker-pool'), { recursive: true });
  writeFileSync(
    path.join(repoRoot, 'modules', 'worker-pool', 'AGENTS.md'),
    '# Worker Pool Agents\n',
    'utf8'
  );
  writeFileSync(
    path.join(repoRoot, 'modules', 'worker-pool', 'SPEC.md'),
    '# Worker Pool Spec\n',
    'utf8'
  );

  const context = await resolveDirtyConflictSpecContext({
    repoRoot,
    job: { specRef: 'pipeline-stall-hardening@abc123' },
    conflictedFiles: ['modules/worker-pool/lib/python/cwp_dispatch/goal_lineage.py'],
    cap: 1,
  });

  assert.equal(context.ok, false);
  assert.deepEqual(context.entries.map((entry) => entry.path), ['projects/pipeline-stall-hardening/SPEC.md']);
  assert.match(context.missing.join('\n'), /module-agents modules\/worker-pool\/AGENTS\.md omitted by DIRTY conflict spec cap \(1\)/);
  assert.match(context.missing.join('\n'), /module-spec modules\/worker-pool\/SPEC\.md omitted by DIRTY conflict spec cap \(1\)/);
});

test('pushDirtyMergeWithRetry retries transient push failures but fails terminal auth errors', async () => {
  const calls = [];
  const transientResult = await pushDirtyMergeWithRetry({
    workspaceDir: '/tmp/workspace',
    branch: 'feature/retry',
    retryDelaysMs: [1, 1],
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (calls.length === 1) {
        const err = new Error('TLS handshake timeout');
        err.stderr = 'TLS handshake timeout';
        throw err;
      }
      return { stdout: 'ok', stderr: '' };
    },
  });
  assert.equal(transientResult.attempts, 2);
  assert.equal(calls.length, 2);

  let terminalErr = null;
  try {
    await pushDirtyMergeWithRetry({
      workspaceDir: '/tmp/workspace',
      branch: 'feature/retry',
      retryDelaysMs: [1, 1],
      execFileImpl: async () => {
        const err = new Error('Permission denied');
        err.stderr = 'ERROR: Permission to repo denied';
        throw err;
      },
    });
  } catch (err) {
    terminalErr = err;
  }
  assert.match(terminalErr?.message, /Permission denied/);
  assert.equal(terminalErr?.dirtyPushAttempts, 1);
});

test('LABELGATE-01: final pre-spawn gate allows repair of a guarded change', async t => {
  const rootDir = makeRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const workspaceDir = path.join(rootDir, 'workspace');
  mkdirSync(path.join(workspaceDir, '.git'), { recursive: true });
  const reviewBody = '## Blocking Issues\n- **Accidental submodule bump**: Restore tools/example to the base pointer.\n\n## Verdict\nRequest changes';
  const { job, jobPath } = seedInProgressJob(rootDir, { jobUpdates: { revisionRef: 'label-head', reviewBody } });
  const lifecycle = { source: 'live', prState: 'open', headSha: 'label-head', mergeStateStatus: 'DIRTY',
    statusCheckRollup: [{ name: 'submodule-pointer-gate', conclusion: 'FAILURE' }] };
  let repaired = false;
  const result = await applyPreSpawnLifecycleGate({ rootDir, job, jobPath, workspaceDir,
    baseBranch: 'main', resolvePRLifecycleImpl: async () => lifecycle,
    dirtyMergeImpl: async () => { repaired = true; return { outcome: 'clean-merged', push: { attempts: 1 } }; },
    stopConsumedJobWithCommentImpl: async () => { throw new Error('review repair must not stop on CI labels'); },
    log: { log() {}, warn() {}, error() {} },
  });
  assert.equal(result.action, 'continue');
  assert.equal(result.reason, 'dirty-clean-merged');
  assert.equal(repaired, true);
  assert.equal(readJobAtPath(jobPath).reviewBody, reviewBody);
});

// Synthetic REMLINK-01 fixtures are deliberately independent of production identities.
async function seedRemlink(t, { published = true, startHead = 'a'.repeat(40), roundNumber = 1 } = {}) {
  const rootDir = makeRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const workspaceDir = path.join(rootDir, 'synthetic-workspace');
  mkdirSync(workspaceDir);
  const git = args => execFileSync('git', ['-C', workspaceDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--quiet']);
  git(['-c', 'user.name=Synthetic Worker', '-c', 'user.email=synthetic@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--allow-empty',
    '-m', 'Synthetic remediation\n\nWorker-Job-Id: fixture__repo-pr-1-synthetic-remediation']);
  const head = git(['rev-parse', 'HEAD']).trim();
  const spawnedAt = '2026-01-01T00:00:00.000Z';
  const seeded = seedInProgressJob(rootDir, { jobId: 'fixture__repo-pr-1-synthetic-remediation', repo: 'fixture/repo', prNumber: 1,
    claimedAt: spawnedAt, spawnedAt, lastHeartbeatAt: spawnedAt,
    jobUpdates: { revisionRef: startHead, workspaceDir },
    plan: { currentRound: roundNumber, maxRounds: 2, rounds: [{ round: roundNumber, state: 'spawned', spawnedAt,
      startHeadSha: startHead, ...(published ? { publishedHeadSha: head } : {}) }] } });
  const { completeWorkerPublishedHead } = await import('../src/remediation-published-head.mjs');
  let followOns = 0;
  const completePublishedHeadImpl = args => completeWorkerPublishedHead({ ...args,
    requestReviewRereviewImpl: () => {
      const completedPath = path.join(getFollowUpJobDir(rootDir, 'completed'), path.basename(seeded.jobPath));
      const completed = readJobAtPath(completedPath);
      assert.equal(completed.status, 'completed', 'terminal write must precede follow-on');
      const round = completed.remediationPlan.rounds.find(entry => Number(entry.round) === Number(roundNumber));
      assert.deepEqual(round.completion, completed.completion);
      assert.equal(round.completion.source, 'worker-published-head-recovery');
      assert.equal(round.completion.publishEvidence, 'workspace-worker-job-trailer');
      followOns++; return { triggered: true, status: 'pending' };
    },
    requestRereviewWakeImpl: () => ({ requested: true }),
  });
  return { ...seeded, rootDir, startHead, head, completePublishedHeadImpl, followOns: () => followOns };
}

function writeRemlinkPublishReply(f) {
  const replyPath = path.join(f.rootDir, 'synthetic-reply.json');
  writeFileSync(replyPath, JSON.stringify({ kind: 'adversarial-review-remediation-reply', schemaVersion: 1,
    jobId: f.job.jobId, repo: f.job.repo, prNumber: f.job.prNumber, outcome: 'completed',
    summary: `Pushed commit ${f.head}`, validation: ['synthetic validation'], addressed: [], pushback: [],
    blockers: [], reReview: { requested: true, reason: 'Synthetic remediation completed' } }));
  f.job.remediationWorker.replyPath = replyPath;
  writeFollowUpJob(f.jobPath, f.job);
  return replyPath;
}

test('REMLINK-01 J2 quiet output settles its published head once instead of reclaiming', async t => {
  const f = await seedRemlink(t, { published: false });
  const replyPath = writeRemlinkPublishReply(f);
  utimesSync(replyPath, new Date('2026-01-01T00:12:00.000Z'), new Date('2026-01-01T00:12:00.000Z'));
  const outputPath = path.join(f.rootDir, 'synthetic-output.txt');
  writeFileSync(outputPath, 'Synthetic final output');
  utimesSync(outputPath, new Date('2026-01-01T00:13:00.000Z'), new Date('2026-01-01T00:13:00.000Z'));
  f.job.remediationWorker.outputPath = outputPath;
  writeFollowUpJob(f.jobPath, f.job);
  const nowMs = Date.parse('2026-01-01T00:24:00.000Z');
  const args = { rootDir: f.rootDir, nowMs, thresholdMs: 600_000, readWorkerCpuImpl: () => 0, isWorkerRunning: () => true,
    resolvePRLifecycleImpl: async () => ({ source: 'live', prState: 'open', headSha: f.head }),
    completePublishedHeadImpl: f.completePublishedHeadImpl,
    processKill: () => { throw new Error('published job must not be signalled'); }, log: { log() {}, warn() {} } };
  const result = await sweepStuckInProgressClaims(args);
  assert.equal(result.completed, 1);
  assert.equal(result.requeued, 0);
  const completedPath = path.join(getFollowUpJobDir(f.rootDir, 'completed'), path.basename(f.jobPath));
  const completed = readJobAtPath(completedPath);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.remediationPlan.rounds[0].state, 'completed');
  assert.equal(completed.remediationPlan.rounds[0].startHeadSha, f.startHead);
  assert.equal(completed.remediationPlan.rounds[0].publishedHeadSha, f.head);
  assert.equal(completed.remediationPlan.rounds[0].resultingHeadSha, f.head);
  assert.deepEqual(completed.remediationPlan.rounds[0].reReview, completed.reReview);
  assert.equal(completed.reReview.triggered, true);
  assert.equal(completed.reReview.wake.requested, true);
  await sweepStuckInProgressClaims(args);
  assert.equal(f.followOns(), 1);
});

test('REMLINK-01 J3 second claim retains a force-publish round readable by the unchanged hammer proof', async t => {
  const f = await seedRemlink(t, { published: false, startHead: 'b'.repeat(40), roundNumber: 2 });
  writeRemlinkPublishReply(f);
  const { requeueInProgressFollowUpJobForRetry, claimNextFollowUpJob } = await import('../src/follow-up-jobs.mjs');
  const pending = requeueInProgressFollowUpJobForRetry({ rootDir: f.rootDir, jobPath: f.jobPath,
    allowDirectWorkerRetry: true, requeuedAt: '2026-01-01T00:45:00.000Z',
    retryAfterOverride: '2026-01-01T00:45:00.000Z', retryReason: 'synthetic restart' });
  assert.equal(pending.job.remediationPlan.rounds[0].spawnedAt, '2026-01-01T00:00:00.000Z');
  pending.job.remediationPlan.rounds[0].round = '2';
  writeFollowUpJob(pending.jobPath, pending.job);
  const claimed = claimNextFollowUpJob({ rootDir: f.rootDir, claimedAt: '2026-01-01T01:00:00.000Z' });
  assert.equal(claimed.job.remediationPlan.rounds.length, 1);
  assert.equal(claimed.job.remediationPlan.rounds[0].round, 2);
  assert.equal(claimed.job.remediationPlan.rounds[0].spawnedAt, '2026-01-01T00:00:00.000Z');
  const result = await applyPreSpawnLifecycleGate({ rootDir: f.rootDir, job: claimed.job, jobPath: claimed.jobPath,
    resolvePRLifecycleImpl: async () => ({ source: 'live', prState: 'open', headSha: f.head }),
    completePublishedHeadImpl: f.completePublishedHeadImpl, now: () => '2026-01-01T01:00:00.000Z' });
  assert.equal(result.action, 'completed');
  const { readCompletedRemediationRounds, fetchHammerHeadRange } = await import('../src/ama/hammer-head-validation.mjs');
  const rounds = await readCompletedRemediationRounds(f.rootDir, 'fixture/repo', 1);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].resultingHeadSha, f.head);
  const range = await fetchHammerHeadRange({ repo: 'fixture/repo', reviewedHead: f.startHead,
    currentHead: f.head, hammerBaseHead: f.head, remediationRounds: rounds,
    env: { OAUTH_BROKER_CODEX_AGENT_PROVIDER: 'github-app-synthetic-remediator' },
    get: async () => ({ status: 'diverged' }),
    loadTimelinePage: async () => ({ nodes: [{ __typename: 'HeadRefForcePushedEvent',
      beforeCommit: { oid: f.startHead }, afterCommit: { oid: f.head },
      actor: { __typename: 'Bot', login: 'synthetic-remediator[bot]' } }],
      pageInfo: { hasNextPage: false, endCursor: null } }),
  });
  assert.equal(range.proof, 'completed-remediation-round-chain');
});

test('REMLINK-01 an external head still gets the exact existing stale stop', async t => {
  const f = await seedRemlink(t, { published: false });
  const workspaceDir = path.join(f.rootDir, 'synthetic-external-workspace');
  mkdirSync(path.join(workspaceDir, '.git'), { recursive: true });
  f.job.remediationWorker.workspaceDir = workspaceDir;
  writeFollowUpJob(f.jobPath, f.job);
  const { lifecycleStopDecision } = await import('../src/follow-up-lifecycle.mjs');
  const lifecycle = { source: 'live', prState: 'open', headSha: f.head };
  const expected = lifecycleStopDecision(lifecycle, { repo: f.job.repo, prNumber: f.job.prNumber, site: 'consume', job: f.job });
  const result = await applyPreSpawnLifecycleGate({ rootDir: f.rootDir, job: f.job, jobPath: f.jobPath,
    resolvePRLifecycleImpl: async () => lifecycle, completePublishedHeadImpl: args => f.completePublishedHeadImpl({ ...args,
      execFileSyncImpl: (_command, gitArgs) => gitArgs.includes('symbolic-ref') ? 'refs/heads/synthetic-repair' : 'c'.repeat(40) }),
    now: () => '2026-01-01T01:00:00.000Z', postCommentImpl: async () => ({ posted: true }), log: { log() {}, warn() {} } });
  assert.equal(result.action, 'stopped');
  assert.equal(result.job.remediationPlan.stop.code, expected.stopCode);
  assert.equal(result.job.remediationPlan.stop.reason, expected.stopReason);
  assert.equal(f.followOns(), 0);
});

test('REMLINK-01 an alive worker with fresh output stays untouched despite a recorded publish', async t => {
  const f = await seedRemlink(t);
  const result = await sweepStuckInProgressClaims({ rootDir: f.rootDir,
    nowMs: Date.parse('2026-01-01T00:01:00.000Z'), isWorkerRunning: () => true,
    resolvePRLifecycleImpl: () => { throw new Error('fresh output must not resolve lifecycle'); },
    completePublishedHeadImpl: f.completePublishedHeadImpl });
  assert.equal(result.completed, 0);
  assert.equal(result.requeued, 0);
  assert.equal(existsSync(f.jobPath), true);
  assert.equal(f.followOns(), 0);
});

test('REMLINK-01 an exited worker with a recorded publish settles without waiting for stale output', async t => {
  const f = await seedRemlink(t);
  const result = await sweepStuckInProgressClaims({ rootDir: f.rootDir,
    nowMs: Date.parse('2026-01-01T00:01:00.000Z'), isWorkerRunning: () => false,
    resolvePRLifecycleImpl: async () => ({ source: 'live', prState: 'open', headSha: f.head }),
    completePublishedHeadImpl: f.completePublishedHeadImpl });
  assert.equal(result.completed, 1);
  assert.equal(result.requeued, 0);
  assert.equal(f.followOns(), 1);
});

test('REMLINK-01 a stale alive worker is reclaimed when reply reconciliation is still active', async t => {
  const f = await seedRemlink(t, { published: false });
  const replyPath = path.join(f.rootDir, 'synthetic-reply.json');
  writeFileSync(replyPath, JSON.stringify({ outcome: 'synthetic-result' }));
  utimesSync(replyPath, new Date('2026-01-01T00:01:00.000Z'), new Date('2026-01-01T00:01:00.000Z'));
  f.job.remediationWorker.replyPath = replyPath;
  writeFollowUpJob(f.jobPath, f.job);
  let reconciles = 0;
  const result = await sweepStuckInProgressClaims({ rootDir: f.rootDir,
    nowMs: Date.parse('2026-01-01T00:24:00.000Z'), isWorkerRunning: () => true, readWorkerCpuImpl: () => 0,
    resolvePRLifecycleImpl: async () => ({ source: 'live', prState: 'open', headSha: f.startHead }),
    reconcileFollowUpJobImpl: async () => { reconciles++; return { action: 'active' }; },
    sendWorkerSignalImpl: successfulStaleSignal, postCommentImpl: async () => ({ posted: true }),
    log: { log() {}, warn() {} } });
  assert.equal(reconciles, 1);
  assert.equal(result.signalled, 1);
  assert.equal(result.requeued, 1);
});

test('REMLINK-01 reply and fetched workspace tips require exact job provenance', async t => {
  const f = await seedRemlink(t, { published: false });
  const { findWorkerPublishedHead } = await import('../src/remediation-published-head.mjs');
  writeRemlinkPublishReply(f);
  const probe = (tip, message = '') => findWorkerPublishedHead({ rootDir: f.rootDir, job: f.job, headSha: f.head,
    execFileSyncImpl: () => `${tip}\n${message}\n` });
  assert.equal(probe(f.head), null, 'pulling a foreign head and naming it in a reply proves nothing');
  assert.equal(probe(f.head, 'fix\n\nWorker-Job-Id: another-job'), null);
  assert.equal(probe(f.head, `Worker-Job-Id: ${f.job.jobId}\n\nquoted trailer in body`), null);
  assert.equal(probe(f.head, `fix\n\nWorker-Job-Id: ${f.job.jobId}\nWorker-Job-Id: another-job`), null);
  const message = `fix\n\nWorker-Job-Id: ${f.job.jobId}`;
  assert.equal(probe('c'.repeat(40), message), null, 'the commit must be the live head');
  assert.equal(probe(f.head, message).source, 'workspace-worker-job-trailer');
  f.job.remediationPlan.rounds[0].startHeadSha = f.head;
  assert.equal(probe(f.head, message), null, 'a previously observed head is not a worker publication');
});

test('REMLINK-01 recovery normalizes hexadecimal heads and serialized round numbers', async t => {
  const f = await seedRemlink(t);
  const { findWorkerPublishedHead, hasWorkerPublishArtifacts } = await import('../src/remediation-published-head.mjs');
  for (const status of ['in_progress', 'pending']) {
    f.job.status = status;
    f.job.remediationPlan.currentRound = status === 'pending' ? '0' : '1';
    f.job.remediationPlan.rounds[0].round = '1';
    const evidence = findWorkerPublishedHead({ rootDir: f.rootDir, job: f.job, headSha: f.head.toUpperCase() });
    assert.equal(evidence.headSha, f.head);
    assert.equal(hasWorkerPublishArtifacts({ rootDir: f.rootDir, job: f.job, includeWorkspace: false }), true);
  }
  writeFollowUpJob(f.jobPath, f.job);
  const completed = f.completePublishedHeadImpl({ rootDir: f.rootDir, jobPath: f.jobPath, headSha: f.head.toUpperCase() });
  assert.equal(completed.job.remediationPlan.rounds[0].publishedHeadSha, f.head);
  assert.equal(completed.job.remediationPlan.rounds[0].resultingHeadSha, f.head);
  assert.deepEqual(completed.job.remediationPlan.rounds[0].reReview, completed.job.reReview);
  for (const field of ['startHeadSha', 'revisionRef']) {
    const job = structuredClone(f.job);
    if (field === 'startHeadSha') job.remediationPlan.rounds[0][field] = f.head.toUpperCase();
    else job[field] = f.head.toUpperCase();
    assert.equal(findWorkerPublishedHead({ rootDir: f.rootDir, job, headSha: f.head }), null,
      `${field} must still exclude a previously observed head regardless of case`);
  }
});

test('REMLINK-01 terminal re-review update tolerates an existing completed record without its round', async t => {
  const f = await seedRemlink(t);
  const completedPath = path.join(getFollowUpJobDir(f.rootDir, 'completed'), path.basename(f.jobPath));
  mkdirSync(path.dirname(completedPath), { recursive: true });
  writeFollowUpJob(completedPath, { ...f.job, status: 'completed',
    remediationPlan: { ...f.job.remediationPlan, rounds: [] } });
  const { completeWorkerPublishedHead } = await import('../src/remediation-published-head.mjs');
  const completed = completeWorkerPublishedHead({ rootDir: f.rootDir, jobPath: f.jobPath, headSha: f.head,
    requestReviewRereviewImpl: () => ({ triggered: true, status: 'pending' }),
    requestRereviewWakeImpl: () => ({ requested: true }) });
  assert.equal(completed.alreadyTerminal, true);
  assert.deepEqual(completed.job.remediationPlan.rounds, []);
  assert.equal(readJobAtPath(completedPath).reReview.triggered, true);
  assert.equal(readJobAtPath(completedPath).reReview.wake.requested, true);
  assert.equal(existsSync(f.jobPath), false);
});

test('REMLINK-01 pending active-defer release completes a retained publish instead of superseding it', async t => {
  const f = await seedRemlink(t);
  const { requeueInProgressFollowUpJobForRetry } = await import('../src/follow-up-jobs.mjs');
  const { stopTerminalPendingFollowUpJob } = await import('../src/follow-up-active-defer.mjs');
  const pending = requeueInProgressFollowUpJobForRetry({ rootDir: f.rootDir, jobPath: f.jobPath,
    allowDirectWorkerRetry: true, requeuedAt: '2026-01-01T00:24:00.000Z', retryReason: 'synthetic restart' });
  const result = stopTerminalPendingFollowUpJob({ rootDir: f.rootDir,
    latest: { job: pending.job, jobPath: pending.jobPath }, currentRevisionRef: f.head,
    stoppedAt: '2026-01-01T00:25:00.000Z',
    markStoppedImpl: () => { throw new Error('own publish must not be superseded'); } });
  assert.equal(result.job.status, 'completed');
  assert.equal(result.job.remediationPlan.rounds[0].resultingHeadSha, f.head);
  assert.equal(result.job.remediationPlan.currentRound, 1);
});

test('REMLINK-01 restart reconciliation recovers publish evidence without top-level worker metadata', async t => {
  const f = await seedRemlink(t);
  f.job.remediationWorker = null;
  writeFollowUpJob(f.jobPath, f.job);
  const { reconcileFollowUpJob } = await import('../src/follow-up-remediation.mjs');
  let followOns = 0;
  const result = await reconcileFollowUpJob({ rootDir: f.rootDir, job: f.job, jobPath: f.jobPath,
    now: () => '2026-01-01T01:00:00.000Z',
    resolvePRLifecycleImpl: async () => ({ source: 'live', prState: 'open', headSha: f.head }),
    requestReviewRereviewImpl: () => { followOns++; return { triggered: true, status: 'pending' }; },
    requestRereviewWakeImpl: () => ({ requested: true }) });
  assert.equal(result.action, 'completed');
  assert.equal(result.job.remediationPlan.rounds[0].resultingHeadSha, f.head);
  assert.equal(followOns, 1);
});

test('REMLINK-01 an older published round is not a result for a fresh unspawned claim', async t => {
  const f = await seedRemlink(t);
  f.job.remediationWorker = null;
  f.job.remediationPlan.currentRound = 2;
  f.job.remediationPlan.rounds.push({ round: 2, state: 'claimed', startHeadSha: f.head,
    claimedAt: '2026-01-01T00:00:00.000Z' });
  writeFollowUpJob(f.jobPath, f.job);
  const result = await sweepStuckInProgressClaims({ rootDir: f.rootDir,
    nowMs: Date.parse('2026-01-01T00:01:00.000Z'), isWorkerRunning: () => false,
    resolvePRLifecycleImpl: () => { throw new Error('an older round must not make a fresh claim eligible for recovery'); } });
  assert.equal(result.completed, 0);
  assert.equal(result.requeued, 0);
  assert.equal(existsSync(f.jobPath), true);
});

test('REMLINK-01 a CI retry settles an independently proven worker publish instead of requeueing', async t => {
  const f = await seedRemlink(t, { published: false });
  const previousHqRoot = process.env.HQ_ROOT;
  const previousHqIntegration = process.env.ADV_WITH_HQ_INTEGRATION;
  delete process.env.HQ_ROOT;
  delete process.env.ADV_WITH_HQ_INTEGRATION;
  const previousRepliesRoot = process.env.ADV_REPLIES_ROOT;
  const previousWorkspaceRoot = process.env.ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT;
  const repliesRoot = path.join(f.rootDir, 'synthetic-replies');
  const workspaceRoot = path.join(f.rootDir, 'synthetic-workspaces');
  process.env.ADV_REPLIES_ROOT = repliesRoot;
  process.env.ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT = workspaceRoot;
  t.after(() => {
    if (previousHqRoot === undefined) delete process.env.HQ_ROOT;
    else process.env.HQ_ROOT = previousHqRoot;
    if (previousHqIntegration === undefined) delete process.env.ADV_WITH_HQ_INTEGRATION;
    else process.env.ADV_WITH_HQ_INTEGRATION = previousHqIntegration;
    if (previousRepliesRoot === undefined) delete process.env.ADV_REPLIES_ROOT;
    else process.env.ADV_REPLIES_ROOT = previousRepliesRoot;
    if (previousWorkspaceRoot === undefined) delete process.env.ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT;
    else process.env.ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT = previousWorkspaceRoot;
  });
  const originalReply = writeRemlinkPublishReply(f);
  const replyPath = path.join(repliesRoot, f.job.jobId, 'remediation-reply.json');
  mkdirSync(path.dirname(replyPath), { recursive: true });
  writeFileSync(replyPath, readFileSync(originalReply));
  f.job.baseBranch = 'main';
  f.job.remediationWorker.replyPath = replyPath;
  mkdirSync(workspaceRoot, { recursive: true });
  const relocatedWorkspace = path.join(workspaceRoot, f.job.jobId);
  renameSync(f.job.workspaceDir, relocatedWorkspace);
  f.job.workspaceDir = relocatedWorkspace;
  f.job.remediationWorker.workspaceDir = relocatedWorkspace;
  writeFollowUpJob(f.jobPath, f.job);
  const { reconcileFollowUpJob } = await import('../src/follow-up-remediation.mjs');
  let followOns = 0;
  const result = await reconcileFollowUpJob({ rootDir: f.rootDir, job: f.job, jobPath: f.jobPath,
    now: () => '2026-01-01T00:24:00.000Z', isWorkerRunning: () => false,
    resolvePRLifecycleImpl: async () => ({ source: 'live', prState: 'open', headSha: f.head }),
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    auditWorkspaceForContaminationImpl: async () => ({ suspect: [], error: null }),
    inspectRemediationCiRegressionImpl: async () => ({ state: 'failed', headSha: f.head,
      conclusion: 'FAILURE', failedChecks: [{ name: 'synthetic-check', conclusion: 'FAILURE' }], pendingChecks: [] }),
    requestReviewRereviewImpl: () => { followOns++; return { triggered: true, status: 'pending' }; },
    requestRereviewWakeImpl: () => ({ requested: true }),
    postCommentImpl: async () => ({ posted: false, reason: 'offline-fixture' }),
    log: { log() {}, warn() {}, error() {} } });
  assert.equal(result.action, 'completed', `${result.reason}: ${result.job?.failure?.message}`);
  assert.equal(result.job.remediationPlan.rounds[0].resultingHeadSha, f.head);
  assert.equal(result.job.remediationPlan.transientRetries, 0);
  assert.equal(existsSync(pendingPathFor(f.rootDir, f.jobPath)), false);
  assert.equal(followOns, 1);
});

test('REMLINK-01 external movement recorded at exit stays untrusted after retry and watcher sweep', async t => {
  const f = await seedRemlink(t, { published: false });
  const git = args => execFileSync('git', ['-C', f.job.workspaceDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['-c', 'user.name=External Actor', '-c', 'user.email=external@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--allow-empty', '-m', 'External push']);
  f.head = git(['rev-parse', 'HEAD']).trim();
  // Even a reply naming the foreign head cannot provide authorship.
  writeRemlinkPublishReply(f);
  const { findWorkerPublishedHead } = await import('../src/remediation-published-head.mjs');
  assert.equal(findWorkerPublishedHead({ rootDir: f.rootDir, job: f.job, headSha: f.head }), null);
  const { settleInfrastructureRemediationRound } = await import('../src/remediation-round-accounting.mjs');
  const settlement = await settleInfrastructureRemediationRound({ rootDir: f.rootDir,
    job: f.job, jobPath: f.jobPath, worker: f.job.remediationWorker,
    liveness: { state: 'exited' }, lifecycle: { source: 'live', headSha: f.head }, lifecycleStop: null });
  assert.equal(settlement, null);
  assert.equal(readJobAtPath(f.jobPath).remediationPlan.rounds[0].publishedHeadSha, f.head);
  const { requeueInProgressFollowUpJobForRetry } = await import('../src/follow-up-jobs.mjs');
  const pending = requeueInProgressFollowUpJobForRetry({ rootDir: f.rootDir, jobPath: f.jobPath,
    allowDirectWorkerRetry: true, requeuedAt: '2026-01-01T00:24:00.000Z', retryReason: 'synthetic restart' });
  assert.equal(findWorkerPublishedHead({ rootDir: f.rootDir, job: pending.job, headSha: f.head }), null);
  const { shouldDeferReviewForActiveFollowUp } = await import('../src/follow-up-active-defer.mjs');
  const result = shouldDeferReviewForActiveFollowUp({ rootDir: f.rootDir, repo: f.job.repo, prNumber: 1,
    currentRevisionRef: f.head, nowMs: Date.parse('2026-01-01T00:25:00.000Z') });
  assert.equal(result.latestJobStatus, 'stopped');
  assert.equal(result.releaseReason, 'revision-superseded');
  const { readCompletedRemediationRounds } = await import('../src/ama/hammer-head-validation.mjs');
  assert.deepEqual(await readCompletedRemediationRounds(f.rootDir, f.job.repo, 1), []);
});

test('REMLINK-01 an earlier attempt reply neither bypasses age gates nor prevents stale reclaim', async t => {
  const f = await seedRemlink(t, { published: false });
  const replyPath = writeRemlinkPublishReply(f);
  utimesSync(replyPath, new Date('2025-12-31T23:59:00.000Z'), new Date('2025-12-31T23:59:00.000Z'));
  const { findWorkerPublishedHead, hasWorkerPublishArtifacts } = await import('../src/remediation-published-head.mjs');
  assert.equal(hasWorkerPublishArtifacts({ rootDir: f.rootDir, job: f.job, includeWorkspace: false }), false);
  assert.equal(findWorkerPublishedHead({ rootDir: f.rootDir, job: f.job, headSha: f.head }).reply, null);
  const args = { rootDir: f.rootDir, readWorkerCpuImpl: () => 0,
    resolvePRLifecycleImpl: async () => ({ source: 'live', prState: 'open', headSha: f.startHead }),
    reconcileFollowUpJobImpl: () => { throw new Error('earlier attempt reply must be ignored'); },
    sendWorkerSignalImpl: successfulStaleSignal, postCommentImpl: async () => ({ posted: true }),
    log: { log() {}, warn() {} } };
  const fresh = await sweepStuckInProgressClaims({ ...args,
    nowMs: Date.parse('2026-01-01T00:01:00.000Z'), isWorkerRunning: () => false });
  assert.equal(fresh.requeued, 0, 'an old reply cannot bypass the age threshold');
  const stale = await sweepStuckInProgressClaims({ ...args,
    nowMs: Date.parse('2026-01-01T00:24:00.000Z'), isWorkerRunning: () => true });
  assert.equal(stale.completed, 0);
  assert.equal(stale.signalled, 1);
  assert.equal(stale.requeued, 1);
});

test('REMLINK-01 a failed terminal write cannot request follow-on review', async t => {
  const f = await seedRemlink(t);
  const completedPath = path.join(getFollowUpJobDir(f.rootDir, 'completed'), path.basename(f.jobPath));
  mkdirSync(completedPath, { recursive: true });
  assert.throws(() => f.completePublishedHeadImpl({ rootDir: f.rootDir, jobPath: f.jobPath, headSha: f.head }));
  assert.equal(f.followOns(), 0);
});

test('REMLINK-01 comment-only recovery writes terminal state before waking closure', async t => {
  const f = await seedRemlink(t);
  f.job.finalRound = 'comment-only';
  writeFollowUpJob(f.jobPath, f.job);
  const { completeWorkerPublishedHead } = await import('../src/remediation-published-head.mjs');
  let wakes = 0;
  const completed = completeWorkerPublishedHead({ rootDir: f.rootDir, jobPath: f.jobPath, headSha: f.head,
    requestReviewRereviewImpl: () => assert.fail('final round must not request re-review'),
    requestWatcherWakeImpl: () => {
      const completedPath = path.join(getFollowUpJobDir(f.rootDir, 'completed'), path.basename(f.jobPath));
      const completed = readJobAtPath(completedPath);
      assert.equal(completed.status, 'completed');
      assert.deepEqual(completed.remediationPlan.rounds[0].completion, completed.completion);
      assert.equal(completed.completion.source, 'worker-published-head-recovery');
      assert.equal(completed.completion.publishEvidence, 'workspace-worker-job-trailer');
      wakes++;
    } });
  assert.equal(completed.job.reReview.suppressed, 'comment-only-final-round');
  assert.equal(wakes, 1);
});
