import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';

import * as followUpJobs from './follow-up-jobs.mjs';
import { findLatestFollowUpJob } from './operator-retrigger-helpers.mjs';
import { isPgidAlive } from './process-group-identity.mjs';

const IN_PROGRESS_STUCK_THRESHOLD_MS_ENV = 'ADVERSARIAL_FOLLOW_UP_IN_PROGRESS_STUCK_THRESHOLD_MS';
const DEFAULT_IN_PROGRESS_STUCK_THRESHOLD_MS = 10 * 60 * 1000;
const STALE_HEARTBEAT_STOP_CODE = 'stale-heartbeat';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function isActiveFollowUpJob(job) {
  return followUpJobs.isActiveFollowUpJobStatus(job?.status);
}

function stopBudgetExhaustedPendingFollowUpJob({
  rootDir,
  latest,
  stoppedAt = new Date().toISOString(),
  markStoppedImpl = followUpJobs.markFollowUpJobStopped,
}) {
  const job = latest?.job;
  if (job?.status !== 'pending') {
    return null;
  }
  const currentRound = Number(job?.remediationPlan?.currentRound || 0);
  const maxRounds = Number(job?.remediationPlan?.maxRounds || 0);
  if (!Number.isFinite(currentRound) || !Number.isFinite(maxRounds) || maxRounds <= 0) {
    return null;
  }
  if (currentRound < maxRounds) {
    return null;
  }

  return markStoppedImpl({
    rootDir,
    jobPath: latest.jobPath,
    stoppedAt,
    stopCode: 'max-rounds-reached',
    sourceStatus: job.status,
    stopReason: `Reached max remediation rounds (${currentRound}/${maxRounds}) before reviewer defer.`,
  });
}

