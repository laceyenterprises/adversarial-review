import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { execFile } from 'node:child_process';
import { lstatSync, opendirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from '../atomic-write.mjs';
import { meteredExecFile } from '../metered-gh.mjs';
import { withGitHubBudgetScope } from '../rate-limit-throttle.mjs';
import { readLatestWorkerRunStatusFromLedgerAsync, readLaunchRequestStatusFromLedgerAsync } from '../session-ledger-read-adapter.mjs';
import { isTerminalLaunchRequestStatus, withLiveLaunchRetry, launchRequestParked } from './launch-request-status.mjs';
import {
  amaCloserDispatchDir, cleanupHammerScratchDir, isTerminalHammerScratchRecord,
  hammerScratchLeaseHeld,
} from './dispatch-closer.mjs';
import { AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS, AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS, amaCloserPendingLeaseExpiryMs } from './closer-lease.mjs';

export const HAMMER_SCRATCH_MAX_AGE_MS = 4 * AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS;
// Give an inconclusive cwd probe another complete launch/teardown window.
export const HAMMER_SCRATCH_PROBE_GRACE_MS = 2 * Math.max(
  AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS, AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS);
export const HAMMER_SCRATCH_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const HAMMER_SCRATCH_SWEEP_RETRY_MS = 60 * 1000;
const PROCESS_CENSUS_TIMEOUT_MS = 15_000;
const PROCESS_CENSUS_FRESHNESS_MS = 30_000;
const LEDGER_READ_TIMEOUT_MS = 10_000;
class ScratchScanBudgetExhausted extends Error {}
class ScratchLedgerReadTimedOut extends Error {}
const execFileAsync = promisify(execFile);
// The disk checkpoint retains partial indexing across watcher restarts. Neither
// cache authorizes deletion without a complete, current metadata census.
const recordIndexes = new Map();

function compareCandidates(a, b) {
  return a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function readCandidateCursor(path) {
  try {
    if (!lstatSync(path).isFile()) return null;
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    const after = saved.after;
    if (saved.schemaVersion === 1 && typeof after?.name === 'string'
      && after.name.startsWith('hammer-scratch-') && !/[/\\]/.test(after.name)
      && Number.isFinite(after.mtimeMs)) return after;
  } catch { /* A cursor only schedules work; cold starts still prove safety. */ }
  return null;
}

function readRecordIndex(path, directory) {
  try {
    if (!lstatSync(path).isFile()) return new Map();
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (saved.schemaVersion !== 1 || !Array.isArray(saved.entries)) return new Map();
    const index = new Map();
    for (const entry of saved.entries) {
      if (!Array.isArray(entry) || entry.length !== 2) return new Map();
      const [name, cached] = entry;
      if (typeof name !== 'string' || !name.endsWith('.json') || /[/\\]/.test(name)
        || typeof cached?.version !== 'string' || !cached.record
        || typeof cached.record !== 'object' || Array.isArray(cached.record)) return new Map();
      index.set(name, { ...cached, path: join(directory, name) });
    }
    return index;
  } catch {
    // A missing, truncated or unreadable checkpoint is a cold start, never
    // evidence that an owner is absent. Source records must still be indexed.
    return new Map();
  }
}

export async function readHammerScratchProcessSnapshot({ timeout, execFileImpl = execFileAsync,
  platform = process.platform, logger = console }) {
  // TMPDIR is inherited by the hammer and its children. Include environments so
  // even an idle orphan with no open scratch file is protected. Never log this
  // output: it may contain credentials. An unavailable/truncated census holds.
  const startedAt = Date.now();
  const results = await Promise.allSettled([
    // Darwin's -e lists processes; -E explicitly includes their environments.
    execFileImpl('ps', [platform === 'darwin' ? '-Eww' : 'eww', '-axo', 'pid=,command='], {
      encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024,
    }),
    // Only cwd is needed to identify descendants that cleared TMPDIR. Selecting
    // cwd avoids enumerating thousands of test files (and never walks the tree).
    execFileImpl('lsof', ['-nP', '-a', '-u', String(process.getuid()), '-d', 'cwd', '-F', 'n'], {
      encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024,
    }),
  ]);
  const unreadable = results.some(result => result.status !== 'fulfilled' || !result.value?.stdout?.trim());
  const bytes = result => result.status === 'fulfilled' ? Buffer.byteLength(result.value?.stdout || '') : 0;
  logger.info?.(JSON.stringify({ event: 'ama_closer.scratch_process_census',
    durationMs: Date.now() - startedAt, psBytes: bytes(results[0]), lsofBytes: bytes(results[1]),
    outcome: unreadable ? 'unreadable' : 'ok' }));
  const cwdError = results[1].status === 'rejected' ? results[1].reason : null;
  const cwdTimedOut = cwdError?.code === 'ETIMEDOUT' || cwdError?.killed === true;
  if (unreadable && !(cwdTimedOut && results[0].status === 'fulfilled' && results[0].value?.stdout?.trim())) {
    throw new Error('unreadable process census');
  }
  // An unrelated log shipper can hold audit files named after every launch.
  // Keep file names separate: only process arguments/environments prove ID liveness.
  return { ps: results[0].value.stdout,
    lsof: results[1].status === 'fulfilled' ? results[1].value.stdout : String(cwdError?.stdout || ''),
    ...(cwdTimedOut ? { cwdTimedOut: true } : {}) };
}

function readRecords(rootDir, deadline, maxRecordReads, logger) {
  const directory = amaCloserDispatchDir(rootDir);
  const checkpoint = join(rootDir, 'data', 'follow-up-jobs', 'hammer-scratch-record-index.json');
  let index = recordIndexes.get(directory);
  if (!index) { index = readRecordIndex(checkpoint, directory); recordIndexes.set(directory, index); }
  const records = [];
  const seen = new Set();
  let reads = 0;
  let dirty = false;
  const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  let dir;
  try { dir = opendirSync(amaCloserDispatchDir(rootDir)); }
  catch (error) { if (error.code === 'ENOENT') return records; throw error; }
  try {
    let entry;
    while ((entry = dir.readSync())) {
      if (Date.now() >= deadline) throw new ScratchScanBudgetExhausted('scratch record scan budget exhausted');
      if (!entry.name.endsWith('.json')) continue;
      // A corrupt/unreadable record could own any directory. Never classify it
      // as missing and reclaim that run's scratch on a diagnostic read failure.
      if (!entry.isFile()) throw new Error('non-file scratch dispatch record');
      const path = join(directory, entry.name);
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isFile()) throw new Error('non-file scratch dispatch record');
      const version = fingerprint(stat);
      let cached = index.get(entry.name);
      if (!cached || cached.version !== version) {
        if (reads >= maxRecordReads) throw new Error('scratch record indexing deferred');
        reads += 1;
        const record = JSON.parse(readFileSync(path, 'utf8'));
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
          throw new Error('invalid scratch dispatch record');
        }
        const after = lstatSync(path, { bigint: true });
        if (!after.isFile() || fingerprint(after) !== version) {
          throw new Error('scratch dispatch record changed during indexing');
        }
        cached = { version, path, record };
        index.set(entry.name, cached);
        dirty = true;
      }
      seen.add(entry.name);
      records.push(cached);
    }
    for (const name of index.keys()) {
      if (!seen.has(name)) { index.delete(name); dirty = true; }
    }
  } finally {
    dir.closeSync();
    // Checkpoint even a deferred census. Atomic replacement leaves either the
    // previous valid checkpoint or this pass's progress after a restart.
    if (dirty) {
      try {
        writeFileAtomic(checkpoint, JSON.stringify({ schemaVersion: 1,
          entries: [...index].map(([name, { version, record }]) => [name, { version, record }]),
        }), { mode: 0o600 });
      } catch (error) {
        logger.warn?.(`hammer scratch index checkpoint deferred: ${error.message}`);
      }
    }
  }
  return records;
}

