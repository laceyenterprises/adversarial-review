#!/usr/bin/env node
// In-process tick loop for the follow-up remediation daemon.
//
// Why this exists (changed 2026-05-02): the previous design ran a
// long-lived bash loop that spawned three fresh `node` subprocesses
// every 120s (consume, reconcile, retry-comments). Each fresh node
// re-touched `~/.codex/auth.json` and worker session dirs — files
// macOS TCC tags as "data from other apps" — and re-prompted with
// "node would like to access data from other apps" on every tick.
// Approving once at the terminal didn't transfer to launchd-spawned
// node, so the popups never went away.
//
// Fix: collapse the three tick subprocesses into a single long-lived
// node process. The bash wrapper still resolves secrets at startup
// (because `op read` / `gh auth token` are most reliably done from a
// shell), then `exec`s into this script. From this point on, ONLY ONE
// node process exists, and TCC's per-binary trust is granted once.
//
// The daemon's tick loop:
//   1. reconcileInProgressFollowUpJobs — finalize exited workers
//   2. emitHeartbeatsForActiveJobs — refresh live detached workers so
//      daemon bounces do not age them into the stale-claim path
//   3. sweepStuckInProgressClaims — reclaim only genuinely stale claims
//   4. consumeFollowUpJobsUntilCapacity — claim + spawn pending jobs
//      until active workers reach ADVERSARIAL_REMEDIATION_MAX_CONCURRENT_JOBS
//      (default 1, preserving the legacy one-worker behavior)
//   5. retryFailedCommentDeliveries — bounded historical retry drain
//
// Workers spawned by the consume step are detached subprocesses of `codex` /
// `claude` (separate binaries with their own TCC identity), not
// further `node` children, so this collapse doesn't change worker
// behavior — only the daemon's own subprocess churn.

import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REMEDIATION_MAX_CONCURRENT_JOBS_ENV,
  consumeFollowUpJobsUntilCapacity,
  isWorkerProcessRunning,
  resolveRemediationWorkspaceRoot,
  resolveRemediationMaxConcurrentJobs,
} from '../src/follow-up-remediation.mjs';
import { reconcileInProgressFollowUpJobs } from '../src/follow-up-reconcile.mjs';
import { retryFailedCommentDeliveries } from '../src/adapters/comms/github-pr-comments/comment-delivery.mjs';
import { archiveStoppedFollowUpJobs, reapTerminalFollowUpWorkspaces } from '../src/follow-up-jobs.mjs';
import {
  emitHeartbeatsForActiveJobs,
  resolveInProgressStuckThresholdMs,
  sweepStuckInProgressClaims,
} from '../src/follow-up-stuck-claim-sweep.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const TICK_INTERVAL_SECONDS = Number(process.env.TICK_INTERVAL_SECONDS) || 120;
const TICK_INTERVAL_MS = TICK_INTERVAL_SECONDS * 1000;
const STOPPED_ARCHIVE_INTERVAL_MS = 60 * 60 * 1000;
const MAINTENANCE_SWEEP_STATE_PATH = join(ROOT, 'data', 'follow-up-jobs', 'maintenance-sweeps.json');

function ts() {
  return new Date().toISOString();
}

function logInfo(msg) {
  console.log(`[follow-up-daemon ${ts()}] ${msg}`);
}

function logTick(label, msg) {
  console.log(`[follow-up-tick ${ts()}] ${label}: ${msg}`);
}

function logError(msg) {
  console.error(`[follow-up-daemon ${ts()}] ${msg}`);
}

const MAX_CONCURRENT_REMEDIATION_JOBS = resolveRemediationMaxConcurrentJobs(process.env, {
  onClamp: ({ requested, clamped }) => {
    logInfo(
      `clamped ${REMEDIATION_MAX_CONCURRENT_JOBS_ENV}=${requested} to ${clamped} to avoid runaway worker fan-out`
    );
  },
});

// Run a tick step, swallowing errors so one step's failure can't
// stop the daemon. Each underlying function already moves jobs to
// failed/ on its own internal failure paths; a thrown error here is
// the residual "we crashed before we could move the job" case, which
// the next tick recovers from via the in-progress reconcile path.
async function runStep(label, fn) {
  logTick(label, 'starting');
  try {
    await fn();
    logTick(label, 'ok');
  } catch (err) {
    logTick(label, `threw: ${err?.message || err}`);
  }
}

function readMaintenanceSweepState(statePath = MAINTENANCE_SWEEP_STATE_PATH) {
  if (!existsSync(statePath)) return {};
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (err) {
    logError(`could not read maintenance sweep state ${statePath}: ${err?.message || err}`);
    return {};
  }
}

