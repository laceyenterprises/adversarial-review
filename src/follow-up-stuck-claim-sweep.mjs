// Stuck-claim sweep + heartbeat emitter + pre-spawn lifecycle recheck.
//
// Why this exists (LAC-957, 2026-05-31):
// On 2026-06-01 ~05:02Z the daemon claimed a remediation job for a PR
// that merged 19 seconds later. The remediator started, noticed the
// merged state, and died — but did NOT release the claim. Because
// maxConcurrent=1, every subsequent tick logged
// `activeAtStart=1 availableAtStart=0 spawned=0` and 6 pending jobs
// piled up behind the orphaned claim until an operator manually moved
// the in-progress JSON to stopped/.
//
// Recovery contract (the three primitives in this file):
//   1. Heartbeat: the daemon touches `lastHeartbeatAt` on each
//      in-progress JSON whose worker process is still alive. The
//      workers themselves are external CLIs (codex / claude) so they
//      cannot self-heartbeat; the daemon's per-tick liveness probe
//      stands in for them. Newly-spawned jobs are seeded with
//      `lastHeartbeatAt = spawnedAt` by `markFollowUpJobSpawned` so
//      the very first sweep pass after spawn sees a fresh timestamp.
//   2. Sweep: after the daemon's live-worker heartbeat pass, any
//      in-progress claim whose `lastHeartbeatAt` is
//      older than the stuck threshold (default 10m) is moved to
//      stopped/ with stopCode='stale-heartbeat'. Records with no
//      `lastHeartbeatAt` fall back to file mtime so legacy
//      pre-heartbeat claims still get reclaimed.
//   3. Pre-spawn lifecycle recheck: just before spawning a worker, the
//      daemon reruns the canonical lifecycle resolver/decision path. If
//      the PR merged/closed, the head changed, or an operator applied a
//      stale-drift label in the prep window, the claim is finalized with
//      the same consume-time stop contract instead of spawning.
//
// The sweep is intentionally a separate path from reconcile.
// Reconcile finalizes workers that exited cleanly (a final-message
// artifact exists; the PID is gone). The sweep is the catch-all for
// the residual class — worker exited without leaving the artifacts
// reconcile expects, OR the worker is "alive" by PID but wedged. The
// stale-heartbeat threshold (10m) is much larger than the tick
// interval (120s) so a temporarily-slow tick doesn't reclaim a healthy
// worker.

import { statSync } from 'node:fs';
import { basename } from 'node:path';
import {
  listInProgressFollowUpJobs,
  markFollowUpJobStopped,
  writeFollowUpJob,
} from './follow-up-jobs.mjs';
import { lifecycleStopDecision, resolveJobPRLifecycleSafe } from './follow-up-lifecycle.mjs';

const IN_PROGRESS_STUCK_THRESHOLD_MS_ENV = 'ADVERSARIAL_FOLLOW_UP_IN_PROGRESS_STUCK_THRESHOLD_MS';
const DEFAULT_IN_PROGRESS_STUCK_THRESHOLD_MS = 10 * 60 * 1000;
const STALE_HEARTBEAT_STOP_CODE = 'stale-heartbeat';

function parseTimestampMs(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveInProgressStuckThresholdMs(env = process.env) {
  const raw = env?.[IN_PROGRESS_STUCK_THRESHOLD_MS_ENV];
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_IN_PROGRESS_STUCK_THRESHOLD_MS;
  }
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_IN_PROGRESS_STUCK_THRESHOLD_MS;
  }
  return parsed;
}

// Resolve the timestamp the sweep should compare against the threshold.
// Preference order is documented inline; the fallback to file mtime
// keeps pre-heartbeat / hand-edited records reclaimable.
function resolveLastObservedAtMs(job, jobPath) {
  const heartbeatMs = parseTimestampMs(job?.lastHeartbeatAt);
  if (heartbeatMs !== null) {
    return { sourceMs: heartbeatMs, source: 'lastHeartbeatAt' };
  }
  const spawnedMs = parseTimestampMs(job?.remediationWorker?.spawnedAt);
  if (spawnedMs !== null) {
    return { sourceMs: spawnedMs, source: 'remediationWorker.spawnedAt' };
  }
  const claimedMs = parseTimestampMs(job?.claimedAt);
  if (claimedMs !== null) {
    return { sourceMs: claimedMs, source: 'claimedAt' };
  }
  try {
    const st = statSync(jobPath);
    return { sourceMs: st.mtimeMs, source: 'mtime' };
  } catch {
    return { sourceMs: null, source: 'unavailable' };
  }
}

