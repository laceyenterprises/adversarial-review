/**
 * Startup / periodic stale-state reaper — offline-period & quota-outage
 * resilience for the adversarial-review pipeline.
 *
 * Two recovery gaps surface after a host outage (macOS upgrade + os-restart,
 * a GitHub rate-limit storm, or any window where the watcher is down long
 * enough that in-flight state is abandoned):
 *
 *   1. `reviewer_passes` rows left `status='running'` (ended_at NULL) when the
 *      watcher was killed mid-review. Nothing reaps them, so the PR's review
 *      cycle looks perpetually in-flight and never re-reviews (observed: 17h
 *      zombies after a watcher restart).
 *
 *   2. AMA closer leases left `status=pending|dispatched` with
 *      `terminalOutcome=null` when the closer dispatch died without
 *      reconciling. The per-head lease is duplicate-dispatch protection, so a
 *      never-reconciled lease blocks the closer from ever re-dispatching the
 *      merge for that head.
 *
 * Everything here is age-gated by config-driven thresholds (sane multi-hour
 * defaults) so it only ever touches genuinely-abandoned state, never a live
 * in-flight review or closer. The decision functions are pure so the gating
 * is unit-testable without a DB or filesystem.
 *
 * @module recovery-reaper
 */

import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  AMA_CLOSER_REDISPATCH_BOUND,
  isTransientHqDispatchError,
  readAmaCloserDispatchRecord,
  updateAmaCloserDispatchRecord,
} from './ama/dispatch-closer.mjs';

const HOUR_MS = 60 * 60 * 1000;

// Defaults are deliberately multi-hour: a healthy reviewer pass or closer
// dispatch completes in minutes, so a 6h floor never races live work and still
// recovers same-day after an outage.
export const DEFAULT_STALE_RUNNING_REVIEWER_PASS_MS = 6 * HOUR_MS;
export const DEFAULT_STALE_CLOSER_LEASE_MS = 6 * HOUR_MS;

const LEASE_DIR_SEGMENTS = ['data', 'ama-closer-leases'];

function resolvePositiveMs(rawValue, fallbackMs) {
  if (rawValue == null || String(rawValue).trim() === '') return fallbackMs;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.floor(parsed);
}

/**
 * Threshold (ms) past which a `status='running'` reviewer pass is treated as
 * an abandoned zombie. Env alias: `ADVERSARIAL_STALE_RUNNING_REVIEWER_PASS_MS`.
 */
export function resolveStaleRunningReviewerPassMs(env = process.env) {
  return resolvePositiveMs(
    env.ADVERSARIAL_STALE_RUNNING_REVIEWER_PASS_MS,
    DEFAULT_STALE_RUNNING_REVIEWER_PASS_MS,
  );
}

/**
 * Threshold (ms) past which a non-terminal AMA closer lease is treated as a
 * dead/abandoned lease and released. Env alias:
 * `ADVERSARIAL_STALE_CLOSER_LEASE_MS`.
 */
export function resolveStaleCloserLeaseMs(env = process.env) {
  return resolvePositiveMs(
    env.ADVERSARIAL_STALE_CLOSER_LEASE_MS,
    DEFAULT_STALE_CLOSER_LEASE_MS,
  );
}

function parseTimestampMs(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Pure — given reviewer_passes rows, return the subset that are stale zombies:
 * `status='running'`, no `ended_at`, and `started_at` older than `thresholdMs`.
 * Rows with an unparseable `started_at` are NOT reaped (fail safe: never reap
 * something we can't age).
 *
 * @param {Array<object>} rows
 * @param {{ now: (string|number|Date), thresholdMs: number }} opts
 * @returns {Array<object>}
 */
export function selectStaleRunningReviewerPasses(rows, { now, thresholdMs } = {}) {
  const nowMs = parseTimestampMs(now) ?? (now instanceof Date ? now.getTime() : Number(now));
  if (!Number.isFinite(nowMs) || !Number.isFinite(Number(thresholdMs))) return [];
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (String(row?.status || '') !== 'running') return false;
    if (row?.ended_at) return false;
    const startedMs = parseTimestampMs(row?.started_at);
    if (startedMs == null) return false;
    return nowMs - startedMs >= Number(thresholdMs);
  });
}

/**
 * Pure — given closer-lease records, return the subset to release: not yet
 * `terminal`, `terminalOutcome` still null, and older than `thresholdMs`. A
 * lease still owned by the live watcher process (`watcherPid === livePid`) is
 * never released. When `isProcessAlive` is supplied, a lease whose owning pid
 * is still alive AND is younger than the threshold is skipped; past the
 * threshold the age gate wins (the pid may have been recycled).
 *
 * @param {Array<object>} leases  each `{ ...lease, _path }`
 * @param {{ now:any, thresholdMs:number, livePid?:number,
 *           isProcessAlive?:(pid:number)=>boolean }} opts
 * @returns {Array<object>}
 */
