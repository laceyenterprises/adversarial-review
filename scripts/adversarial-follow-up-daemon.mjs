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
//   2. consumeFollowUpJobsUntilCapacity — claim + spawn pending jobs
//      until active workers reach ADVERSARIAL_REMEDIATION_MAX_CONCURRENT_JOBS
//      (default 1, preserving the legacy one-worker behavior)
//   3. retryFailedCommentDeliveries — bounded historical retry drain
//
// Workers spawned by the consume step are detached subprocesses of `codex` /
// `claude` (separate binaries with their own TCC identity), not
// further `node` children, so this collapse doesn't change worker
// behavior — only the daemon's own subprocess churn.

import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REMEDIATION_MAX_CONCURRENT_JOBS_ENV,
  consumeFollowUpJobsUntilCapacity,
  resolveRemediationMaxConcurrentJobs,
} from '../src/follow-up-remediation.mjs';
import { reconcileInProgressFollowUpJobs } from '../src/follow-up-reconcile.mjs';
import { retryFailedCommentDeliveries } from '../src/comment-delivery.mjs';
import { archiveStoppedFollowUpJobs } from '../src/follow-up-jobs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const TICK_INTERVAL_SECONDS = Number(process.env.TICK_INTERVAL_SECONDS) || 120;
const TICK_INTERVAL_MS = TICK_INTERVAL_SECONDS * 1000;
const STOPPED_ARCHIVE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_CONCURRENT_REMEDIATION_JOBS = resolveRemediationMaxConcurrentJobs();

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

let lastStoppedArchiveSweepMs = 0;
async function runStoppedArchiveSweepIfDue({ nowMs = Date.now() } = {}) {
  if (lastStoppedArchiveSweepMs && (nowMs - lastStoppedArchiveSweepMs) < STOPPED_ARCHIVE_INTERVAL_MS) {
    return;
  }
  lastStoppedArchiveSweepMs = nowMs;
  await runStep('archive-stopped', () => {
    const result = archiveStoppedFollowUpJobs({ rootDir: ROOT, nowMs });
    logTick(
      'archive-stopped',
      `scanned=${result.scanned} archived=${result.archived} skipped=${result.skipped} collisions=${result.collisions}`
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
  installSignalHandlers();
  logInfo(
    `startup complete; entering tick loop (interval=${TICK_INTERVAL_SECONDS}s ` +
    `${REMEDIATION_MAX_CONCURRENT_JOBS_ENV}=${MAX_CONCURRENT_REMEDIATION_JOBS})`
  );

  while (!stopping) {
    await runStep('reconcile', () => reconcileInProgressFollowUpJobs());
    if (stopping) break;
    await runStep('consume', async () => {
      const result = await consumeFollowUpJobsUntilCapacity({
        maxConcurrent: MAX_CONCURRENT_REMEDIATION_JOBS,
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

export { main, runStoppedArchiveSweepIfDue };
