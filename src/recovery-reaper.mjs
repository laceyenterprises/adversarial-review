/**
 * Startup + periodic stale-state reaper — offline-period & quota-outage
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
 * CLR-02 closed three compounding gaps that made this reclaimer a no-op in
 * practice (SEV `closer-lease-reaper-runs-only-at-watcher-startup`, 2026-08-26;
 * 11 of 11 non-terminal leases stale, every holder pid dead, 0 reclaimed):
 *
 *   a. The sweep only ever ran at watcher startup, so between restarts nothing
 *      reclaimed an orphaned lease. `createStaleStateReaperTicker` now drives
 *      the same sweep from the poll loop on a low-frequency tick.
 *
 *   b. The 6h floor was the only tier, so a lease whose holder was *provably*
 *      dead still waited six hours. `holderHost` + `isProcessAlive` now give a
 *      dead-holder-on-this-host tier at the same 30m the health surface pages
 *      at. The 6h floor is unchanged for every lease we cannot prove dead.
 *
 *   c. Terminal leases were never retired, so a 250-entry/50-read bounded scan
 *      was spent on 50-day-old finished records instead of live ones.
 *      `selectPrunableCloserLeases` retires them behind a conservative age gate.
 *
 * @module recovery-reaper
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  opendirSync,
  promises as fsPromises,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

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
// Dead-holder tier. Deliberately equal to the health surface's
// `amaCloserLeaseMaxAgeMs` (30m) and to `AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS`
// in ama/dispatch-closer.mjs, so detection and remediation stop disagreeing by
// 12x. It applies ONLY when the lease names this host in `holderHost` AND the
// recorded pid is dead here — strictly more evidence than the dispatch path
// already acts on at the same age, and never a substitute for the 6h floor.
export const DEFAULT_DEAD_HOLDER_CLOSER_LEASE_MS = 30 * 60 * 1000;
// Terminal-lease retirement. 7d is the smallest age that restores full-coverage
// scanning on the observed host directory: 575 leases, 560 of them terminal with
// a resolved outcome, oldest 50.4d. Pruning at 7d retires 452 and leaves ~123 —
// back under DEFAULT_CLOSER_LEASE_ENTRY_SCAN_LIMIT, so one pass sees the whole
// directory again. 14d would leave 279 and keep the scan a sampling problem.
export const DEFAULT_TERMINAL_CLOSER_LEASE_PRUNE_MS = 7 * 24 * HOUR_MS;
// Poll-loop cadence for the periodic sweep. Long relative to a poll interval:
// the sweep is recovery, not a hot path, and its own thresholds are 30m+.
export const DEFAULT_STALE_STATE_REAPER_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_CLOSER_LEASE_ENTRY_SCAN_LIMIT = 250;
export const DEFAULT_CLOSER_LEASE_READ_LIMIT = 50;

const LEASE_DIR_SEGMENTS = ['data', 'ama-closer-leases'];
const REAPER_STATE_DIR_SEGMENTS = ['data', 'recovery-reaper'];
const CLOSER_LEASE_CURSOR_FILE = 'closer-lease-cursor.json';

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

/**
 * Threshold (ms) past which a non-terminal AMA closer lease whose holder is
 * *provably dead on this host* is released, without waiting for the full
 * `resolveStaleCloserLeaseMs` floor. Env alias:
 * `ADVERSARIAL_DEAD_HOLDER_CLOSER_LEASE_MS`.
 */
export function resolveDeadHolderCloserLeaseMs(env = process.env) {
  return resolvePositiveMs(
    env.ADVERSARIAL_DEAD_HOLDER_CLOSER_LEASE_MS,
    DEFAULT_DEAD_HOLDER_CLOSER_LEASE_MS,
  );
}

/**
 * Age (ms) past which a finished (`status='terminal'` with a resolved
 * `terminalOutcome`) closer lease is deleted so the bounded scan is spent on
 * live records. `0` / `off` disables pruning entirely — this is deletion of
 * live-host state, so operators get an explicit kill switch. Env alias:
 * `ADVERSARIAL_TERMINAL_CLOSER_LEASE_PRUNE_MS`.
 */
