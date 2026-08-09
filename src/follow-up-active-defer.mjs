import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';

import {
  isActiveFollowUpJobStatus,
  markFollowUpJobStopped,
} from './follow-up-jobs.mjs';
import { findLatestFollowUpJob } from './operator-retrigger-helpers.mjs';

const IN_PROGRESS_STUCK_THRESHOLD_MS_ENV = 'ADVERSARIAL_FOLLOW_UP_IN_PROGRESS_STUCK_THRESHOLD_MS';
const DEFAULT_IN_PROGRESS_STUCK_THRESHOLD_MS = 10 * 60 * 1000;
const STALE_HEARTBEAT_STOP_CODE = 'stale-heartbeat';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function isActiveFollowUpJob(job) {
  return isActiveFollowUpJobStatus(job?.status);
}

function stopBudgetExhaustedPendingFollowUpJob({
  rootDir,
  latest,
  stoppedAt = new Date().toISOString(),
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

  return markFollowUpJobStopped({
    rootDir,
    jobPath: latest.jobPath,
    stoppedAt,
    stopCode: 'max-rounds-reached',
    sourceStatus: job.status,
    stopReason: `Reached max remediation rounds (${currentRound}/${maxRounds}) before reviewer defer.`,
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

function resolveLatestFollowUpObservedAtMs(latest) {
  const job = latest?.job;
  const candidates = [
    ['lastWorkerArtifactProgressAt', job?.lastWorkerArtifactProgressAt],
    ['lastHeartbeatAt', job?.lastHeartbeatAt],
    ['remediationWorker.spawnedAt', job?.remediationWorker?.spawnedAt],
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
}) {
  const job = latest?.job;
  if (!['in_progress', 'inProgress', 'in-progress'].includes(String(job?.status || ''))) {
    return null;
  }
  if (job?.remediationWorker?.dispatchMode === 'hq') {
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

  return markFollowUpJobStopped({
    rootDir,
    jobPath: latest.jobPath,
    stoppedAt,
    stopCode: STALE_HEARTBEAT_STOP_CODE,
    stopReason,
    sourceStatus: job.status,
    remediationWorker: {
      ...(job?.remediationWorker || {}),
      state: 'reclaimed-stale-heartbeat',
      reclaimedAt: stoppedAt,
      reclaimReason: STALE_HEARTBEAT_STOP_CODE,
      reclaimAgeMs: ageMs,
      reclaimSource: source,
    },
  });
}

function shouldDeferReviewForActiveFollowUp({
  rootDir = ROOT,
  repo,
  prNumber,
  latestJobFinder = findLatestFollowUpJob,
  staleClaimSweepImpl = stopStaleInProgressFollowUpJob,
  nowMs = Date.now(),
}) {
  let latest = latestJobFinder(rootDir, { repo, prNumber });
  const budgetStopped = stopBudgetExhaustedPendingFollowUpJob({
    rootDir,
    latest,
    stoppedAt: new Date(nowMs).toISOString(),
  });
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

  if (typeof staleClaimSweepImpl === 'function') {
    const staleStopped = staleClaimSweepImpl({ rootDir, latest, nowMs });
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
  stopStaleInProgressFollowUpJob,
};
