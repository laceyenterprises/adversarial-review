// ARGUSDRAIN-01 item 5 — the Argus lane on the pipeline health surface.
//
// The SEV's failure mode was silence: 1,519 jobs queued for a month and nothing
// said so. This module reports the three numbers that would have said it (queue
// depth, the oldest unanswered job's age, and claim-to-verdict latency) plus
// the drain's own status, so `review-pipeline-health` can raise a finding when
// the oldest live-head job outlives its bound or the drain is not running.
//
// "Live-head" is honest about its evidence. The backlog retirement pass proves
// liveness against GitHub; while its last pass is fresh, every job still in
// the queue is one it kept (or one enqueued since, for an open PR). When it is
// not fresh the oldest job is still reported, marked `unverified`: a queue that
// nothing retires is a queue nothing drains, and that is worth the alert too.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';
import { listArgusJobs, readArgusQueueDepth } from './argus-security-queue.mjs';

export const ARGUS_DRAIN_STATUS_FILE = 'argus-security-drain-status.json';
export const ARGUS_LATENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
// Two retirement intervals (the drain retires every 30 minutes); kept literal
// so the health collector does not import the drain's GitHub-facing modules.
export const ARGUS_RETIREMENT_FRESH_MS = 60 * 60 * 1000;
const COMPLETED_SCAN_LIMIT = 500;

export function argusDrainStatusPath(rootDir) {
  return join(rootDir, 'data', ARGUS_DRAIN_STATUS_FILE);
}

export function writeArgusDrainStatus(rootDir, status) {
  writeFileAtomic(argusDrainStatusPath(rootDir), `${JSON.stringify(status, null, 2)}\n`);
}

export function readArgusDrainStatus(rootDir) {
  const path = argusDrainStatusPath(rootDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { unreadable: true };
  }
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @returns {{depth: object, unanswered: number, oldestUnanswered: object|null,
 *   liveness: 'verified-by-retirement'|'unverified', latency: object,
 *   verdicts: object, drain: object}}
 */
export function summarizeArgusSecurityQueue(rootDir, {
  nowMs = Date.now(),
  windowMs = ARGUS_LATENCY_WINDOW_MS,
  retirementFreshMs = ARGUS_RETIREMENT_FRESH_MS,
} = {}) {
  const depth = readArgusQueueDepth(rootDir, { nowMs });
  let oldestUnanswered = null;
  let unanswered = 0;
  for (const bucket of ['pending', 'inProgress']) {
    for (const { job } of listArgusJobs(rootDir, { bucket, limit: Number.POSITIVE_INFINITY })) {
      unanswered += 1;
      const enqueuedMs = timestampMs(job?.enqueuedAt);
      if (enqueuedMs === null) continue;
      if (!oldestUnanswered || enqueuedMs < oldestUnanswered.enqueuedMs) {
        oldestUnanswered = {
          jobId: job.jobId,
          repo: job.repo,
          prNumber: job.prNumber,
          headSha: job.headSha,
          bucket,
          enqueuedAt: job.enqueuedAt,
          enqueuedMs,
          ageMs: Math.max(0, nowMs - enqueuedMs),
          attempts: job?.drain?.attempts || 0,
          lastError: job?.drain?.lastError || null,
        };
      }
    }
  }

  const latencies = [];
  const verdicts = { approve: 0, block: 0, needs_verification: 0, superseded: 0, other: 0, failed: 0 };
  for (const { job } of listArgusJobs(rootDir, { bucket: 'completed', limit: COMPLETED_SCAN_LIMIT })) {
    const completedMs = timestampMs(job?.completedAt);
    if (completedMs === null || nowMs - completedMs > windowMs) continue;
    const verdict = String(job?.result?.verdict || '');
    if (Object.hasOwn(verdicts, verdict)) verdicts[verdict] += 1;
    else verdicts.other += 1;
    const latency = Number(job?.result?.drain?.latencyMs);
    if (Number.isFinite(latency) && latency >= 0) latencies.push(latency);
  }
  for (const { job } of listArgusJobs(rootDir, { bucket: 'failed', limit: COMPLETED_SCAN_LIMIT })) {
    const failedMs = timestampMs(job?.failedAt);
    if (failedMs !== null && nowMs - failedMs <= windowMs) verdicts.failed += 1;
  }
  latencies.sort((a, b) => a - b);

  const status = readArgusDrainStatus(rootDir);
  const statusMs = timestampMs(status?.observedAt);
  const retirementMs = timestampMs(status?.retirement?.lastFinishedAt);
  const retirementFresh = retirementMs !== null
    && !status?.retirement?.lastError
    && nowMs - retirementMs <= retirementFreshMs;

  return {
    depth: depth.depth,
    unanswered,
    oldestUnanswered: oldestUnanswered
      ? (({ enqueuedMs: _enqueuedMs, ...rest }) => rest)(oldestUnanswered)
      : null,
    liveness: retirementFresh ? 'verified-by-retirement' : 'unverified',
    latency: {
      windowMs,
      count: latencies.length,
      p50Ms: percentile(latencies, 0.5),
      p90Ms: percentile(latencies, 0.9),
      maxMs: latencies.length ? latencies[latencies.length - 1] : null,
    },
    verdicts,
    drain: {
      status,
      statusAgeMs: statusMs === null ? null : Math.max(0, nowMs - statusMs),
    },
  };
}