function normalizeRevisionRef(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function isSettledCleanFollowUpJob(job) {
  const nextAction = job?.remediationPlan?.nextAction;
  if (nextAction?.operatorOverride === true) return false;

  const action = job?.recommendedFollowUpAction || {};
  const actionType = String(action?.type ?? '').trim().toLowerCase();
  if (['settled-clean', 'no-remediation-required', 'none'].includes(actionType)) {
    return true;
  }

  if (!String(job?.reviewBody ?? '').trim()) {
    return false;
  }
  const classification = followUpJobs.classifyFollowUpCriticality(job.reviewBody);
  return classification.critical === false
    && (classification.verdict === 'comment-only' || classification.verdict === 'approved');
}

function stopTerminalPendingFollowUpJob({
  rootDir,
  latest,
  currentRevisionRef = null,
  stoppedAt = new Date().toISOString(),
  markStoppedImpl = followUpJobs.markFollowUpJobStopped,
}) {
  const job = latest?.job;
  if (job?.status !== 'pending') {
    return null;
  }

  const settledClean = isSettledCleanFollowUpJob(job);
  const jobRevisionRef = normalizeRevisionRef(job?.revisionRef);
  const headRevisionRef = normalizeRevisionRef(currentRevisionRef);
  const revisionSuperseded = Boolean(jobRevisionRef && headRevisionRef && jobRevisionRef !== headRevisionRef);
  if (!settledClean && !revisionSuperseded) {
    return null;
  }

  const releaseReason = settledClean && revisionSuperseded
    ? 'settled-clean-head-moved'
    : settledClean
    ? 'settled-clean'
    : 'revision-superseded';
  const reasonDetail = revisionSuperseded
    ? ` Job revision ${jobRevisionRef} is superseded by current head ${headRevisionRef}.`
    : '';

  return markStoppedImpl({
    rootDir,
    jobPath: latest.jobPath,
    stoppedAt,
    stopCode: releaseReason,
    sourceStatus: job.status,
    stopReason: `Released pending follow-up job before reviewer defer: ${releaseReason}.${reasonDetail}`,
    completion: settledClean
      ? {
          preview: 'Latest adversarial review verdict is settled cleanly; no remediation worker required.',
        }
      : undefined,
  });
}

function parseFollowUpTimestampMs(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveFollowUpStuckThresholdMs() {
  const raw = process.env[IN_PROGRESS_STUCK_THRESHOLD_MS_ENV];
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return DEFAULT_IN_PROGRESS_STUCK_THRESHOLD_MS;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function signalStaleFollowUpWorker({
  job,
  signal = 'SIGTERM',
  processKill = process.kill,
} = {}) {
  const worker = job?.worker || job?.remediationWorker || {};
  const processGroupId = positiveInteger(worker.processGroupId ?? worker.processId);
  const processId = positiveInteger(worker.processId);
  if (!processGroupId && !processId) {
    return { signalled: false, skipped: true, target: null, error: 'missing-worker-process-handle' };
  }
  if (processGroupId === process.pid || processId === process.pid) {
    return { signalled: false, skipped: false, target: null, error: 'refusing-to-signal-current-process' };
  }

  const targetId = processGroupId || processId;
  const target = {
    kind: processGroupId ? 'process-group' : 'process',
    id: targetId,
  };
  try {
    if (processGroupId) {
      if (!isPgidAlive(processGroupId, processKill)) {
        return { signalled: false, skipped: true, target, error: 'process-group-not-found' };
      }
      processKill(-processGroupId, signal);
      return { signalled: true, skipped: false, target, error: null };
    }
    processKill(processId, 0);
    processKill(processId, signal);
    return { signalled: true, skipped: false, target, error: null };
  } catch (err) {
    if (err?.code === 'ESRCH') {
      return { signalled: false, skipped: true, target, error: 'process-not-found' };
    }
    return { signalled: false, skipped: false, target, error: err?.message || String(err) };
  }
}

function resolveLatestFollowUpObservedAtMs(latest) {
  const job = latest?.job;
  const worker = job?.worker || job?.remediationWorker || {};
  const candidates = [
    ['lastWorkerArtifactProgressAt', job?.lastWorkerArtifactProgressAt],
    ['lastHeartbeatAt', job?.lastHeartbeatAt],
    ['worker.spawnedAt', worker?.spawnedAt],
    ['claimedAt', job?.claimedAt],
  ];
  let newest = null;
  for (const [source, value] of candidates) {
    const sourceMs = parseFollowUpTimestampMs(value);
    if (sourceMs !== null) {
      if (!newest || sourceMs > newest.sourceMs) {
        newest = { sourceMs, source };
      }
    }
  }
  if (newest) return newest;
  try {
    return { sourceMs: statSync(latest.jobPath).mtimeMs, source: 'mtime' };
  } catch {
    return { sourceMs: null, source: 'unavailable' };
  }
}

function stopStaleInProgressFollowUpJob({
  rootDir,
  latest,
  nowMs = Date.now(),
  thresholdMs = resolveFollowUpStuckThresholdMs(),
  markStoppedImpl = followUpJobs.markFollowUpJobStopped,
  signalWorkerImpl = signalStaleFollowUpWorker,
  log = console,
}) {
  const job = latest?.job;
  if (!['in_progress', 'inProgress', 'in-progress'].includes(String(job?.status || ''))) {
    return null;
  }
  const worker = job?.worker || job?.remediationWorker || {};
  if (worker?.dispatchMode === 'hq') {
    return null;
  }
  const { sourceMs, source } = resolveLatestFollowUpObservedAtMs(latest);
  if (sourceMs === null) {
    return null;
  }
  const ageMs = nowMs - sourceMs;
  if (ageMs <= thresholdMs) {
    return null;
  }
  const stoppedAt = new Date(nowMs).toISOString();
  const jobId = job?.jobId || basename(latest.jobPath);
  const stopReason =
    `Reclaimed orphaned in-progress claim ${jobId}: ${source} is ` +
    `${Math.round(ageMs / 1000)}s old (threshold=${Math.round(thresholdMs / 1000)}s).`;
  const staleReclaimSignal = typeof signalWorkerImpl === 'function'
    ? signalWorkerImpl({ job, requestedAt: stoppedAt })
    : { signalled: false, skipped: true, target: null, error: 'signal-worker-disabled' };
  if (!staleReclaimSignal?.signalled && !staleReclaimSignal?.skipped) {
    log?.warn?.(
      `[watcher] Refusing to release stale follow-up job ${jobId}: ` +
      `worker signal failed: ${staleReclaimSignal?.error || 'unknown'}`
    );
    return null;
  }

  return markStoppedImpl({
    rootDir,
    jobPath: latest.jobPath,
    stoppedAt,
    stopCode: STALE_HEARTBEAT_STOP_CODE,
    stopReason,
    sourceStatus: job.status,
    remediationWorker: {
      ...worker,
      state: 'reclaimed-stale-heartbeat',
      reclaimedAt: stoppedAt,
      reclaimReason: STALE_HEARTBEAT_STOP_CODE,
      reclaimAgeMs: ageMs,
      reclaimSource: source,
      staleReclaimSignal,
    },
  });
}

function shouldDeferReviewForActiveFollowUp({
  rootDir = ROOT,
  repo,
  prNumber,
  latestJobFinder = findLatestFollowUpJob,
  budgetSweepImpl = stopBudgetExhaustedPendingFollowUpJob,
  terminalPendingSweepImpl = stopTerminalPendingFollowUpJob,
  staleClaimSweepImpl = stopStaleInProgressFollowUpJob,
  markStoppedImpl = followUpJobs.markFollowUpJobStopped,
  currentRevisionRef = null,
  nowMs = Date.now(),
  log = console,
  staleSignalImpl = signalStaleFollowUpWorker,
}) {
  let latest = latestJobFinder(rootDir, { repo, prNumber });
  const budgetStopped = typeof budgetSweepImpl === 'function' ? budgetSweepImpl({
    rootDir,
    latest,
    stoppedAt: new Date(nowMs).toISOString(),
    markStoppedImpl,
  }) : null;
  if (budgetStopped) {
    return {
      defer: false,
      latestJobStatus: budgetStopped.job?.status || 'stopped',
      jobPath: budgetStopped.jobPath || null,
      jobId: budgetStopped.job?.jobId || latest?.job?.jobId || null,
      releasedTerminal: true,
      releaseReason: 'max-rounds-reached',
    };
  }

  const terminalStopped = typeof terminalPendingSweepImpl === 'function' ? terminalPendingSweepImpl({
    rootDir,
    latest,
    currentRevisionRef,
    stoppedAt: new Date(nowMs).toISOString(),
    markStoppedImpl,
  }) : null;
  if (terminalStopped) {
    const releaseReason = terminalStopped.job?.remediationPlan?.stop?.code || 'pending-terminal';
    log?.info?.(
      `[watcher] Released terminal follow-up job before reviewer defer` +
        `${terminalStopped.job?.jobId ? ` ${terminalStopped.job.jobId}` : ''}: ` +
        `releaseReason=${releaseReason}`
    );
    return {
      defer: false,
      latestJobStatus: terminalStopped.job?.status || 'stopped',
      jobPath: terminalStopped.jobPath || null,
      jobId: terminalStopped.job?.jobId || latest?.job?.jobId || null,
      releasedTerminal: true,
      releaseReason,
    };
  }

  if (typeof staleClaimSweepImpl === 'function') {
    const staleStopped = staleClaimSweepImpl({
      rootDir,
      latest,
      nowMs,
      markStoppedImpl,
      signalWorkerImpl: staleSignalImpl,
      log,
    });
    if (staleStopped) {
      latest = latestJobFinder(rootDir, { repo, prNumber });
    }
  }

  if (!isActiveFollowUpJob(latest?.job)) {
    return {
      defer: false,
      latestJobStatus: latest?.job?.status || null,
      jobPath: latest?.jobPath || null,
      jobId: latest?.job?.jobId || null,
      releasedTerminal: Boolean(latest?.job && !isActiveFollowUpJob(latest.job)),
      releaseReason: latest?.job?.remediationPlan?.stop?.code || null,
    };
  }
  return {
    defer: true,
    latestJobStatus: latest.job.status,
    jobPath: latest.jobPath || null,
    jobId: latest.job.jobId || null,
  };
}

export {
  shouldDeferReviewForActiveFollowUp,
  stopBudgetExhaustedPendingFollowUpJob,
  stopTerminalPendingFollowUpJob,
  stopStaleInProgressFollowUpJob,
  signalStaleFollowUpWorker,
};
