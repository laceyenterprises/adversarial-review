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
//   4. reapCloserHammerWorktrees — remove terminal/prunable AMA hammer worktrees
//   5. consumeFollowUpJobsUntilCapacity — claim + spawn pending jobs
//      until active workers reach ADVERSARIAL_REMEDIATION_MAX_CONCURRENT_JOBS
//      (default 1, preserving the legacy one-worker behavior)
//   6. retryFailedCommentDeliveries — bounded historical retry drain
//
// Workers spawned by the consume step are detached subprocesses of `codex` /
// `claude` (separate binaries with their own TCC identity), not
// further `node` children, so this collapse doesn't change worker
// behavior — only the daemon's own subprocess churn.

import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REMEDIATION_MAX_CONCURRENT_JOBS_ENV,
  connectFollowUpTelemetryListener,
  consumeFollowUpJobsUntilCapacity,
  isWorkerProcessRunning,
  resolveRemediationWorkspaceRoot,
  resolveRemediationMaxConcurrentJobs,
} from '../src/follow-up-remediation.mjs';
import { reconcileInProgressFollowUpJobs } from '../src/follow-up-reconcile.mjs';
import { retryFailedCommentDeliveries } from '../src/adapters/comms/github-pr-comments/comment-delivery.mjs';
import { refreshReviewerBrokerTokens } from '../src/reviewer-broker-refresh.mjs';
import { reapCloserHammerWorktrees } from '../src/ama/closer-worktree-reaper.mjs';
import { archiveStoppedFollowUpJobs, reapTerminalFollowUpWorkspaces } from '../src/follow-up-jobs.mjs';
import {
  emitHeartbeatsForActiveJobs,
  resolveInProgressStuckThresholdMs,
  sweepStuckInProgressClaims,
} from '../src/follow-up-stuck-claim-sweep.mjs';
import { writeFileAtomic } from '../src/atomic-write.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const TICK_INTERVAL_SECONDS = Number(process.env.TICK_INTERVAL_SECONDS) || 120;
const TICK_INTERVAL_MS = TICK_INTERVAL_SECONDS * 1000;
const STOPPED_ARCHIVE_INTERVAL_MS = 60 * 60 * 1000;
const TELEMETRY_LISTENER_START_TIMEOUT_DEFAULT_MS = 5000;
export const REMEDIATION_WORKER_TOKEN_MIN_LIFETIME_MS_ENV =
  'ADVERSARIAL_REMEDIATION_WORKER_TOKEN_MIN_LIFETIME_MS';
// The reviewer-token handoff floor for spawning a remediation worker. The old
// 50-minute default was effectively UNSATISFIABLE: GitHub App installation
// tokens live at most 60 minutes, and the OAuth broker only re-mints within its
// refresh window (default ~25 min) — so it serves tokens with 25–60 min
// remaining. A 50-minute floor is cleared only in the brief window just after a
// re-mint (60 → 50), so the `consume` step skipped spawning almost every tick
// ("token-below-handoff-floor"), remediation jobs piled up unclaimed, and the
// whole review→remediate→re-review→AMA pipeline stalled (observed 2026-06-14:
// 14 jobs backlogged, 0 spawned, watcher pollsSinceLastSpawn=33).
//
// 22 minutes matches the reviewer-side handoff floor
// (REVIEWER_TOKEN_FALLBACK_TTL_MS 20m + REVIEWER_TOKEN_POST_SLACK_MS 2m) and is
// reliably satisfiable with the broker's default refresh window: the broker
// always serves ≥25 min, comfortably above 22. A remediation worker that runs
// longer than its handed-off token re-resolves via the broker mid-run; the
// floor only governs the freshness at hand-off, not the worker's whole lifetime.
// Operators who want a higher floor can still set the env override below.
export const DEFAULT_REMEDIATION_WORKER_TOKEN_MIN_LIFETIME_MS = 22 * 60 * 1000;
const STOPPED_ARCHIVE_FAILURE_RETRY_SECONDS = positiveNumberEnv(
  'STOPPED_ARCHIVE_FAILURE_RETRY_SECONDS',
  5 * 60,
);
const STOPPED_ARCHIVE_FAILURE_RETRY_MS = STOPPED_ARCHIVE_FAILURE_RETRY_SECONDS * 1000;
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