function sweepStuckInProgressClaims({
  rootDir,
  nowMs = Date.now(),
  thresholdMs = resolveInProgressStuckThresholdMs(),
  log = console,
} = {}) {
  let scanned = 0;
  let reclaimed = 0;
  let skipped = 0;
  const reclaimedAtIso = new Date(nowMs).toISOString();

  for (const { job, jobPath } of listInProgressFollowUpJobs(rootDir)) {
    scanned += 1;
    if (job?.remediationWorker?.dispatchMode === 'hq') {
      skipped += 1;
      continue;
    }
    const { sourceMs, source } = resolveLastObservedAtMs(job, jobPath);
    if (sourceMs === null) {
      skipped += 1;
      continue;
    }
    const ageMs = nowMs - sourceMs;
    if (ageMs <= thresholdMs) {
      skipped += 1;
      continue;
    }

    const jobId = job?.jobId || basename(jobPath);
    const reasonText =
      `Reclaimed orphaned in-progress claim ${jobId}: ${source} is ` +
      `${Math.round(ageMs / 1000)}s old (threshold=${Math.round(thresholdMs / 1000)}s).`;

    markFollowUpJobStopped({
      rootDir,
      jobPath,
      stoppedAt: reclaimedAtIso,
      stopCode: STALE_HEARTBEAT_STOP_CODE,
      stopReason: reasonText,
      sourceStatus: 'in_progress',
      remediationWorker: {
        ...(job?.remediationWorker || {}),
        state: 'reclaimed-stale-heartbeat',
        reclaimedAt: reclaimedAtIso,
        reclaimReason: STALE_HEARTBEAT_STOP_CODE,
        reclaimAgeMs: ageMs,
        reclaimSource: source,
      },
    });
    reclaimed += 1;
    log.log?.(
      `[follow-up-tick ${reclaimedAtIso}] stale-claim-reclaimed jobId=${jobId} ageMs=${ageMs} ` +
      `source=${source} reason=${STALE_HEARTBEAT_STOP_CODE}`
    );
  }

  return { scanned, reclaimed, skipped, thresholdMs };
}

// Emit a heartbeat (`lastHeartbeatAt = now`) on every in-progress job
// whose worker process is still alive. Called once per tick from the
// daemon. Skips entries with no PID handle (HQ-dispatched jobs whose
// liveness is tracked by HQ, not by the daemon). Errors on individual
// records are swallowed so one bad JSON can't stop the rest.
function emitHeartbeatsForActiveJobs({
  rootDir,
  nowMs = Date.now(),
  isWorkerAlive,
  log = console,
} = {}) {
  if (typeof isWorkerAlive !== 'function') {
    throw new Error('emitHeartbeatsForActiveJobs requires isWorkerAlive');
  }
  let scanned = 0;
  let touched = 0;
  let skipped = 0;
  const heartbeatAt = new Date(nowMs).toISOString();
  for (const { job, jobPath } of listInProgressFollowUpJobs(rootDir)) {
    scanned += 1;
    const worker = job?.remediationWorker || {};
    const processId = Number(worker.processId);
    // HQ-dispatched workers don't have a daemon-owned PID; their
    // liveness is HQ's concern. Skip them rather than guess.
    if (worker.dispatchMode === 'hq' || !Number.isInteger(processId) || processId <= 0) {
      skipped += 1;
      continue;
    }
    let alive = false;
    try {
      alive = Boolean(isWorkerAlive(processId));
    } catch (err) {
      log.warn?.(
        `[follow-up-tick ${heartbeatAt}] heartbeat-liveness-failed jobId=${job?.jobId || basename(jobPath)}: ${err?.message || err}`
      );
      continue;
    }
    if (!alive) {
      skipped += 1;
      continue;
    }
    try {
      writeFollowUpJob(jobPath, { ...job, lastHeartbeatAt: heartbeatAt });
      touched += 1;
    } catch (err) {
      log.warn?.(
        `[follow-up-tick ${heartbeatAt}] heartbeat-write-failed jobId=${job?.jobId || basename(jobPath)}: ${err?.message || err}`
      );
    }
  }
  return { scanned, touched, skipped };
}