function treeSize(path, deadline, allowPartial = false) {
  let bytes = 0;
  let newestMtimeMs = 0;
  const pending = [path];
  while (pending.length) {
    if (Date.now() >= deadline) {
      if (allowPartial) return { bytes, newestMtimeMs, partial: true };
      throw new ScratchScanBudgetExhausted('scratch size scan budget exhausted');
    }
    const current = pending.pop();
    const stat = lstatSync(current);
    bytes += Number.isFinite(stat.blocks) ? stat.blocks * 512 : stat.size;
    newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
    if (!stat.isDirectory()) continue; // lstat never follows symlinks.
    const dir = opendirSync(current);
    try {
      let entry;
      while ((entry = dir.readSync())) {
        if (Date.now() >= deadline) {
          if (allowPartial) return { bytes, newestMtimeMs, partial: true };
          throw new ScratchScanBudgetExhausted('scratch size scan budget exhausted');
        }
        pending.push(join(current, entry.name));
      }
    } finally { dir.closeSync(); }
  }
  return { bytes, newestMtimeMs };
}

function pidMayBeAlive(pid, processKillImpl) {
  if (pid == null) return false;
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return true;
  try { processKillImpl(Number(pid), 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function hasLiveWorker(record, options, readLedger) {
  if (pidMayBeAlive(record.pid ?? record.worker_process_pid, options.processKillImpl)) return true;
  if (!record.launchRequestId) return false;
  const probe = await readLedger(record, options.readWorkerStatusImpl);
  if (!probe?.ok) return probe?.reason !== 'missing-worker-run-row';
  if (!probe.row) return true;
  if (pidMayBeAlive(probe.row.pid ?? probe.row.worker_process_pid, options.processKillImpl)) return true;
  return !isTerminalHammerScratchRecord({ lastObservedStatus: probe.row.status });
}

function ledgerReadArgs(record, options, deadline, signal) {
  return {
    launchRequestId: record.launchRequestId, rootDir: options.rootDir, includeRetryChain: true,
    hqRoot: record.hqRoot || options.hqRoot, env: options.env,
    ledgerTarget: options.ledgerTarget, ledgerDbPath: options.ledgerDbPath,
    timeoutMs: Math.max(1, deadline - Date.now()),
    signal,
    spawnSyncImpl: options.spawnSyncImpl ? (command, args, spawnOptions) => options.spawnSyncImpl(command, args, {
      ...spawnOptions, timeout: Math.max(1, Math.min(spawnOptions.timeout || loadAwareTimeoutMs(10_000), deadline - Date.now())),
    }) : undefined,
    // Retain the existing explicit fixture seam, while production uses async
    // psql and keeps the ledger deadline on each child.
    spawnAsyncImpl: options.spawnAsyncImpl || (options.spawnSyncImpl
      ? async (command, args, spawnOptions) => options.spawnSyncImpl(command, args, {
        ...spawnOptions, timeout: Math.max(1, Math.min(spawnOptions.timeout || loadAwareTimeoutMs(10_000), deadline - Date.now())),
      }) : undefined),
  };
}

async function readScratchLedger(record, options, readImpl) {
  const ledgerTimeoutMs = options.ledgerTimeoutMs ?? loadAwareTimeoutMs(LEDGER_READ_TIMEOUT_MS);
  const ledgerDeadline = Date.now() + ledgerTimeoutMs;
  const controller = new AbortController();
  let timer;
  const timeoutError = () => new ScratchLedgerReadTimedOut('scratch ledger read timed out');
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => readImpl(ledgerReadArgs(record, options, ledgerDeadline, controller.signal))),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort();
        reject(timeoutError());
      }, ledgerTimeoutMs); }),
    ]);
    // Also discard late synchronous fixture/SQLite results. A late terminal
    // answer never authorizes deletion, even if it beat the timer callback.
    if (Date.now() >= ledgerDeadline) throw timeoutError();
    return result;
  } catch (error) {
    if (Date.now() >= ledgerDeadline || controller.signal.aborted) throw timeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function readScratchPullRequestState({ repo, prNumber, timeout, env }) {
  // Maintenance defers under API pressure instead of sleeping past its budget.
  const { stdout } = await withGitHubBudgetScope({}, () => meteredExecFile(execFileAsync, 'gh', ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'state'], {
    env, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
  }));
  return JSON.parse(stdout);
}