export function selectReleasableCloserLeases(leases, {
  now,
  thresholdMs,
  livePid = null,
  isProcessAlive = null,
} = {}) {
  const nowMs = parseTimestampMs(now) ?? (now instanceof Date ? now.getTime() : Number(now));
  if (!Number.isFinite(nowMs) || !Number.isFinite(Number(thresholdMs))) return [];
  return (Array.isArray(leases) ? leases : []).filter((lease) => {
    if (!lease) return false;
    if (lease._isCorrupt === true) return true;
    if (String(lease.status || '') === 'terminal') return false;
    if (lease.terminalOutcome != null) return false;
    if (livePid != null && Number(lease.watcherPid) === Number(livePid)) return false;
    const stampMs = parseTimestampMs(lease.updatedAt) ?? parseTimestampMs(lease.acquiredAt);
    if (stampMs == null) return false;
    const aged = nowMs - stampMs >= Number(thresholdMs);
    if (aged) return true;
    // Below threshold: only release when we can positively prove the owning
    // watcher process is gone.
    if (typeof isProcessAlive === 'function' && Number.isFinite(Number(lease.watcherPid))) {
      return !isProcessAlive(Number(lease.watcherPid));
    }
    return false;
  });
}

/**
 * DB driver — reap stale `running` reviewer passes to `abandoned` so the PR's
 * review cycle is no longer wedged as in-flight. Operates on an open
 * better-sqlite3 handle (the watcher already holds one).
 *
 * @returns {{ reaped: number, passes: Array<object> }}
 */
export function reapStaleRunningReviewerPasses({
  db,
  now = new Date().toISOString(),
  thresholdMs = DEFAULT_STALE_RUNNING_REVIEWER_PASS_MS,
  logger = console,
} = {}) {
  if (!db) return { reaped: 0, passes: [] };
  const candidates = db.prepare(
    `SELECT pass_id, repo, pr_number, attempt_number, pass_kind, started_at, status, ended_at
       FROM reviewer_passes
      WHERE status = 'running' AND ended_at IS NULL`,
  ).all();
  const stale = selectStaleRunningReviewerPasses(candidates, { now, thresholdMs });
  if (stale.length === 0) return { reaped: 0, passes: [] };
  const nowIso = parseTimestampMs(now) != null ? new Date(parseTimestampMs(now)).toISOString() : String(now);
  const update = db.prepare(
    `UPDATE reviewer_passes
        SET status = 'abandoned', ended_at = ?
      WHERE pass_id = ? AND status = 'running' AND ended_at IS NULL`,
  );
  let reaped = 0;
  for (const pass of stale) {
    const res = update.run(nowIso, pass.pass_id);
    if (res.changes > 0) {
      reaped += 1;
      logger?.warn?.(
        `[reaper] abandoned stale running reviewer pass repo=${pass.repo} pr=${pass.pr_number} `
        + `pass_id=${pass.pass_id} started_at=${pass.started_at} (re-review unblocked)`,
      );
    }
  }
  return { reaped, passes: stale };
}

function leaseDirPath(rootDir) {
  return join(rootDir, ...LEASE_DIR_SEGMENTS);
}

function readLeaseRecords(rootDir, logger = console) {
  const dir = leaseDirPath(rootDir);
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      const lease = JSON.parse(readFileSync(path, 'utf8'));
      if (lease && typeof lease === 'object') records.push({ ...lease, _path: path });
    } catch (err) {
      if (err instanceof SyntaxError) {
        records.push({
          _path: path,
          _isCorrupt: true,
          status: 'corrupt',
          terminalOutcome: null,
          updatedAt: 0,
        });
      } else {
        logger?.error?.(`[reaper] failed to read lease ${path}: ${err?.message || err}`);
      }
    }
  }
  return records;
}

/**
 * Reset a closer's persisted redispatch budget when its lease is being
 * released because the prior failure was transient (rate limit / broker /
 * offline). Without this, a budget already exhausted *by* the outage stays
 * exhausted forever — `dispatch-retry-exhausted` — even after recovery.
 */
