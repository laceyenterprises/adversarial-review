import { execFile } from 'node:child_process';
import { lstatSync, opendirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from '../atomic-write.mjs';
import { meteredExecFile } from '../metered-gh.mjs';
import { withGitHubBudgetScope } from '../rate-limit-throttle.mjs';
import { readLatestWorkerRunStatusFromLedgerAsync, readLaunchRequestStatusFromLedgerAsync } from '../session-ledger-read-adapter.mjs';
import { isTerminalLaunchRequestStatus } from './launch-request-status.mjs';
import {
  amaCloserDispatchDir, cleanupHammerScratchDir, isTerminalHammerScratchRecord,
} from './dispatch-closer.mjs';

export const HAMMER_SCRATCH_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const HAMMER_SCRATCH_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const HAMMER_SCRATCH_SWEEP_RETRY_MS = 60 * 1000;
const PROCESS_CENSUS_TIMEOUT_MS = 15_000;
const PROCESS_CENSUS_FRESHNESS_MS = 30_000;
class ScratchScanBudgetExhausted extends Error {}
const execFileAsync = promisify(execFile);
// The disk checkpoint retains partial indexing across watcher restarts. Neither
// cache authorizes deletion without a complete, current metadata census.
const recordIndexes = new Map();

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
    // Open files and cwd also protect descendants that cleared TMPDIR. Hammer
    // runs share the watcher's runtime uid; avoid inspecting other users' files.
    execFileImpl('lsof', ['-nP', '-a', '-u', String(process.getuid()), '-F', 'n'], {
      encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024,
    }),
  ]);
  const unreadable = results.some(result => result.status !== 'fulfilled' || !result.value?.stdout?.trim());
  const bytes = result => result.status === 'fulfilled' ? Buffer.byteLength(result.value?.stdout || '') : 0;
  logger.info?.(JSON.stringify({ event: 'ama_closer.scratch_process_census',
    durationMs: Date.now() - startedAt, psBytes: bytes(results[0]), lsofBytes: bytes(results[1]),
    outcome: unreadable ? 'unreadable' : 'ok' }));
  if (unreadable) {
    throw new Error('unreadable process census');
  }
  return results.map(result => result.value.stdout).join('\n');
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

