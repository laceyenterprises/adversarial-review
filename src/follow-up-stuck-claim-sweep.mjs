// Stuck-claim sweep + heartbeat emitter + PR-merged precheck.
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
//   2. Sweep: at the start of each tick (after reconcile, before
//      consume), any in-progress claim whose `lastHeartbeatAt` is
//      older than the stuck threshold (default 10m) is moved to
//      stopped/ with stopCode='stale-heartbeat'. Records with no
//      `lastHeartbeatAt` fall back to file mtime so legacy
//      pre-heartbeat claims still get reclaimed.
//   3. PR-merged precheck: just before spawning a worker, the daemon
//      re-checks the PR's state via `gh pr view`. If the PR merged or
//      closed in the window between the initial lifecycle check and
//      the spawn (the exact race tonight's incident exhibited), the
//      claim is finalized to completed/ (merged) or stopped/ (closed)
//      without spawning. Factored as a standalone function so it can
//      be unit-tested with a fake execFile.
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
  markFollowUpJobCompleted,
  markFollowUpJobStopped,
  writeFollowUpJob,
} from './follow-up-jobs.mjs';

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

// Lightweight PR-merged precheck. The bug this addresses: between the
// claim moment and the actual `spawn` call, OAuth pre-flight + workspace
// prep can take ~10-20s, during which the PR may merge. The existing
// lifecycleStopDecision call runs BEFORE that delay, so it doesn't
// catch the race. This precheck runs RIGHT BEFORE spawn.
//
// Returns { state: 'open'|'merged'|'closed', mergedAt, closedAt } or
// throws on a malformed gh response. Errors from gh (network / auth /
// etc.) are surfaced to the caller, which is expected to swallow them
// and proceed with spawn — the precheck is opportunistic; falling
// through to the spawn matches the existing lifecycle-gate's "degrade
// open" policy.
async function fetchPRTerminalState({
  repo,
  prNumber,
  execFileImpl,
}) {
  if (!repo || !prNumber) {
    throw new Error('fetchPRTerminalState requires repo and prNumber');
  }
  if (typeof execFileImpl !== 'function') {
    throw new Error('fetchPRTerminalState requires execFileImpl');
  }
  const { stdout } = await execFileImpl(
    'gh',
    ['pr', 'view', String(prNumber), '--repo', String(repo), '--json', 'state,mergedAt,closedAt'],
    { maxBuffer: 1 * 1024 * 1024 }
  );
  const parsed = JSON.parse(String(stdout || '{}'));
  const rawState = String(parsed?.state || '').trim().toUpperCase();
  const normalizedState =
    rawState === 'MERGED' ? 'merged'
      : rawState === 'CLOSED' ? 'closed'
        : rawState === 'OPEN' ? 'open'
          : null;
  if (!normalizedState) {
    throw new Error(`gh pr view returned unrecognized state for ${repo}#${prNumber}: ${JSON.stringify(parsed?.state)}`);
  }
  return {
    state: normalizedState,
    mergedAt: typeof parsed?.mergedAt === 'string' && parsed.mergedAt.trim() ? parsed.mergedAt : null,
    closedAt: typeof parsed?.closedAt === 'string' && parsed.closedAt.trim() ? parsed.closedAt : null,
  };
}

// Returns an action description ('continue' | 'merged' | 'closed') so
// the caller knows whether to proceed with spawn. On 'merged' /
// 'closed' the precheck has ALREADY moved the file out of in-progress/
// to the right terminal state.
async function applyPRMergedPrecheck({
  rootDir,
  job,
  jobPath,
  execFileImpl,
  now = () => new Date().toISOString(),
  log = console,
} = {}) {
  let observation;
  try {
    observation = await fetchPRTerminalState({
      repo: job?.repo,
      prNumber: job?.prNumber,
      execFileImpl,
    });
  } catch (err) {
    // Precheck is opportunistic — when it can't get a definitive PR
    // state, fall through to spawn and let the regular reconcile path
    // catch any real failures. Logged at info-level so operators can
    // tail debug output without flooding the warn channel that the
    // drain-summary path uses for genuine spawn-preparation failures.
    log.info?.(
      `[follow-up-remediation] pr-state-precheck non-fatal for ${job?.repo}#${job?.prNumber}: ${err?.message || err}`
    );
    return { action: 'continue', reason: 'precheck-failed' };
  }

  if (observation.state === 'open') {
    return { action: 'continue', reason: 'pr-open' };
  }

  const nowIso = now();
  if (observation.state === 'merged') {
    const reasonText =
      `PR ${job.repo}#${job.prNumber} merged before remediation spawn` +
      `${observation.mergedAt ? ` (mergedAt=${observation.mergedAt})` : ''}; ` +
      `finalizing claim to completed/ without spawning.`;
    const finalized = markFollowUpJobCompleted({
      rootDir,
      jobPath,
      completedAt: nowIso,
      remediationWorker: {
        ...(job?.remediationWorker || {}),
        state: 'never-spawned',
        prMergedPrecheckAt: nowIso,
        prMergedAt: observation.mergedAt,
      },
      completion: {
        preview: 'PR already merged at remediator entry; no remediation needed.',
      },
    });
    log.log?.(
      `[follow-up-remediation ${nowIso}] pr-already-terminal jobId=${job?.jobId} ` +
      `state=merged action=completed mergedAt=${observation.mergedAt || 'unknown'}`
    );
    return { action: 'merged', job: finalized.job, jobPath: finalized.jobPath, reason: reasonText };
  }

  const closedReason =
    `PR ${job.repo}#${job.prNumber} closed before remediation spawn` +
    `${observation.closedAt ? ` (closedAt=${observation.closedAt})` : ''}; ` +
    `finalizing claim to stopped/ without spawning.`;
  const stopped = markFollowUpJobStopped({
    rootDir,
    jobPath,
    stoppedAt: nowIso,
    stopCode: 'pr-already-closed',
    stopReason: closedReason,
    sourceStatus: 'in_progress',
    remediationWorker: {
      ...(job?.remediationWorker || {}),
      state: 'never-spawned',
      prClosedPrecheckAt: nowIso,
      prClosedAt: observation.closedAt,
    },
  });
  log.log?.(
    `[follow-up-remediation ${nowIso}] pr-already-terminal jobId=${job?.jobId} ` +
    `state=closed action=stopped closedAt=${observation.closedAt || 'unknown'}`
  );
  return { action: 'closed', job: stopped.job, jobPath: stopped.jobPath, reason: closedReason };
}

export {
  IN_PROGRESS_STUCK_THRESHOLD_MS_ENV,
  DEFAULT_IN_PROGRESS_STUCK_THRESHOLD_MS,
  STALE_HEARTBEAT_STOP_CODE,
  applyPRMergedPrecheck,
  emitHeartbeatsForActiveJobs,
  fetchPRTerminalState,
  resolveInProgressStuckThresholdMs,
  resolveLastObservedAtMs,
  sweepStuckInProgressClaims,
};
