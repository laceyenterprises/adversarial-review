// Historical diagnostic storage only. NXA-07 removes counter-based route
// selection; nextAction owns successors. Old files remain readable/clearable.
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';

// Disagreements tolerated on one head before escalating. A single tick can
// disagree for benign reasons (the closer reads the watcher's candidate
// snapshot, the daemon a fresh live rollup), so the first few are only logged.
// Same K as the AMA retain-loop cap: the (K+1)th observation escalates.
export const DAEMON_ROUTE_DISAGREEMENT_BOUND = 3;
export const DAEMON_ROUTE_DISAGREEMENT_REASON = 'daemon-route-disagreement';
// Wall-clock a head may keep declining only on transient reads before the
// watcher logs it as stuck. GitHub settles mergeability in seconds to minutes.
export const MERGEABILITY_UNKNOWN_STUCK_MS = 30 * 60 * 1000;

const SCHEMA_VERSION = 1;

function ledgerDir(rootDir) {
  return join(rootDir, 'data', 'follow-up-jobs', 'daemon-route-disagreement');
}

function sanitizePathSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

export function daemonRouteDisagreementFilePath(rootDir, { repo, prNumber } = {}) {
  const safeRepo = sanitizePathSegment(String(repo ?? '').replace(/\//g, '__'));
  // Keyed per PR; the head lives inside the doc so a new head resets the count
  // without leaving one file per head behind.
  return join(ledgerDir(rootDir), `${safeRepo}-pr-${Number(prNumber)}.json`);
}

export function daemonRouteTransientReadFilePath(rootDir, identity = {}) {
  return daemonRouteDisagreementFilePath(rootDir, identity).replace(/\.json$/, '.transient.json');
}

function normalizeHead(value) {
  const str = String(value ?? '').trim();
  return str.length ? str : null;
}

function readLedger(rootDir, identity, logger) {
  const filePath = daemonRouteDisagreementFilePath(rootDir, identity);
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    // Absent is the normal first observation. Anything else restarts the
    // series: this ledger only escalates, so reading low costs at most a few
    // more logged ticks, never a merge.
    if (err?.code !== 'ENOENT') {
      logger?.warn?.(
        `[daemon-route-disagreement] unreadable ledger ${filePath} ` +
          `(${err?.code || err?.message || 'unknown'}); treating as a fresh series`,
      );
    }
    return null;
  }
}

/**
 * The daemon's decline, reduced to the fields the log and alert carry.
 */
export function daemonDeclineSummary(daemonCleanMerge) {
  return {
    daemonDisposition: daemonCleanMerge?.disposition || null,
    daemonReason: String(daemonCleanMerge?.reason || 'daemon-result-missing'),
    daemonReasons: Array.isArray(daemonCleanMerge?.reasons) ? daemonCleanMerge.reasons.map(String) : [],
  };
}

/**
 * How many disagreements are already on record for `headSha`.
 *
 * @returns {{ count:number, bound:number, boundReached:boolean, headSha:(string|null) }}
 */
export function readDaemonRouteDisagreement(rootDir, identity, {
  headSha,
  bound = DAEMON_ROUTE_DISAGREEMENT_BOUND,
  logger = console,
} = {}) {
  const head = normalizeHead(headSha);
  const ledger = head && rootDir ? readLedger(rootDir, identity, logger) : null;
  const count = ledger && normalizeHead(ledger.headSha) === head
    ? Math.max(0, Number(ledger.count || 0))
    : 0;
  return { count, bound, boundReached: count >= bound, headSha: head };
}

/**
 * Record one disagreement on `headSha` and report whether it is past the bound.
 * Persistence is best-effort: a write failure is logged and the count still
 * returned, so the observation is never silent.
 *
 * @returns {{ count:number, bound:number, escalate:boolean, headSha:(string|null) }}
 */
export function recordDaemonRouteDisagreement(rootDir, identity, {
  headSha,
  daemonCleanMerge = null,
  bound = DAEMON_ROUTE_DISAGREEMENT_BOUND,
  now = new Date().toISOString(),
  logger = console,
} = {}) {
  const head = normalizeHead(headSha);
  const existing = head && rootDir ? readLedger(rootDir, identity, logger) : null;
  const sameHead = Boolean(existing) && normalizeHead(existing.headSha) === head;
  const count = (sameHead ? Math.max(0, Number(existing.count || 0)) : 0) + 1;
  if (head && rootDir) {
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      repo: identity.repo,
      prNumber: Number(identity.prNumber),
      headSha: head,
      count,
      firstObservedAt: (sameHead && existing.firstObservedAt) || now,
      lastObservedAt: now,
      ...daemonDeclineSummary(daemonCleanMerge),
    };
    try {
      mkdirSync(ledgerDir(rootDir), { recursive: true });
      writeFileAtomic(daemonRouteDisagreementFilePath(rootDir, identity), `${JSON.stringify(doc, null, 2)}\n`);
    } catch (err) {
      logger?.warn?.(
        `[daemon-route-disagreement] ledger write failed for ${identity.repo}#${identity.prNumber}: ` +
          `${err?.message || err}`,
      );
    }
  }
  // No head to key on → the series cannot be bounded; keep logging, never escalate.
  return { count, bound, escalate: Boolean(head) && count > bound, headSha: head };
}