// Returns an action description (`continue` or `stopped`) so the caller
// knows whether to proceed with spawn. On `stopped` the gate has already
// moved the file out of `in-progress/` with the canonical consume-time
// stop semantics.
async function applyPreSpawnLifecycleGate({
  rootDir,
  job,
  jobPath,
  resolvePRLifecycleImpl,
  execFileImpl,
  stopConsumedJobWithCommentImpl = null,
  postCommentImpl,
  now = () => new Date().toISOString(),
  log = console,
} = {}) {
  const lifecycle = await resolveJobPRLifecycleSafe({
    rootDir,
    job,
    resolvePRLifecycleImpl,
    execFileImpl,
    log,
  });
  const lifecycleStop = lifecycleStopDecision(lifecycle, {
    repo: job?.repo,
    prNumber: job?.prNumber,
    site: 'consume',
    job,
  });
  if (!lifecycleStop) {
    return { action: 'continue', reason: 'pr-open' };
  }
  if (lifecycleStop.logMessage) {
    log.log?.(lifecycleStop.logMessage);
  }

  const nowIso = now();
  const remediationWorker = {
    ...(job?.remediationWorker || {}),
    state: lifecycleStop.workerState,
    preSpawnLifecycleCheckAt: nowIso,
  };
  if (lifecycleStop.stopCode === 'operator-merged-pr' && lifecycle?.mergedAt) {
    remediationWorker.prMergedAt = lifecycle.mergedAt;
  }
  if (lifecycleStop.stopCode === 'operator-closed-pr' && lifecycle?.closedAt) {
    remediationWorker.prClosedAt = lifecycle.closedAt;
  }
  const stopped = (lifecycleStop.stopCode === 'stale-drift' || lifecycleStop.stopCode === 'stale-review-head')
    ? markFollowUpJobStopped({
        rootDir,
        jobPath,
        stoppedAt: nowIso,
        stopCode: lifecycleStop.stopCode,
        stopReason: lifecycleStop.stopReason,
        sourceStatus: 'in_progress',
        remediationWorker: {
          ...(job?.remediationWorker || {}),
          state: lifecycleStop.workerState,
          reconciledAt: nowIso,
          preSpawnLifecycleCheckAt: nowIso,
        },
      })
    : stopConsumedJobWithCommentImpl
      ? await stopConsumedJobWithCommentImpl({
          rootDir,
          job,
          jobPath,
          stoppedAt: nowIso,
          stopCode: lifecycleStop.stopCode,
          stopReason: lifecycleStop.stopReason,
          sourceStatus: 'in_progress',
          remediationWorker,
          postCommentImpl,
          now,
          log,
        })
      : markFollowUpJobStopped({
          rootDir,
          jobPath,
          stoppedAt: nowIso,
          stopCode: lifecycleStop.stopCode,
          stopReason: lifecycleStop.stopReason,
          sourceStatus: 'in_progress',
          remediationWorker,
        });
  log.log?.(
    `[follow-up-remediation ${nowIso}] pre-spawn-lifecycle-stop jobId=${job?.jobId} ` +
    `stopCode=${lifecycleStop.stopCode}`
  );
  return { action: 'stopped', job: stopped.job, jobPath: stopped.jobPath, reason: lifecycleStop.actionReason };
}

export {
  IN_PROGRESS_STUCK_THRESHOLD_MS_ENV,
  DEFAULT_IN_PROGRESS_STUCK_THRESHOLD_MS,
  STALE_HEARTBEAT_STOP_CODE,
  applyPreSpawnLifecycleGate,
  emitHeartbeatsForActiveJobs,
  resolveInProgressStuckThresholdMs,
  resolveLastObservedAtMs,
  sweepStuckInProgressClaims,
};