function positiveNumberEnv(name, fallback) {
  const parsed = Number(process.env[name] || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_CONCURRENT_REMEDIATION_JOBS = resolveRemediationMaxConcurrentJobs(process.env, {
  onClamp: ({ requested, clamped }) => {
    logInfo(
      `clamped ${REMEDIATION_MAX_CONCURRENT_JOBS_ENV}=${requested} to ${clamped} to avoid runaway worker fan-out`
    );
  },
});

function resolveRemediationWorkerTokenMinLifetimeMs(env = process.env) {
  const raw = env?.[REMEDIATION_WORKER_TOKEN_MIN_LIFETIME_MS_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_REMEDIATION_WORKER_TOKEN_MIN_LIFETIME_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_REMEDIATION_WORKER_TOKEN_MIN_LIFETIME_MS;
}

function reviewerTokenHandoffUnsafeRoles(summary = {}) {
  const handoffSafe = Array.isArray(summary?.handoffSafe) ? summary.handoffSafe : [];
  return handoffSafe.filter((entry) => entry?.safe === false);
}

function shouldConsumeAfterReviewerTokenRefresh(summary = {}) {
  return reviewerTokenHandoffUnsafeRoles(summary).length === 0;
}

function describeUnsafeReviewerTokenHandoff(summary = {}) {
  return reviewerTokenHandoffUnsafeRoles(summary)
    .map((entry) => `${entry.role || entry.envVar || 'unknown'}:${entry.reason || 'unsafe'}`)
    .join(',');
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
    return true;
  } catch (err) {
    logTick(label, `threw: ${err?.message || err}`);
    return false;
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
    writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
    return true;
  } catch (err) {
    logError(`could not write maintenance sweep state ${statePath}: ${err?.message || err}`);
    return false;
  }
}

function normalizeMs(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeMaintenanceSweepState(state = {}) {
  const legacySweepMs = normalizeMs(state.lastStoppedArchiveSweepMs);
  return {
    ...state,
    lastArchiveStoppedSweepMs: normalizeMs(state.lastArchiveStoppedSweepMs) || legacySweepMs,
    lastReapTerminalWorkspacesSweepMs: (
      normalizeMs(state.lastReapTerminalWorkspacesSweepMs) || legacySweepMs
    ),
    lastArchiveStoppedSweepFailedMs: normalizeMs(state.lastArchiveStoppedSweepFailedMs),
    lastReapTerminalWorkspacesSweepFailedMs: normalizeMs(state.lastReapTerminalWorkspacesSweepFailedMs),
  };
}

function serializeMaintenanceSweepState(state = {}) {
  const normalized = normalizeMaintenanceSweepState(state);
  const serialized = { ...state };
  delete serialized.lastStoppedArchiveSweepMs;
  delete serialized.lastStoppedArchiveSweepAt;

  for (const key of [
    'lastArchiveStoppedSweep',
    'lastArchiveStoppedSweepFailed',
    'lastReapTerminalWorkspacesSweep',
    'lastReapTerminalWorkspacesSweepFailed',
  ]) {
    const msKey = `${key}Ms`;
    const atKey = `${key}At`;
    const ms = normalizeMs(normalized[msKey]);
    if (ms) {
      serialized[msKey] = ms;
      serialized[atKey] = typeof state[atKey] === 'string'
        ? state[atKey]
        : new Date(ms).toISOString();
    } else {
      delete serialized[msKey];
      delete serialized[atKey];
    }
  }

  return serialized;
}

let defaultMaintenanceSweepState = null;
let defaultMaintenanceSweepStateMtimeMs = null;

function maintenanceSweepStateMtimeMs(statePath = MAINTENANCE_SWEEP_STATE_PATH) {
  try {
    return statSync(statePath).mtimeMs;
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      logError(`could not stat maintenance sweep state ${statePath}: ${err?.message || err}`);
    }
    return null;
  }
}

function getDefaultMaintenanceSweepState() {
  const fileMtimeMs = maintenanceSweepStateMtimeMs();
  if (
    defaultMaintenanceSweepState === null
    || fileMtimeMs !== defaultMaintenanceSweepStateMtimeMs
  ) {
    defaultMaintenanceSweepState = normalizeMaintenanceSweepState(readMaintenanceSweepState());
    defaultMaintenanceSweepStateMtimeMs = fileMtimeMs;
  }
  return defaultMaintenanceSweepState;
}

function rememberDefaultMaintenanceSweepState(state) {
  defaultMaintenanceSweepState = normalizeMaintenanceSweepState(state);
  defaultMaintenanceSweepStateMtimeMs = maintenanceSweepStateMtimeMs();
}

function readCurrentMaintenanceSweepState(statePath) {
  return statePath === MAINTENANCE_SWEEP_STATE_PATH
    ? { ...getDefaultMaintenanceSweepState() }
    : normalizeMaintenanceSweepState(readMaintenanceSweepState(statePath));
}

function updateCurrentMaintenanceSweepState(state, statePath) {
  const persisted = writeMaintenanceSweepState(serializeMaintenanceSweepState(state), statePath);
  if (statePath === MAINTENANCE_SWEEP_STATE_PATH) {
    if (persisted) {
      rememberDefaultMaintenanceSweepState(state);
    }
  }
  return persisted;
}

function shouldRunMaintenanceStep(state, nowMs, sweepKey, failedKey) {
  const lastSweepMs = normalizeMs(state[`${sweepKey}Ms`]);
  if (lastSweepMs && (nowMs - lastSweepMs) < STOPPED_ARCHIVE_INTERVAL_MS) {
    return false;
  }

  const lastFailedMs = normalizeMs(state[`${failedKey}Ms`]);
  return !lastFailedMs || (nowMs - lastFailedMs) >= STOPPED_ARCHIVE_FAILURE_RETRY_MS;
}

function markMaintenanceStepSuccess(state, nowMs, sweepKey, failedKey) {
  state[`${sweepKey}Ms`] = nowMs;
  state[`${sweepKey}At`] = new Date(nowMs).toISOString();
  delete state[`${failedKey}Ms`];
  delete state[`${failedKey}At`];
}

function markMaintenanceStepFailure(state, nowMs, failedKey) {
  state[`${failedKey}Ms`] = nowMs;
  state[`${failedKey}At`] = new Date(nowMs).toISOString();
}

async function runStoppedArchiveSweepIfDue({
  nowMs = Date.now(),
  statePath = MAINTENANCE_SWEEP_STATE_PATH,
  archiveStoppedFollowUpJobsImpl = archiveStoppedFollowUpJobs,
  reapTerminalFollowUpWorkspacesImpl = reapTerminalFollowUpWorkspaces,
  resolveRemediationWorkspaceRootImpl = resolveRemediationWorkspaceRoot,
} = {}) {
  const state = readCurrentMaintenanceSweepState(statePath);
  const archiveDue = shouldRunMaintenanceStep(
    state,
    nowMs,
    'lastArchiveStoppedSweep',
    'lastArchiveStoppedSweepFailed',
  );
  const reapDue = shouldRunMaintenanceStep(
    state,
    nowMs,
    'lastReapTerminalWorkspacesSweep',
    'lastReapTerminalWorkspacesSweepFailed',
  );
  if (!archiveDue && !reapDue) {
    return;
  }

  const nextState = { ...state };
  if (archiveDue) {
    const archiveOk = await runStep('archive-stopped', () => {
      const result = archiveStoppedFollowUpJobsImpl({ rootDir: ROOT, nowMs });
      logTick(
        'archive-stopped',
        `scanned=${result.scanned} archived=${result.archived} skipped=${result.skipped} collisions=${result.collisions}`
      );
    });
    if (archiveOk) {
      markMaintenanceStepSuccess(
        nextState,
        nowMs,
        'lastArchiveStoppedSweep',
        'lastArchiveStoppedSweepFailed',
      );
    } else {
      markMaintenanceStepFailure(nextState, nowMs, 'lastArchiveStoppedSweepFailed');
    }
  }

  if (reapDue) {
    const reapOk = await runStep('reap-workspaces', () => {
      const workspaceRootDir = resolveRemediationWorkspaceRootImpl({ rootDir: ROOT });
      const result = reapTerminalFollowUpWorkspacesImpl({
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
    if (reapOk) {
      markMaintenanceStepSuccess(
        nextState,
        nowMs,
        'lastReapTerminalWorkspacesSweep',
        'lastReapTerminalWorkspacesSweepFailed',
      );
    } else {
      markMaintenanceStepFailure(nextState, nowMs, 'lastReapTerminalWorkspacesSweepFailed');
    }
  }

  const persisted = updateCurrentMaintenanceSweepState(
    normalizeMaintenanceSweepState(nextState),
    statePath,
  );
  if (!persisted && statePath === MAINTENANCE_SWEEP_STATE_PATH) {
    const failedState = { ...state };
    if (archiveDue) {
      markMaintenanceStepFailure(failedState, nowMs, 'lastArchiveStoppedSweepFailed');
    }
    if (reapDue) {
      markMaintenanceStepFailure(failedState, nowMs, 'lastReapTerminalWorkspacesSweepFailed');
    }
    rememberDefaultMaintenanceSweepState(failedState);
  }
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

function resolveTelemetryListenerStartTimeoutMs(env = process.env) {
  const raw = env.ADVERSARIAL_REVIEW_TELEMETRY_LISTENER_START_TIMEOUT_MS;
  if (raw == null || raw === '') return TELEMETRY_LISTENER_START_TIMEOUT_DEFAULT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : TELEMETRY_LISTENER_START_TIMEOUT_DEFAULT_MS;
}

async function startFollowUpTelemetryListener({
  rootDir = ROOT,
  env = process.env,
  connectFollowUpTelemetryListenerImpl = connectFollowUpTelemetryListener,
  log = console,
} = {}) {
  const timeoutMs = resolveTelemetryListenerStartTimeoutMs(env);
  let timeoutId = null;
  let timedOut = false;
  try {
    const connectPromise = Promise.resolve().then(() => (
      connectFollowUpTelemetryListenerImpl({ rootDir, env, log })
    ));
    connectPromise.catch((err) => {
      if (timedOut) {
        log.error?.(
          `[follow-up-daemon ${ts()}] App Contract telemetry listener late failure: ${err?.message || err}`
        );
      }
    });
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        reject(new Error(`telemetry listener startup timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const listener = await Promise.race([connectPromise, timeoutPromise]);
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (listener?.subscriptions?.length) {
      log.log?.(
        `[follow-up-daemon ${ts()}] App Contract telemetry listener registered ` +
        `subscriptions=${listener.subscriptions.join(',')}`
      );
    } else {
      log.log?.(`[follow-up-daemon ${ts()}] App Contract telemetry listener skipped; no health.worker subscriptions configured`);
    }
    return listener;
  } catch (err) {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    log.error?.(
      `[follow-up-daemon ${ts()}] App Contract telemetry listener disabled: ${err?.message || err}`
    );
    return null;
  }
}

async function main() {
  if (process.argv.includes('--with-hq-integration')) {
    process.env.ADV_WITH_HQ_INTEGRATION = '1';
  }
  installSignalHandlers();
  const telemetryListener = await startFollowUpTelemetryListener();
  logInfo(
    `startup complete; entering tick loop (interval=${TICK_INTERVAL_SECONDS}s ` +
    `${REMEDIATION_MAX_CONCURRENT_JOBS_ENV}=${MAX_CONCURRENT_REMEDIATION_JOBS})`
  );

  while (!stopping) {
    // Keep the broker-minted reviewer GitHub App tokens fresh BEFORE any step
    // that touches GitHub. This long-lived daemon resolved GH_*_REVIEWER_TOKEN
    // once at startup; App installation tokens expire ~1h, so without this the
    // remediation reply-comment POSTs (and the tokens that spawned remediation
    // workers inherit) start failing with HTTP 401 about an hour after each
    // (re)start — the watcher got this fix in pollOnce, the follow-up daemon did
    // not, so its comments silently stopped posting. TTL-gated + fail-safe (keeps
    // the existing token on any broker error; never throws). Runs first so the
    // same-tick `consume` (spawns workers that snapshot env) and `retry-comments`
    // both see the refreshed token. The daemon passes an explicit remediation
    // handoff floor instead of reusing the reviewer timeout default: detached
    // remediation workers can validly outlive a reviewer subprocess and still
    // need their inherited GitHub token for final fetch/push/comment operations.
    let reviewerTokenRefreshSummary = null;
    await runStep('reviewer-token-refresh', async () => {
      reviewerTokenRefreshSummary = await refreshReviewerBrokerTokens({
        log: console,
        minTokenLifetimeMs: resolveRemediationWorkerTokenMinLifetimeMs(process.env),
      });
    });
    if (stopping) break;
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
    await runStep('closer-worktree-reap', async () => {
      const result = await reapCloserHammerWorktrees({ logger: console });
      logTick(
        'closer-worktree-reap',
        `scanned=${result.scanned} reaped=${result.reaped} skipped=${result.skipped} ` +
        `terminal=${result.terminal} prunable=${result.prunable} ` +
        `halfRegistered=${result.halfRegistered} open=${result.open} ` +
        `unknown=${result.unknown} errors=${result.errors} limit=${result.limit}`
      );
    });
    if (stopping) break;
    if (shouldConsumeAfterReviewerTokenRefresh(reviewerTokenRefreshSummary)) {
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
    } else {
      logTick(
        'consume',
        `skipped unsafe reviewer token handoff roles=${describeUnsafeReviewerTokenHandoff(reviewerTokenRefreshSummary)}`
      );
    }
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
  telemetryListener?.dispose?.();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    logError(`fatal: ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
}

export {
  main,
  resolveRemediationWorkerTokenMinLifetimeMs,
  resolveTelemetryListenerStartTimeoutMs,
  normalizeMaintenanceSweepState,
  readMaintenanceSweepState,
  reviewerTokenHandoffUnsafeRoles,
  runStoppedArchiveSweepIfDue,
  shouldConsumeAfterReviewerTokenRefresh,
  startFollowUpTelemetryListener,
  writeMaintenanceSweepState,
};