function treeSize(path, deadline) {
  let bytes = 0;
  let newestMtimeMs = 0;
  const pending = [path];
  while (pending.length) {
    if (Date.now() >= deadline) throw new ScratchScanBudgetExhausted('scratch size scan budget exhausted');
    const current = pending.pop();
    const stat = lstatSync(current);
    bytes += Number.isFinite(stat.blocks) ? stat.blocks * 512 : stat.size;
    newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
    if (!stat.isDirectory()) continue; // lstat never follows symlinks.
    const dir = opendirSync(current);
    try {
      let entry;
      while ((entry = dir.readSync())) {
        if (Date.now() >= deadline) throw new ScratchScanBudgetExhausted('scratch size scan budget exhausted');
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

async function hasLiveWorker(record, options, deadline) {
  if (pidMayBeAlive(record.pid ?? record.worker_process_pid, options.processKillImpl)) return true;
  if (!record.launchRequestId) return false;
  const probe = await options.readWorkerStatusImpl(ledgerReadArgs(record, options, deadline));
  if (!probe?.ok) return probe?.reason !== 'missing-worker-run-row';
  if (!probe.row) return true;
  if (pidMayBeAlive(probe.row.pid ?? probe.row.worker_process_pid, options.processKillImpl)) return true;
  return !isTerminalHammerScratchRecord({ lastObservedStatus: probe.row.status });
}

function ledgerReadArgs(record, options, deadline) {
  return {
    launchRequestId: record.launchRequestId, rootDir: options.rootDir,
    hqRoot: record.hqRoot || options.hqRoot, env: options.env,
    ledgerTarget: options.ledgerTarget, ledgerDbPath: options.ledgerDbPath,
    timeoutMs: Math.max(1, deadline - Date.now()),
    spawnSyncImpl: options.spawnSyncImpl ? (command, args, spawnOptions) => options.spawnSyncImpl(command, args, {
      ...spawnOptions, timeout: Math.max(1, Math.min(spawnOptions.timeout || 10_000, deadline - Date.now())),
    }) : undefined,
    // Retain the existing explicit fixture seam, while production uses async
    // psql and keeps the sweep deadline on each child.
    spawnAsyncImpl: options.spawnAsyncImpl || (options.spawnSyncImpl
      ? async (command, args, spawnOptions) => options.spawnSyncImpl(command, args, {
        ...spawnOptions, timeout: Math.max(1, Math.min(spawnOptions.timeout || 10_000, deadline - Date.now())),
      }) : undefined),
  };
}

async function readScratchPullRequestState({ repo, prNumber, timeout, env }) {
  // Maintenance defers under API pressure instead of sleeping past its budget.
  const { stdout } = await withGitHubBudgetScope({}, () => meteredExecFile(execFileAsync, 'gh', ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'state'], {
    env, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
  }));
  return JSON.parse(stdout);
}

async function isTerminalOwner(record, options, deadline) {
  // A retry intent can still carry its predecessor's LRQ and terminal status.
  if (record.state === 'dispatching' || Date.now() >= deadline) return false;
  if (record.launchRequestId) {
    const probe = await options.readLaunchRequestStatusImpl(ledgerReadArgs(record, options, deadline));
    if (!probe?.ok && probe?.reason !== 'missing-launch-request-row') {
      throw new Error('unreadable launch ledger');
    }
    if (probe?.ok) {
      // Explicit live or unknown ledger state outranks stale record/PR state.
      return isTerminalLaunchRequestStatus(probe.row?.status);
    }
  }
  if (isTerminalHammerScratchRecord(record)) return true;
  // Legacy records with no surviving launch row can still be settled by the
  // live PR. A database failure above must never become this fallback.
  if (!record.repo || !Number.isInteger(Number(record.prNumber)) || Number(record.prNumber) <= 0
    || Date.now() >= deadline) return false;
  try {
    const pr = await options.readPullRequestStateImpl({ repo: record.repo, prNumber: record.prNumber,
      env: options.env, timeout: Math.max(1, Math.min(5000, deadline - Date.now())) });
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
  let deadline = Date.now() + (settings.scanBudgetMs ?? 10_000);
  const promptDir = join(rootDir, 'data', 'follow-up-jobs', 'ama-closer-prompts');
  const removed = [];
  let candidates = [];
  let candidateIndex = 0;
  let pauseReason;
  let processes;
  let censusStartedAt;
  let censusReads = 0;
  async function refreshCensus() {
    censusStartedAt = Date.now();
    censusReads += 1;
    try {
      processes = await settings.readProcessSnapshotImpl({ timeout: PROCESS_CENSUS_TIMEOUT_MS, logger });
      if (typeof processes !== 'string' || !processes.trim()) throw new Error('unreadable process census');
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
    candidates = readdirSync(promptDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('hammer-scratch-'));
    // The deadline bounds production scans; a count cap must not stretch a
    // small retained history over hours. Tests may force partial checkpoints.
    const records = readRecords(rootDir, deadline, settings.maxRecordReads ?? Infinity, logger);
    for (; candidateIndex < candidates.length; candidateIndex += 1) {
      if (Date.now() >= deadline) { pauseReason = 'scan-budget'; break; }
      if (removed.length >= (settings.maxRemovals ?? 64)) { pauseReason = 'removal-limit'; break; }
      const entry = candidates[candidateIndex];
      const scratchDir = join(promptDir, entry.name);
      const before = lstatSync(scratchDir);
      if (!before.isDirectory() || nowMs - before.mtimeMs < maxAgeMs) continue;
      const owners = records.filter(({ record }) => typeof record.scratchDir === 'string'
        && resolve(record.scratchDir) === resolve(scratchDir));
      const size = treeSize(scratchDir, deadline);
      if (nowMs - size.newestMtimeMs < maxAgeMs) continue;
      let live = false;
      for (const { path, record } of owners) {
        const current = JSON.parse(readFileSync(path, 'utf8'));
        if (JSON.stringify(current) !== JSON.stringify(record)
          || !await isTerminalOwner(current, settings, deadline)
          || await hasLiveWorker(current, settings, deadline)) { live = true; break; }
      }
      if (Date.now() >= deadline) { pauseReason = 'scan-budget'; break; }
      if (live) continue;
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
      if ([scratchDir, realpathSync(scratchDir)].some(path => processes.includes(path)) || owners.some(({ record }) =>
        [record.launchRequestId, record.workerId].some(id => id && processes.includes(id)))) continue;
      if (owners.some(({ path, record }) => JSON.stringify(JSON.parse(readFileSync(path, 'utf8')))
        !== JSON.stringify(record))) continue;
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
      if (cleanupHammerScratchDir({ scratchDir, promptDir }, logger)) {
        removed.push({ name: entry.name, bytesFreed: size.bytes });
        logger.info?.(JSON.stringify({ event: 'ama_closer.scratch_swept',
          name: entry.name, bytesFreed: size.bytes, reason: owners.length ? 'terminal' : 'orphan' }));
      }
    }
    completed = candidateIndex === candidates.length;
  } catch (error) {
    if (error instanceof ScratchScanBudgetExhausted) {
      pauseReason = 'scan-budget';
    } else if (error.code !== 'ENOENT') logger.warn?.(`hammer scratch sweep deferred: ${error.message}`);
  } finally {
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