export function resolveTerminalCloserLeasePruneMs(env = process.env) {
  const raw = env.ADVERSARIAL_TERMINAL_CLOSER_LEASE_PRUNE_MS;
  const normalized = raw == null ? '' : String(raw).trim().toLowerCase();
  if (normalized === '0' || normalized === 'off' || normalized === 'false') return 0;
  return resolvePositiveMs(raw, DEFAULT_TERMINAL_CLOSER_LEASE_PRUNE_MS);
}

/**
 * Minimum spacing (ms) between periodic stale-state sweeps driven from the
 * watcher poll loop. Env alias: `ADVERSARIAL_STALE_STATE_REAPER_INTERVAL_MS`.
 */
export function resolveStaleStateReaperIntervalMs(env = process.env) {
  return resolvePositiveMs(
    env.ADVERSARIAL_STALE_STATE_REAPER_INTERVAL_MS,
    DEFAULT_STALE_STATE_REAPER_INTERVAL_MS,
  );
}

export function resolveCloserLeaseEntryScanLimit(env = process.env) {
  return resolvePositiveMs(
    env.ADVERSARIAL_STALE_CLOSER_LEASE_ENTRY_SCAN_LIMIT,
    DEFAULT_CLOSER_LEASE_ENTRY_SCAN_LIMIT,
  );
}