async function isTerminalOwner(record, options, getDeadline, readLedger) {
  // A retry intent can still carry its predecessor's LRQ and terminal status.
  if (record.state === 'dispatching' || Date.now() >= getDeadline()) return false;
  if (record.launchRequestId) {
    const probe = withLiveLaunchRetry(await readLedger(record, options.readLaunchRequestStatusImpl));
    if (!probe?.ok && probe?.reason !== 'missing-launch-request-row') {
      throw new Error('unreadable launch ledger');
    }
    if (probe?.ok) {
      if (probe.retryChainUnreadable) return false;
      // Explicit live or unknown ledger state outranks stale record/PR state.
      return !launchRequestParked(probe) && isTerminalLaunchRequestStatus(probe.row);
    }
  }
  if (isTerminalHammerScratchRecord(record)) return true;
  // Legacy records with no surviving launch row can still be settled by the
  // live PR. A database failure above must never become this fallback.
  if (!record.repo || !Number.isInteger(Number(record.prNumber)) || Number(record.prNumber) <= 0
    || Date.now() >= getDeadline()) return false;
  try {
    const pr = await options.readPullRequestStateImpl({ repo: record.repo, prNumber: record.prNumber,
      env: options.env, timeout: Math.max(1, Math.min(loadAwareTimeoutMs(5000), getDeadline() - Date.now())) });
    return ['MERGED', 'CLOSED'].includes(String(pr?.state || '').toUpperCase());
  } catch {
    // An unreadable PR protects this owner without deferring independent ones.
    return false;
  }
}