function resetTransientExhaustedCloserBudget(rootDir, lease, logger) {
  const identity = { repo: lease.repo, prNumber: lease.prNumber, headSha: lease.headSha };
  let record;
  try {
    record = readAmaCloserDispatchRecord(rootDir, identity);
  } catch {
    return 'failed';
  }
  if (!record) return 'not-needed';
  const exhausted = Number(record.retryCount || 0) >= AMA_CLOSER_REDISPATCH_BOUND;
  if (!exhausted) return 'not-needed';
  const transient = record.lastFailureTransient === true
    || isTransientHqDispatchError({ message: String(record.lastError || '') });
  if (!transient) return 'not-needed';
  try {
    updateAmaCloserDispatchRecord(rootDir, identity, (current) => ({
      ...(current || {}),
      retryCount: 0,
      state: 'dispatch-budget-reset-transient',
      lastFailureTransient: false,
    }));
  } catch (err) {
    logger?.error?.(
      `[reaper] failed to reset transient-exhausted closer budget repo=${lease.repo} `
      + `pr=${lease.prNumber} head=${String(lease.headSha || '').slice(0, 12)}: ${err?.message || err}`,
    );
    return 'failed';
  }
  logger?.warn?.(
    `[reaper] reset transient-exhausted closer budget repo=${lease.repo} pr=${lease.prNumber} `
    + `head=${String(lease.headSha || '').slice(0, 12)} (prior failure was rate-limit/offline-class)`,
  );
  return 'reset';
}

/**
 * FS driver — release stale/dead AMA closer leases so the closer can
 * re-dispatch the merge for that head, and reset any redispatch budget that a
 * transient outage exhausted.
 *
 * @returns {{ released: number, budgetsReset: number, leases: Array<object> }}
 */
export function reapStaleCloserLeases({
  rootDir,
  now = new Date().toISOString(),
  thresholdMs = DEFAULT_STALE_CLOSER_LEASE_MS,
  livePid = (typeof process !== 'undefined' ? process.pid : null),
  isProcessAlive = null,
  logger = console,
} = {}) {
  if (!rootDir) return { released: 0, budgetsReset: 0, leases: [] };
  const leases = readLeaseRecords(rootDir, logger);
  const releasable = selectReleasableCloserLeases(leases, {
    now, thresholdMs, livePid, isProcessAlive,
  });
  let released = 0;
  let budgetsReset = 0;
  for (const lease of releasable) {
    if (lease._isCorrupt !== true) {
      const resetStatus = resetTransientExhaustedCloserBudget(rootDir, lease, logger);
      if (resetStatus === 'failed') {
        continue;
      }
      if (resetStatus === 'reset') {
        budgetsReset += 1;
      }
    }
    try {
      rmSync(lease._path, { force: true });
      released += 1;
      if (lease._isCorrupt === true) {
        logger?.warn?.(
          `[reaper] released corrupt closer lease path=${lease._path} (closer re-dispatch unblocked)`,
        );
      } else {
        logger?.warn?.(
          `[reaper] released stale closer lease repo=${lease.repo} pr=${lease.prNumber} `
          + `head=${String(lease.headSha || '').slice(0, 12)} status=${lease.status} `
          + `updatedAt=${lease.updatedAt || lease.acquiredAt} (closer re-dispatch unblocked)`,
        );
      }
    } catch (err) {
      logger?.error?.(`[reaper] failed to release lease ${lease._path}: ${err?.message || err}`);
    }
  }
  return { released, budgetsReset, leases: releasable };
}

/**
 * Orchestrator — run both reapers once. Called from the watcher startup
 * reconciliation block (and safe to call on a periodic tick). Never throws:
 * a reaper failure must not prevent the watcher from starting to poll.
 *
 * @returns {{ reviewerPasses: object, closerLeases: object }}
 */
export function runStartupStaleStateReaper({
  rootDir,
  db,
  env = process.env,
  now = new Date().toISOString(),
  logger = console,
  isProcessAlive = null,
} = {}) {
  const out = { reviewerPasses: { reaped: 0, passes: [] }, closerLeases: { released: 0, budgetsReset: 0, leases: [] } };
  try {
    out.reviewerPasses = reapStaleRunningReviewerPasses({
      db,
      now,
      thresholdMs: resolveStaleRunningReviewerPassMs(env),
      logger,
    });
  } catch (err) {
    logger?.error?.(`[reaper] reviewer-pass sweep failed: ${err?.message || err}`);
  }
  try {
    out.closerLeases = reapStaleCloserLeases({
      rootDir,
      now,
      thresholdMs: resolveStaleCloserLeaseMs(env),
      isProcessAlive,
      logger,
    });
  } catch (err) {
    logger?.error?.(`[reaper] closer-lease sweep failed: ${err?.message || err}`);
  }
  if (out.reviewerPasses.reaped > 0 || out.closerLeases.released > 0) {
    logger?.log?.(
      `[reaper] startup stale-state sweep: reaped ${out.reviewerPasses.reaped} running reviewer pass(es), `
      + `released ${out.closerLeases.released} closer lease(s), `
      + `reset ${out.closerLeases.budgetsReset} transient-exhausted budget(s)`,
    );
  }
  return out;
}
