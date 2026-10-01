import { execFileSync } from 'node:child_process';
import { isSqliteBusyError, sleepSync } from './sqlite-busy-retry.mjs';

const OJO_RETRY_DELAYS_MS = Object.freeze([100, 250]);

function isTransientOjoError(error) {
  const diagnostic = [error?.code, error?.message, error?.stderr].map((value) => String(value || '')).join('\n');
  return isSqliteBusyError(error) || isSqliteBusyError({ message: diagnostic })
    || /\b(?:EAGAIN|EIO|EMFILE|ENFILE|ETIMEDOUT)\b|resource temporarily unavailable/i.test(diagnostic);
}

// OJO owns this job. A retired launchd timer and log mtimes are not evidence.
export function classifyDagAutowalk(job, { owner, nowMs, thresholdMs }) {
  const result = {
    source: 'ojo', owner, jobId: 'dag-autowalk', healthy: null,
    status: 'inconclusive', reason: 'invalid-job-snapshot', thresholdMs,
  };
  if (!job || job.id !== result.jobId || job.owner !== owner || job.owned !== true
    || typeof job.enabled !== 'boolean' || typeof job.state !== 'string') return result;
  const timestamp = (value) => {
    const ms = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(ms) && ms <= nowMs ? ms : null;
  };
  const green = timestamp(job.lastGreenAt);
  const failed = timestamp(job.lastFailedAt);
  const acted = timestamp(job.lastActedAt);
  const started = timestamp(job.lastStartedAt);
  const finished = timestamp(job.lastFinishedAt);
  const warned = timestamp(job.lastWarnAt);
  const progress = Math.max(green ?? 0, acted ?? 0) || null;
  Object.assign(result, {
    state: job.state, rawState: job.rawState, schedulerFreshness: job.staleness?.state || 'unknown',
    lastExitCode: job.lastExitCode ?? null, lastGreenAt: job.lastGreenAt || null,
    lastActedAt: job.lastActedAt || null, lastFailedAt: job.lastFailedAt || null,
    lastStartedAt: job.lastStartedAt || null,
    progressAgeMs: progress === null ? null : nowMs - progress,
  });
  const unhealthy = (reason) => ({ ...result, healthy: false, status: 'unhealthy', reason });
  if (!job.enabled || job.retired || job.ownerControl?.schedulingSuppressed
    || job.ownerControl?.paused || job.ownerControl?.drained) return unhealthy('scheduling-suppressed');
  if (job.state === 'failing' || job.rawState === 'failed'
    || (failed !== null && (green === null || failed > green))) {
    return unhealthy(job.lastExitCode === 124 ? 'timeout' : 'latest-run-failed');
  }
  if (job.staleness?.state === 'stale') return unhealthy('scheduler-stale');
  if (job.staleness?.state !== 'fresh') return { ...result, reason: 'scheduler-freshness-unverified' };
  // A queued job or live singleton is not a completed sweep. Keep historical
  // progress separate from admission/liveness, and never reset it on a skip.
  if (progress !== null && nowMs - progress > thresholdMs) return unhealthy('nonprogress');
  if (job.rawState === 'running' || ['running', 'acting', 'queued'].includes(job.state)) {
    if (started !== null && nowMs - started > thresholdMs) return unhealthy('nonprogress');
    return { ...result, reason: 'in-flight-progress-unverified' };
  }
  if (!['green-idle', 'acted'].includes(job.state) || (warned !== null && (green === null || warned >= green))
    || progress === null || green === null || finished === null || finished < green || job.lastExitCode !== 0) {
    return { ...result, reason: 'completed-progress-unverified' };
  }
  return { ...result, healthy: true, status: 'healthy', reason: 'completed-fresh' };
}

export function collectDagAutowalkHealth({
  owner, nowMs, thresholdMs, execFileSyncImpl = execFileSync, sleepSyncImpl = sleepSync,
}) {
  try {
    let raw;
    for (let attempt = 0; attempt <= OJO_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        // Three attempts plus backoff stay inside the original 10s budget.
        raw = execFileSyncImpl('hq', ['ojo', '--owners', owner, 'job', 'dag-autowalk'], {
          encoding: 'utf8', timeout: 3_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
        });
        break;
      } catch (error) {
        if (!isTransientOjoError(error) || attempt >= OJO_RETRY_DELAYS_MS.length) throw error;
        sleepSyncImpl(OJO_RETRY_DELAYS_MS[attempt]);
      }
    }
    const payload = JSON.parse(raw);
    if (!Array.isArray(payload.owners)
      || !payload.owners.some((entry) => entry.owner === owner && entry.ok === true)) {
      throw new Error('owner unavailable');
    }
    return classifyDagAutowalk(payload.job, { owner, nowMs, thresholdMs });
  } catch {
    // Never expose stderr: adapter/CLI diagnostics may contain credentials.
    return { source: 'ojo', owner, jobId: 'dag-autowalk', healthy: null,
      status: 'inconclusive', reason: 'ojo-unavailable', thresholdMs };
  }
}