export function resolveCloserLeaseReadLimit(env = process.env) {
  return resolvePositiveMs(
    env.ADVERSARIAL_STALE_CLOSER_LEASE_READ_LIMIT,
    DEFAULT_CLOSER_LEASE_READ_LIMIT,
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
 * Pure — is this lease's holder provably dead *on this host*?
 *
 * Three things must all hold, and any one of them being unknown answers `false`
 * (keep the lease). This is the only reason the reaper is allowed to act before
 * the multi-hour floor, so it fails closed on every ambiguity:
 *
 *   1. The lease names a host and it is this host. A pid read here says nothing
 *      about a process on another host, and pid namespaces collide — which is
 *      why leases written before CLR-02 (no `holderHost`) get the 6h floor.
 *   2. `watcherPid` is a usable pid.
 *   3. `isProcessAlive(pid)` returns exactly `false`. A throw, or any non-false
 *      answer, is read as "still alive".
 */
function holderIsProvablyDeadHere(lease, { isProcessAlive, host }) {
  if (typeof isProcessAlive !== 'function') return false;
  const leaseHost = lease?.holderHost;
  if (!leaseHost || String(leaseHost) !== String(host)) return false;
  const pid = Number(lease?.watcherPid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    return isProcessAlive(pid) === false;
  } catch {
    return false;
  }
}

/**
 * Pure — given closer-lease records, return the subset to release: not yet
 * `terminal`, `terminalOutcome` still null, and older than `thresholdMs`. A
 * lease still owned by the live watcher process (`watcherPid === livePid`) is
 * never released. Corrupt lease files are also age-gated by file mtime so a
 * concurrent non-atomic writer is given time to finish before recovery unlinks
 * the lease.
 *
 * Two-tier ageing (CLR-02). `thresholdMs` is the floor for a lease whose holder
 * we cannot prove dead — unknown host, unknown pid, or a pid that answers alive.
 * When `deadHolderThresholdMs` is supplied AND the lease is provably dead here
 * (see `holderIsProvablyDeadHere`), the shorter threshold applies instead. The
 * floor is never bypassed on a guess; it is bypassed only on positive evidence
 * that nothing is holding the lease.
 *
 * @param {Array<object>} leases  each `{ ...lease, _path }`
 * @param {{ now:any, thresholdMs:number, livePid?:number,
 *          deadHolderThresholdMs?:number, isProcessAlive?:function, host?:string }} opts
 * @returns {Array<object>}
 */
export function selectReleasableCloserLeases(leases, {
  now,
  thresholdMs,
  livePid = null,
  deadHolderThresholdMs = null,
  isProcessAlive = null,
  host = null,
} = {}) {
  const nowMs = parseTimestampMs(now) ?? (now instanceof Date ? now.getTime() : Number(now));
  if (!Number.isFinite(nowMs) || !Number.isFinite(Number(thresholdMs))) return [];
  const localHost = host ?? hostname();
  const deadHolderMs = Number(deadHolderThresholdMs);
  const deadHolderTierEnabled = Number.isFinite(deadHolderMs) && deadHolderMs > 0;
  return (Array.isArray(leases) ? leases : []).filter((lease) => {
    if (!lease) return false;
    if (lease._isCorrupt === true) {
      // A file we could not parse carries no holder identity, so the dead-holder
      // tier can never apply to it; the mtime floor stays its only gate.
      const mtimeMs = Number(lease.mtimeMs);
      return Number.isFinite(mtimeMs) && nowMs - mtimeMs >= Number(thresholdMs);
    }
    if (String(lease.status || '') === 'terminal') return false;
    if (lease.terminalOutcome != null) return false;
    if (livePid != null && Number(lease.watcherPid) === Number(livePid)) return false;
    const stampMs = parseTimestampMs(lease.updatedAt) ?? parseTimestampMs(lease.acquiredAt);
    if (stampMs == null) return false;
    const ageMs = nowMs - stampMs;
    if (ageMs >= Number(thresholdMs)) return true;
    if (!deadHolderTierEnabled) return false;
    if (!holderIsProvablyDeadHere(lease, { isProcessAlive, host: localHost })) return false;
    return ageMs >= deadHolderMs;
  });
}

/**
 * Pure — given closer-lease records, return the subset to retire.
 *
 * A lease is duplicate-dispatch protection for one `(repo, pr, head)`. Once it
 * is `terminal` with a resolved `terminalOutcome` that job is over and the file
 * is pure cleanup debt — but the bounded scan still pays to read it, which is
 * how a 574-file directory that is 98% finished records starved reclamation of
 * the live ones.
 *
 * This deletes live-host state, so every gate fails closed:
 *   - never a lease that is not `terminal` (the reaper must not race a closer);
 *   - never a lease whose `terminalOutcome` is still null — `terminal` without
 *     an outcome is an unfinished reconciliation, not finished work;
 *   - never a corrupt record (we cannot know what it was);
 *   - never a record we cannot age;
 *   - and only past `pruneAfterMs`, which is days, not the reclaim thresholds.
 *
 * @param {Array<object>} leases  each `{ ...lease, _path }`
 * @param {{ now:any, pruneAfterMs:number }} opts
 * @returns {Array<object>}
 */
export function selectPrunableCloserLeases(leases, { now, pruneAfterMs } = {}) {
  const nowMs = parseTimestampMs(now) ?? (now instanceof Date ? now.getTime() : Number(now));
  const pruneMs = Number(pruneAfterMs);
  if (!Number.isFinite(nowMs) || !Number.isFinite(pruneMs) || pruneMs <= 0) return [];
  return (Array.isArray(leases) ? leases : []).filter((lease) => {
    if (!lease) return false;
    if (lease._isCorrupt === true) return false;
    if (String(lease.status || '') !== 'terminal') return false;
    if (lease.terminalOutcome == null) return false;
    const stampMs = parseTimestampMs(lease.completedAt)
      ?? parseTimestampMs(lease.updatedAt)
      ?? parseTimestampMs(lease.acquiredAt);
    if (stampMs == null) return false;
    return nowMs - stampMs >= pruneMs;
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

function closerLeaseCursorPath(rootDir) {
  return join(rootDir, ...REAPER_STATE_DIR_SEGMENTS, CLOSER_LEASE_CURSOR_FILE);
}

function readCloserLeaseCursor(rootDir, logger = console) {
  try {
    const parsed = JSON.parse(readFileSync(closerLeaseCursorPath(rootDir), 'utf8'));
    if (
      parsed
      && typeof parsed === 'object'
      && (typeof parsed.lastEntryName === 'string' || parsed.lastEntryName === null)
    ) {
      const entriesSeen = Number(parsed.entriesSeen);
      return {
        lastEntryName: parsed.lastEntryName,
        entriesSeen: Number.isFinite(entriesSeen) && entriesSeen >= 0 ? Math.floor(entriesSeen) : 0,
      };
    }
  } catch (err) {
    if (err?.code !== 'ENOENT' && !(err instanceof SyntaxError)) {
      logger?.error?.(`[reaper] failed to read closer lease cursor: ${err?.message || err}`);
    }
  }
  return { lastEntryName: null, entriesSeen: 0 };
}

function writeJsonAtomic(filePath, value) {
  const parentDir = dirname(filePath);
  mkdirSync(parentDir, { recursive: true });
  const tmpPath = join(
    parentDir,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let fd = null;
  try {
    fd = openSync(tmpPath, 'wx', 0o640);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      rmSync(tmpPath, { force: true });
    } catch {}
    throw err;
  }
}

function persistCloserLeaseCursor(rootDir, { lastEntryName, entriesSeen }, logger = console) {
  if (!lastEntryName && !entriesSeen) return false;
  try {
    writeJsonAtomic(closerLeaseCursorPath(rootDir), {
      schemaVersion: 2,
      lastEntryName: lastEntryName || null,
      entriesSeen: Math.max(0, Math.floor(Number(entriesSeen) || 0)),
      updatedAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    logger?.error?.(`[reaper] failed to persist closer lease cursor: ${err?.message || err}`);
    return false;
  }
}

function retainLexicallySmallest(names, name, limit) {
  if (limit <= 0) return;
  if (names.length < limit) {
    names.push(name);
    let index = names.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (names[parent] >= names[index]) break;
      [names[parent], names[index]] = [names[index], names[parent]];
      index = parent;
    }
    return;
  }
  if (name >= names[0]) return;
  names[0] = name;
  let index = 0;
  while (true) {
    const left = (index * 2) + 1;
    const right = left + 1;
    let largest = index;
    if (left < names.length && names[left] > names[largest]) largest = left;
    if (right < names.length && names[right] > names[largest]) largest = right;
    if (largest === index) break;
    [names[index], names[largest]] = [names[largest], names[index]];
    index = largest;
  }
}

function readDirectoryEntryNames(dir, {
  entryScanLimit = DEFAULT_CLOSER_LEASE_ENTRY_SCAN_LIMIT,
  lastEntryName = null,
  opendirSyncImpl = opendirSync,
} = {}) {
  const limit = Math.max(0, Number(entryScanLimit) || 0);
  const namesAfterCursor = [];
  const namesAtStart = [];
  let skippedEntries = 0;
  let directoryReads = 0;
  let iterator = null;
  try {
    iterator = opendirSyncImpl(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        names: [],
        scannedEntries: 0,
        skippedEntries: 0,
        directoryReads: 0,
        startOffset: 0,
        wrapped: false,
      };
    }
    throw err;
  }
  try {
    while (true) {
      directoryReads += 1;
      const entry = iterator.readSync();
      if (!entry) break;
      if (!lastEntryName || entry.name > lastEntryName) {
        retainLexicallySmallest(namesAfterCursor, entry.name, limit);
      } else {
        skippedEntries += 1;
      }
      if (lastEntryName) {
        retainLexicallySmallest(namesAtStart, entry.name, limit);
      }
    }
  } finally {
    iterator.closeSync?.();
  }
  const wrapped = Boolean(lastEntryName) && namesAfterCursor.length === 0;
  const names = (wrapped ? namesAtStart : namesAfterCursor).sort();
  const startOffset = wrapped ? 0 : skippedEntries;
  return {
    names,
    scannedEntries: names.length,
    skippedEntries: wrapped ? 0 : skippedEntries,
    directoryReads,
    startOffset,
    wrapped,
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  const workerCount = Math.min(items.length, Math.max(1, Number(concurrency) || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function readLeaseRecords(rootDir, {
  logger = console,
  entryScanLimit = DEFAULT_CLOSER_LEASE_ENTRY_SCAN_LIMIT,
  readLimit = DEFAULT_CLOSER_LEASE_READ_LIMIT,
  readConcurrency = 8,
  opendirSyncImpl = opendirSync,
  readFileImpl = fsPromises.readFile,
  statImpl = fsPromises.stat,
} = {}) {
  const dir = leaseDirPath(rootDir);
  const cursor = readCloserLeaseCursor(rootDir, logger);
  const discovery = readDirectoryEntryNames(dir, {
    entryScanLimit,
    lastEntryName: cursor.lastEntryName,
    opendirSyncImpl,
  });
  const names = discovery.names;
  const records = [];
  const candidates = [];
  let lastEntryName = null;
  let lastSafeIndex = -1;
  let readLimitReached = false;
  const maxReads = Math.max(0, Number(readLimit) || 0);
  for (const [index, name] of names.entries()) {
    if (!name.endsWith('.json')) {
      lastEntryName = name;
      lastSafeIndex = index;
      continue;
    }
    if (candidates.length >= maxReads) {
      readLimitReached = true;
      break;
    }
    candidates.push({ index, name, path: join(dir, name) });
  }
  const outcomes = await mapWithConcurrency(candidates, readConcurrency, async ({ index, name, path }) => {
    try {
      const lease = JSON.parse(await readFileImpl(path, 'utf8'));
      return {
        index,
        name,
        record: lease && typeof lease === 'object' ? { ...lease, _path: path } : null,
      };
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return { index, name, record: null };
      } else if (err instanceof SyntaxError) {
        let mtimeMs = null;
        try {
          mtimeMs = (await statImpl(path)).mtimeMs;
        } catch {
          mtimeMs = null;
        }
        return {
          index,
          name,
          record: {
            _path: path,
            _isCorrupt: true,
            mtimeMs,
            status: 'corrupt',
            terminalOutcome: null,
            updatedAt: 0,
          },
        };
      }
      return { index, name, path, error: err, record: null };
    }
  });
  for (const outcome of outcomes) {
    if (outcome.record) records.push(outcome.record);
    if (outcome.error) {
      logger?.error?.(`[reaper] failed to read lease ${outcome.path}: ${outcome.error?.message || outcome.error}`);
    }
    // All selected reads settled, so cursor advancement remains ordered even
    // though I/O was concurrent. Persistent failures retry after one rotation.
    lastEntryName = outcome.name;
    lastSafeIndex = outcome.index;
  }
  if (discovery.wrapped && names.length === 0) {
    lastEntryName = null;
    lastSafeIndex = -1;
  }
  const entriesSeen = lastSafeIndex >= 0 ? lastSafeIndex + 1 : 0;
  return {
    records,
    scannedEntries: discovery.scannedEntries,
    skippedEntries: discovery.skippedEntries,
    directoryReads: discovery.directoryReads,
    cursorEntriesSeen: entriesSeen,
    readRecords: candidates.length,
    cursorCanAdvance: readLimitReached || names.length > 0 || discovery.wrapped,
    lastEntryName,
  };
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
 * re-dispatch the merge for that head, reset any redispatch budget that a
 * transient outage exhausted, and retire finished leases so the bounded scan
 * keeps covering live ones.
 *
 * Release and prune share one read budget by construction: both decide from the
 * same already-read page, so bounding the directory costs no extra I/O.
 *
 * @returns {{ released: number, pruned: number, budgetsReset: number, leases: Array<object>, prunedLeases: Array<object>, scannedEntries: number, readRecords: number }}
 */
export async function reapStaleCloserLeases({
  rootDir,
  now = new Date().toISOString(),
  thresholdMs = DEFAULT_STALE_CLOSER_LEASE_MS,
  deadHolderThresholdMs = DEFAULT_DEAD_HOLDER_CLOSER_LEASE_MS,
  pruneAfterMs = DEFAULT_TERMINAL_CLOSER_LEASE_PRUNE_MS,
  livePid = (typeof process !== 'undefined' ? process.pid : null),
  isProcessAlive = null,
  host = null,
  entryScanLimit = DEFAULT_CLOSER_LEASE_ENTRY_SCAN_LIMIT,
  readLimit = DEFAULT_CLOSER_LEASE_READ_LIMIT,
  readConcurrency = 8,
  opendirSyncImpl = opendirSync,
  readFileImpl = fsPromises.readFile,
  statImpl = fsPromises.stat,
  logger = console,
} = {}) {
  if (!rootDir) {
    return {
      released: 0, pruned: 0, budgetsReset: 0, leases: [], prunedLeases: [],
      scannedEntries: 0, readRecords: 0,
    };
  }
  const discovery = await readLeaseRecords(rootDir, {
    logger,
    entryScanLimit,
    readLimit,
    readConcurrency,
    opendirSyncImpl,
    readFileImpl,
    statImpl,
  });
  const releasable = selectReleasableCloserLeases(discovery.records, {
    now, thresholdMs, livePid, deadHolderThresholdMs, isProcessAlive, host,
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
  const prunable = selectPrunableCloserLeases(discovery.records, { now, pruneAfterMs });
  let pruned = 0;
  const prunedLeases = [];
  for (const lease of prunable) {
    try {
      rmSync(lease._path, { force: true });
      pruned += 1;
      prunedLeases.push(lease);
    } catch (err) {
      logger?.error?.(`[reaper] failed to prune terminal lease ${lease._path}: ${err?.message || err}`);
    }
  }
  if (pruned > 0) {
    // One aggregate line, not one per file: a first sweep of a long-unpruned
    // directory retires tens of leases per pass and per-file logging would bury
    // the release warnings that an operator actually needs to see.
    const sample = prunedLeases[prunedLeases.length - 1];
    logger?.log?.(
      `[reaper] pruned ${pruned} finished closer lease(s) older than `
      + `${Math.floor(Number(pruneAfterMs) / HOUR_MS)}h `
      + `(e.g. repo=${sample?.repo} pr=${sample?.prNumber} outcome=${sample?.terminalOutcome})`,
    );
  }
  const cursorPersisted = discovery.cursorCanAdvance
    ? persistCloserLeaseCursor(rootDir, {
      lastEntryName: discovery.lastEntryName,
      entriesSeen: discovery.cursorEntriesSeen,
    }, logger)
    : false;
  return {
    released,
    pruned,
    budgetsReset,
    leases: releasable,
    prunedLeases,
    scannedEntries: discovery.scannedEntries,
    skippedEntries: discovery.skippedEntries,
    directoryReads: discovery.directoryReads,
    cursorEntriesSeen: discovery.cursorEntriesSeen,
    readRecords: discovery.readRecords,
    cursorPersisted,
  };
}

/**
 * Orchestrator — run both reapers once. Never throws: a reaper failure must not
 * prevent the watcher from starting to poll, nor stall a poll once it has.
 *
 * `phase` only labels the summary line; startup and periodic sweeps are the
 * same work against the same thresholds. Sharing one implementation is the
 * point — a periodic tick that drifted from the startup path would recreate the
 * exact class of bug CLR-02 fixes.
 *
 * @param {{ phase?: 'startup'|'periodic' }} args
 * @returns {{ reviewerPasses: object, closerLeases: object }}
 */
export async function runStaleStateReaper({
  rootDir,
  db,
  env = process.env,
  now = new Date().toISOString(),
  logger = console,
  isProcessAlive = null,
  phase = 'periodic',
} = {}) {
  const out = {
    reviewerPasses: { reaped: 0, passes: [] },
    closerLeases: {
      released: 0, pruned: 0, budgetsReset: 0, leases: [], prunedLeases: [],
      scannedEntries: 0, readRecords: 0,
    },
  };
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
    out.closerLeases = await reapStaleCloserLeases({
      rootDir,
      now,
      thresholdMs: resolveStaleCloserLeaseMs(env),
      deadHolderThresholdMs: resolveDeadHolderCloserLeaseMs(env),
      pruneAfterMs: resolveTerminalCloserLeasePruneMs(env),
      isProcessAlive,
      entryScanLimit: resolveCloserLeaseEntryScanLimit(env),
      readLimit: resolveCloserLeaseReadLimit(env),
      logger,
    });
  } catch (err) {
    logger?.error?.(`[reaper] closer-lease sweep failed: ${err?.message || err}`);
  }
  if (
    out.reviewerPasses.reaped > 0
    || out.closerLeases.released > 0
    || out.closerLeases.pruned > 0
  ) {
    logger?.log?.(
      `[reaper] ${phase} stale-state sweep: reaped ${out.reviewerPasses.reaped} running reviewer pass(es), `
      + `released ${out.closerLeases.released} closer lease(s), `
      + `pruned ${out.closerLeases.pruned} finished closer lease(s), `
      + `reset ${out.closerLeases.budgetsReset} transient-exhausted budget(s)`,
    );
  }
  return out;
}

/**
 * Orchestrator — the startup sweep. Kept as its own export so the watcher's
 * startup reconciliation block and the `[reaper] startup stale-state sweep:`
 * log line operators already grep for both stay exactly as they were.
 */
export async function runStartupStaleStateReaper(args = {}) {
  return runStaleStateReaper({ ...args, phase: 'startup' });
}

/**
 * Drive the stale-state sweep from the watcher poll loop.
 *
 * The bug this exists for: `runStartupStaleStateReaper` had exactly one call
 * site, above the poll loop, so a reclaimer that demonstrably works
 * (`released 18 closer lease(s)` in the live log) ran once per process lifetime
 * and never again. A watcher that stays up for a day reclaims nothing for a day.
 *
 * Contract:
 *   - `tick()` is a no-op until `intervalMs` has elapsed since the last run, so
 *     it is safe to call unconditionally from every poll;
 *   - the clock starts at construction, because the caller has just run the
 *     startup sweep — the first periodic sweep is one interval later, not
 *     immediately;
 *   - a sweep already in flight is never re-entered (a poll can outrun one);
 *   - it never throws and never rejects. `runStaleStateReaper` already swallows
 *     per-sweep failures; this catch covers the scaffolding itself, because the
 *     one thing recovery must never do is stop the watcher from polling.
 *
 * @returns {{ intervalMs: number, tick: (opts?: {nowMs?: number}) => Promise<{ran: boolean, reason?: string, result?: object, error?: Error}> }}
 */
export function createStaleStateReaperTicker({
  rootDir,
  db,
  env = process.env,
  logger = console,
  isProcessAlive = null,
  intervalMs = null,
  nowMsImpl = Date.now,
  lastRunAtMs = null,
} = {}) {
  const tickIntervalMs = Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0
    ? Math.floor(Number(intervalMs))
    : resolveStaleStateReaperIntervalMs(env);
  let lastRunMs = Number.isFinite(Number(lastRunAtMs)) ? Number(lastRunAtMs) : nowMsImpl();
  let inFlight = false;
  return {
    intervalMs: tickIntervalMs,
    async tick({ nowMs = nowMsImpl() } = {}) {
      if (inFlight) return { ran: false, reason: 'in-flight' };
      if (nowMs - lastRunMs < tickIntervalMs) return { ran: false, reason: 'interval-not-elapsed' };
      inFlight = true;
      try {
        const result = await runStaleStateReaper({
          rootDir,
          db,
          env,
          now: new Date(nowMs).toISOString(),
          logger,
          isProcessAlive,
          phase: 'periodic',
        });
        return { ran: true, result };
      } catch (err) {
        logger?.error?.(`[reaper] periodic stale-state sweep failed: ${err?.message || err}`);
        return { ran: false, reason: 'error', error: err };
      } finally {
        // Advance on failure too: a sweep that throws every time must not turn
        // into a per-poll retry storm against the same broken filesystem.
        lastRunMs = nowMs;
        inFlight = false;
      }
    },
  };
}