export function clearDaemonRouteDisagreement(rootDir, identity) {
  if (!rootDir) return false;
  try {
    rmSync(daemonRouteDisagreementFilePath(rootDir, identity), { force: true });
    rmSync(daemonRouteTransientReadFilePath(rootDir, identity), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Note one transient-only decline on `headSha` and report how long this head has
 * been reading transient. A new head restarts the clock. `stuck` is true once
 * the head has read transient past `stuckMs`; `emitStuck` is true only on the
 * first such observation per head, so the stuck event is logged once.
 * Best-effort like the main ledger: an unreadable or unwritable file restarts
 * the clock rather than failing the tick.
 */
export function noteDaemonRouteTransientRead(rootDir, identity, {
  headSha,
  now = new Date().toISOString(),
  stuckMs = MERGEABILITY_UNKNOWN_STUCK_MS,
  logger = console,
} = {}) {
  const head = normalizeHead(headSha);
  if (!head || !rootDir) return { firstObservedAt: null, elapsedMs: 0, stuck: false, emitStuck: false };
  const filePath = daemonRouteTransientReadFilePath(rootDir, identity);
  let existing = null;
  try {
    existing = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      logger?.warn?.(`[daemon-route-disagreement] unreadable transient ledger ${filePath}; restarting the clock`);
    }
  }
  const sameHead = Boolean(existing) && normalizeHead(existing.headSha) === head;
  const firstObservedAt = (sameHead && existing.firstObservedAt) || now;
  const elapsedMs = Math.max(0, Date.parse(now) - Date.parse(firstObservedAt)) || 0;
  const stuck = elapsedMs >= stuckMs;
  const alreadyReported = sameHead && Boolean(existing.stuckReportedAt);
  const emitStuck = stuck && !alreadyReported;
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    repo: identity.repo,
    prNumber: Number(identity.prNumber),
    headSha: head,
    firstObservedAt,
    lastObservedAt: now,
    stuckReportedAt: alreadyReported ? existing.stuckReportedAt : (emitStuck ? now : null),
  };
  try {
    mkdirSync(ledgerDir(rootDir), { recursive: true });
    writeFileAtomic(filePath, `${JSON.stringify(doc, null, 2)}\n`);
  } catch (err) {
    logger?.warn?.(
      `[daemon-route-disagreement] transient ledger write failed for ${identity.repo}#${identity.prNumber}: ` +
        `${err?.message || err}`,
    );
  }
  return { firstObservedAt, elapsedMs, stuck, emitStuck };
}

/**
 * Pre-closer read: should this tick's closer call skip `daemon-clean-route` and
 * dispatch the capped hammer? True only when the daemon declined again on a
 * head that has already used up its tolerated disagreements, and the caller
 * judged the daemon's gates hammer-remediable.
 */