// This is disk maintenance only; it never changes leases or grants merge/retry
// authority. Zero scratch evidence is retained, including failed-run CI logs.
export async function sweepHammerScratchDirs(rootDir, options = {}) {
  const settings = {
    rootDir, env: process.env, processKillImpl: process.kill,
    readWorkerStatusImpl: readLatestWorkerRunStatusFromLedgerAsync,
    readLaunchRequestStatusImpl: readLaunchRequestStatusFromLedgerAsync,
    readPullRequestStateImpl: readScratchPullRequestState,
    readProcessSnapshotImpl: readHammerScratchProcessSnapshot,
    ...options,
  };
  const logger = settings.logger || console;
  const nowMs = settings.nowMs ?? Date.now();
  const maxAgeMs = settings.maxAgeMs ?? HAMMER_SCRATCH_MAX_AGE_MS;
  let deadline = Date.now() + (settings.scanBudgetMs ?? loadAwareTimeoutMs(10_000));
  const promptDir = join(rootDir, 'data', 'follow-up-jobs', 'ama-closer-prompts');
  const cursorPath = join(rootDir, 'data', 'follow-up-jobs', 'hammer-scratch-candidate-cursor.json');
  const removed = [];
  const kept = { 'live-owner': 0, 'non-terminal': 0, 'process-references-path': 0,
    'process-references-id': 0, 'too-young': 0, 'probe-timeout': 0 };
  let candidates = [];
  let candidateIndex = 0;
  let pauseReason;
  let processes;
  let openFiles;
  let censusStartedAt;
  let censusReads = 0;
  let cwdTimedOut = false;
  async function readLedger(record, readImpl) {
    const startedAt = Date.now();
    try { return await readScratchLedger(record, settings, readImpl); }
    finally { deadline += Date.now() - startedAt; }
  }
  async function refreshCensus() {
    censusStartedAt = Date.now();
    censusReads += 1;
    try {
      const snapshot = await settings.readProcessSnapshotImpl({ timeout: loadAwareTimeoutMs(PROCESS_CENSUS_TIMEOUT_MS), logger });
      if (typeof snapshot?.ps !== 'string' || !snapshot.ps.trim()
        || typeof snapshot?.lsof !== 'string'
        || (!snapshot.lsof.trim() && snapshot.cwdTimedOut !== true)) throw new Error('unreadable process census');
      processes = snapshot.ps;
      cwdTimedOut = snapshot.cwdTimedOut === true;
      openFiles = snapshot.lsof.split(/\r?\n/).filter(line => line.startsWith('n')).map(line => line.slice(1));
    } catch {
      // Executor errors can contain environments or command output. Never log them.
      throw new Error('unreadable process census');
    } finally {
      // Census subprocesses have their own clock, independent of scan/ledger work.
      deadline += Date.now() - censusStartedAt;
    }
  }
  let completed = false;
  try {
    let parentStat;
    try { parentStat = lstatSync(promptDir); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      completed = true;
      return removed;
    }
    if (!parentStat.isDirectory()) { completed = true; return removed; }
    for (const entry of readdirSync(promptDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('hammer-scratch-')) continue;
      try {
        const stat = lstatSync(join(promptDir, entry.name));
        if (stat.isDirectory()) candidates.push({ name: entry.name, mtimeMs: stat.mtimeMs });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    candidates.sort(compareCandidates);
    const cursor = readCandidateCursor(cursorPath);
    const start = cursor ? candidates.findIndex(entry => compareCandidates(entry, cursor) > 0) : 0;
    if (start > 0) candidates = [...candidates.slice(start), ...candidates.slice(0, start)];
    // The deadline bounds production scans; a count cap must not stretch a
    // small retained history over hours. Tests may force partial checkpoints.
    const records = readRecords(rootDir, deadline, settings.maxRecordReads ?? Infinity, logger);
    for (; candidateIndex < candidates.length; candidateIndex += 1) {
      if (Date.now() >= deadline) { pauseReason = 'scan-budget'; break; }
      if (removed.length >= (settings.maxRemovals ?? 64)) { pauseReason = 'removal-limit'; break; }
      const entry = candidates[candidateIndex];
      const scratchDir = join(promptDir, entry.name);
      const before = lstatSync(scratchDir);
      if (!before.isDirectory() || nowMs - before.mtimeMs < maxAgeMs) { kept['too-young'] += 1; continue; }
      const owners = records.filter(({ record }) => typeof record.scratchDir === 'string'
        && resolve(record.scratchDir) === resolve(scratchDir));
      let keepReason;
      try {
        for (const { path, record } of owners) {
          const current = JSON.parse(readFileSync(path, 'utf8'));
          if (JSON.stringify(current) !== JSON.stringify(record)
            || !await isTerminalOwner(current, settings, () => deadline, readLedger)) { keepReason = 'non-terminal'; break; }
          if (hammerScratchLeaseHeld(rootDir, current, { now: new Date(nowMs).toISOString(),
            processKillImpl: settings.processKillImpl })
            || await hasLiveWorker(current, settings, readLedger)) { keepReason = 'live-owner'; break; }
        }
      } catch (error) {
        if (!(error instanceof ScratchLedgerReadTimedOut)) throw error;
        // Retain inconclusive ownership, but finish this candidate so a slow
        // ledger cannot pin either this pass or the persisted cursor to it.
        continue;
      }
      if (keepReason) { kept[keepReason] += 1; continue; }
      if (Date.now() >= deadline) { pauseReason = 'scan-budget'; break; }
      // Terminal ownership, not recursive file mtimes, determines a finished
      // run's age. Orphans still require a complete idle-tree scan.
      const terminalAt = Math.max(before.mtimeMs, ...owners.map(({ record }) => {
        const at = Date.parse(record.lastObservedAt || record.updatedAt || record.dispatchedAt || '');
        return Number.isFinite(at) ? at : before.mtimeMs;
      }));
      if (owners.length && nowMs - terminalAt < maxAgeMs) { kept['too-young'] += 1; continue; }
      // Read once before deletions, then refresh at most once if it ages out.
      // Recheck every path and owner against the current census; an absent
      // dispatch record alone cannot prove a process stopped using TMPDIR.
      if (!processes || Date.now() - censusStartedAt >= PROCESS_CENSUS_FRESHNESS_MS) {
        if (censusReads >= 2) { pauseReason = 'census-expired'; break; }
        await refreshCensus();
      }
      if (Date.now() - censusStartedAt >= PROCESS_CENSUS_FRESHNESS_MS) {
        pauseReason = 'census-expired'; break;
      }
      // Only a timed-out cwd probe has a bounded escape. A readable ps census,
      // terminal retry chain, absent worker and unheld lease remain mandatory.
      // Never age away positive liveness or guess at an unowned directory.
      if (cwdTimedOut && (!owners.length
        || nowMs - terminalAt < maxAgeMs + Math.max(HAMMER_SCRATCH_PROBE_GRACE_MS,
          ...owners.map(({ record }) => 2 * amaCloserPendingLeaseExpiryMs(record.dispatchTimeoutMs))))) {
        kept['probe-timeout'] += 1; continue;
      }
      const paths = [...new Set([scratchDir, realpathSync(scratchDir)])];
      if (paths.some(path => processes.includes(path)
        || openFiles.some(file => file === path || file.startsWith(`${path}/`)))) {
        kept['process-references-path'] += 1; continue;
      }
      if (owners.some(({ record }) => [record.launchRequestId, record.workerId]
        .some(id => id && processes.includes(id)))) { kept['process-references-id'] += 1; continue; }
      if (owners.some(({ path, record }) => JSON.stringify(JSON.parse(readFileSync(path, 'utf8')))
        !== JSON.stringify(record))) { kept['non-terminal'] += 1; continue; }
      if (owners.some(({ record }) => hammerScratchLeaseHeld(rootDir, record,
        { now: new Date(nowMs).toISOString(), processKillImpl: settings.processKillImpl }))) {
        kept['live-owner'] += 1; continue;
      }
      // Byte accounting must not starve reclamation of a large terminal tree.
      // Report a lower bound when its small accounting budget is exhausted.
      const size = treeSize(scratchDir, owners.length
        ? Math.min(deadline, Date.now() + 25) : deadline, owners.length > 0);
      if (!owners.length && nowMs - size.newestMtimeMs < maxAgeMs) { kept['too-young'] += 1; continue; }
      const parentNow = lstatSync(promptDir);
      const current = lstatSync(scratchDir);
      if (Date.now() >= deadline) { pauseReason = 'scan-budget'; break; }
      if (Date.now() - censusStartedAt >= PROCESS_CENSUS_FRESHNESS_MS) {
        if (censusReads >= 2) { pauseReason = 'census-expired'; break; }
        await refreshCensus();
        // Repeat all candidate checks after yielding for the second census,
        // including live-worker and owner reads. The two-read cap bounds retries.
        candidateIndex -= 1;
        continue;
      }
      if (!parentNow.isDirectory() || !current.isDirectory()
        || parentNow.ino !== parentStat.ino || parentNow.dev !== parentStat.dev
        || current.ino !== before.ino || current.dev !== before.dev
        || current.mtimeMs !== before.mtimeMs) continue;
      if (owners.some(({ path, record }) => JSON.stringify(JSON.parse(readFileSync(path, 'utf8')))
        !== JSON.stringify(record))) { kept['non-terminal'] += 1; continue; }
      if (owners.some(({ record }) => hammerScratchLeaseHeld(rootDir, record,
        { now: new Date(nowMs).toISOString(), processKillImpl: settings.processKillImpl }))) {
        kept['live-owner'] += 1; continue;
      }
      if (cleanupHammerScratchDir({ scratchDir, promptDir }, logger)) {
        removed.push({ name: entry.name, bytesFreed: size.bytes,
          ...(size.partial ? { bytesFreedIsLowerBound: true } : {}) });
        logger.info?.(JSON.stringify({ event: 'ama_closer.scratch_swept',
          ...removed.at(-1), reason: owners.length ? 'terminal' : 'orphan',
          ...(cwdTimedOut ? { cwdProbe: 'timed-out-aged-terminal' } : {}) }));
      }
    }
    completed = candidateIndex === candidates.length;
  } catch (error) {
    if (error instanceof ScratchScanBudgetExhausted) {
      pauseReason = 'scan-budget';
    } else if (error.code !== 'ENOENT') logger.warn?.(`hammer scratch sweep deferred: ${error.message}`);
  } finally {
    if (candidateIndex > 0) {
      try {
        writeFileAtomic(cursorPath, JSON.stringify({ schemaVersion: 1,
          after: candidates[candidateIndex - 1] }), { mode: 0o600 });
      } catch (error) {
        logger.warn?.(`hammer scratch candidate checkpoint deferred: ${error.message}`);
      }
    }
    logger.info?.(JSON.stringify({ event: 'ama_closer.scratch_sweep_summary', kept,
      removed: removed.length, remainingCandidates: candidates.length - candidateIndex,
      deferredCandidates: candidateIndex - removed.length - Object.values(kept).reduce((sum, count) => sum + count, 0),
      completed }));
    if (pauseReason) logger.info?.(JSON.stringify({ event: 'ama_closer.scratch_sweep_paused',
      reason: pauseReason, removed: removed.length, remainingCandidates: candidates.length - candidateIndex }));
    if (completed) settings.onSweepComplete?.();
  }
  return removed;
}

export function createHammerScratchSweepTicker({ rootDir, now = Date.now,
  sweepImpl = sweepHammerScratchDirs, ...options }) {
  let lastStartedAt = null;
  let running = false;
  let completedOnce = false;
  return {
    async tick() {
      const nowMs = now();
      const interval = completedOnce ? HAMMER_SCRATCH_SWEEP_INTERVAL_MS : HAMMER_SCRATCH_SWEEP_RETRY_MS;
      if (running || (lastStartedAt !== null && nowMs - lastStartedAt < interval)) return [];
      running = true;
      lastStartedAt = nowMs;
      try {
        return await sweepImpl(rootDir, { ...options, nowMs, onSweepComplete: () => {
          completedOnce = true;
          options.onSweepComplete?.();
        } });
      }
      finally { running = false; }
    },
  };
}