function writeMaintenanceSweepState(state, statePath = MAINTENANCE_SWEEP_STATE_PATH) {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    const tmpPath = `${statePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, statePath);
  } catch (err) {
    logError(`could not write maintenance sweep state ${statePath}: ${err?.message || err}`);
  }
}

function resolveInitialStoppedArchiveSweepMs(statePath = MAINTENANCE_SWEEP_STATE_PATH) {
  return Number(readMaintenanceSweepState(statePath).lastStoppedArchiveSweepMs || 0);
}

let lastStoppedArchiveSweepMs = resolveInitialStoppedArchiveSweepMs();
async function runStoppedArchiveSweepIfDue({ nowMs = Date.now() } = {}) {
  if (lastStoppedArchiveSweepMs && (nowMs - lastStoppedArchiveSweepMs) < STOPPED_ARCHIVE_INTERVAL_MS) {
    return;
  }
  lastStoppedArchiveSweepMs = nowMs;
  writeMaintenanceSweepState({
    lastStoppedArchiveSweepMs: nowMs,
    lastStoppedArchiveSweepAt: new Date(nowMs).toISOString(),
  });
  await runStep('archive-stopped', () => {
    const result = archiveStoppedFollowUpJobs({ rootDir: ROOT, nowMs });
    logTick(
      'archive-stopped',
      `scanned=${result.scanned} archived=${result.archived} skipped=${result.skipped} collisions=${result.collisions}`
    );
  });
  await runStep('reap-workspaces', () => {
    const workspaceRootDir = resolveRemediationWorkspaceRoot({ rootDir: ROOT });
    const result = reapTerminalFollowUpWorkspaces({
      rootDir: ROOT,
      workspaceRootDir,
      nowMs,
    });
    logTick(
      'reap-workspaces',
      `scanned=${result.scanned} reaped=${result.reaped} skipped=${result.skipped} ` +
      `missingTerminalJob=${result.missingTerminalJob} ` +
      `missingTerminalTimestamp=${result.missingTerminalTimestamp} ` +
      `missingTerminalTimestampSamples=${JSON.stringify(result.missingTerminalTimestampPaths)} ` +
      `recentTerminalJob=${result.recentTerminalJob} ` +
      `unreadableJobRecords=${result.unreadableJobRecords} errors=${result.errors}`
    );
  });
}

let stopping = false;
function installSignalHandlers() {
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      logInfo(`received ${sig} — finishing current tick then exiting`);
    });
  }
}

async function main() {
  if (process.argv.includes('--with-hq-integration')) {
    process.env.ADV_WITH_HQ_INTEGRATION = '1';
  }
  installSignalHandlers();
  logInfo(
    `startup complete; entering tick loop (interval=${TICK_INTERVAL_SECONDS}s ` +
    `${REMEDIATION_MAX_CONCURRENT_JOBS_ENV}=${MAX_CONCURRENT_REMEDIATION_JOBS})`
  );

  while (!stopping) {
    await runStep('reconcile', () => reconcileInProgressFollowUpJobs());
    if (stopping) break;
    await runStep('heartbeat', () => {
      const result = emitHeartbeatsForActiveJobs({
        rootDir: ROOT,
        isWorkerAlive: isWorkerProcessRunning,
      });
      logTick(
        'heartbeat',
        `scanned=${result.scanned} touched=${result.touched} skipped=${result.skipped}`
      );
    });
    if (stopping) break;
    await runStep('stale-claim-sweep', () => {
      const thresholdMs = resolveInProgressStuckThresholdMs(process.env);
      const result = sweepStuckInProgressClaims({ rootDir: ROOT, thresholdMs });
      logTick(
        'stale-claim-sweep',
        `scanned=${result.scanned} reclaimed=${result.reclaimed} skipped=${result.skipped} ` +
        `thresholdMs=${result.thresholdMs}`
      );
    });
    if (stopping) break;
    await runStep('consume', async () => {
      const result = await consumeFollowUpJobsUntilCapacity({
        maxConcurrent: MAX_CONCURRENT_REMEDIATION_JOBS,
        shouldStop: () => stopping,
      });
      logTick(
        'consume',
        `maxConcurrent=${result.maxConcurrent} activeAtStart=${result.activeAtStart} ` +
        `availableAtStart=${result.availableAtStart} spawned=${result.spawned} ` +
        `stopped=${result.stopped} deferredSamePR=${result.deferredSamePR} ` +
        `capacityRemaining=${result.capacityRemaining}`
      );
    });
    if (stopping) break;
    await runStep('retry-comments', () => retryFailedCommentDeliveries());
    if (stopping) break;
    await runStoppedArchiveSweepIfDue();
    logTick('tick', `complete; sleeping ${TICK_INTERVAL_SECONDS}s`);

    if (stopping) break;
    // Use abort-aware sleep so SIGTERM during the idle phase exits
    // promptly rather than waiting up to TICK_INTERVAL_SECONDS.
    const ac = new AbortController();
    const stopWatch = () => ac.abort();
    process.once('SIGTERM', stopWatch);
    process.once('SIGINT', stopWatch);
    try {
      await sleep(TICK_INTERVAL_MS, undefined, { signal: ac.signal });
    } catch (err) {
      if (err?.name !== 'AbortError') throw err;
    } finally {
      process.removeListener('SIGTERM', stopWatch);
      process.removeListener('SIGINT', stopWatch);
    }
  }

  logInfo('exiting tick loop');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    logError(`fatal: ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
}

export {
  main,
  readMaintenanceSweepState,
  resolveInitialStoppedArchiveSweepMs,
  runStoppedArchiveSweepIfDue,
  writeMaintenanceSweepState,
};
