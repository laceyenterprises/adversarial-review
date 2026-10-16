import { execFile, spawnSync } from 'node:child_process';
import { lstatSync, opendirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readLatestWorkerRunStatusFromLedger } from '../session-ledger-read-adapter.mjs';
import {
  amaCloserDispatchDir, cleanupHammerScratchDir, isTerminalHammerScratchRecord,
} from './dispatch-closer.mjs';

export const HAMMER_SCRATCH_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const HAMMER_SCRATCH_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const execFileAsync = promisify(execFile);

export async function readHammerScratchProcessSnapshot({ timeout, execFileImpl = execFileAsync,
  platform = process.platform }) {
  // TMPDIR is inherited by the hammer and its children. Include environments so
  // even an idle orphan with no open scratch file is protected. Never log this
  // output: it may contain credentials. An unavailable/truncated census holds.
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
  if (results.some(result => result.status !== 'fulfilled' || !result.value?.stdout?.trim())) {
    throw new Error('unreadable process census');
  }
  return results.map(result => result.value.stdout).join('\n');
}

function readRecords(rootDir, deadline) {
  const records = [];
  let dir;
  try { dir = opendirSync(amaCloserDispatchDir(rootDir)); }
  catch (error) { if (error.code === 'ENOENT') return records; throw error; }
  try {
    let entry;
    while ((entry = dir.readSync())) {
      if (Date.now() >= deadline) throw new Error('scratch record scan budget exhausted');
      if (!entry.name.endsWith('.json')) continue;
      // A corrupt/unreadable record could own any directory. Never classify it
      // as missing and reclaim that run's scratch on a diagnostic read failure.
      if (!entry.isFile()) throw new Error('non-file scratch dispatch record');
      const path = join(amaCloserDispatchDir(rootDir), entry.name);
      const record = JSON.parse(readFileSync(path, 'utf8'));
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('invalid scratch dispatch record');
      }
      records.push({ path, record });
    }
  } finally { dir.closeSync(); }
  return records;
}

function treeSize(path, deadline) {
  let bytes = 0;
  let newestMtimeMs = 0;
  const pending = [path];
  while (pending.length) {
    if (Date.now() >= deadline) throw new Error('scratch size scan budget exhausted');
    const current = pending.pop();
    const stat = lstatSync(current);
    bytes += Number.isFinite(stat.blocks) ? stat.blocks * 512 : stat.size;
    newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
    if (!stat.isDirectory()) continue; // lstat never follows symlinks.
    const dir = opendirSync(current);
    try {
      let entry;
      while ((entry = dir.readSync())) {
        if (Date.now() >= deadline) throw new Error('scratch size scan budget exhausted');
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
  const probe = await options.readWorkerStatusImpl({
    launchRequestId: record.launchRequestId, rootDir: options.rootDir,
    hqRoot: record.hqRoot || options.hqRoot, env: options.env,
    ledgerTarget: options.ledgerTarget, ledgerDbPath: options.ledgerDbPath,
    spawnSyncImpl: (command, args, spawnOptions) => spawnSync(command, args, {
      ...spawnOptions, timeout: Math.max(1, Math.min(spawnOptions.timeout || 10_000, deadline - Date.now())),
    }),
  });
  if (!probe?.ok) return probe?.reason !== 'missing-worker-run-row';
  if (!probe.row) return true;
  if (pidMayBeAlive(probe.row.pid ?? probe.row.worker_process_pid, options.processKillImpl)) return true;
  return !isTerminalHammerScratchRecord({ lastObservedStatus: probe.row.status });
}

// This is disk maintenance only; it never changes leases or grants merge/retry
// authority. Zero scratch evidence is retained, including failed-run CI logs.
export async function sweepHammerScratchDirs(rootDir, options = {}) {
  const settings = {
    rootDir, env: process.env, processKillImpl: process.kill,
    readWorkerStatusImpl: readLatestWorkerRunStatusFromLedger,
    readProcessSnapshotImpl: readHammerScratchProcessSnapshot,
    ...options,
  };
  const logger = settings.logger || console;
  const nowMs = settings.nowMs ?? Date.now();
  const maxAgeMs = settings.maxAgeMs ?? HAMMER_SCRATCH_MAX_AGE_MS;
  const deadline = Date.now() + (settings.scanBudgetMs ?? 10_000);
  const promptDir = join(rootDir, 'data', 'follow-up-jobs', 'ama-closer-prompts');
  const removed = [];
  let dir;
  try {
    const parentStat = lstatSync(promptDir);
    if (!parentStat.isDirectory()) return removed;
    const records = readRecords(rootDir, deadline);
    dir = opendirSync(promptDir);
    let entry;
    while (removed.length < (settings.maxRemovals ?? 64)
      && Date.now() < deadline && (entry = dir.readSync())) {
      if (!entry.isDirectory() || !entry.name.startsWith('hammer-scratch-')) continue;
      const scratchDir = join(promptDir, entry.name);
      const before = lstatSync(scratchDir);
      if (!before.isDirectory() || nowMs - before.mtimeMs < maxAgeMs) continue;
      const owners = records.filter(({ record }) => typeof record.scratchDir === 'string'
        && resolve(record.scratchDir) === resolve(scratchDir));
      if (owners.some(({ record }) => !isTerminalHammerScratchRecord(record))) continue;
      const size = treeSize(scratchDir, deadline);
      if (nowMs - size.newestMtimeMs < maxAgeMs) continue;
      let live = false;
      for (const { path, record } of owners) {
        const current = JSON.parse(readFileSync(path, 'utf8'));
        if (JSON.stringify(current) !== JSON.stringify(record)
          || await hasLiveWorker(current, settings, deadline)) { live = true; break; }
      }
      if (live || Date.now() >= deadline) continue;
      // Refresh immediately before deletion, after traversal and ledger reads.
      // A missing record alone cannot prove that a process stopped using TMPDIR.
      const processes = await settings.readProcessSnapshotImpl({ timeout: Math.max(1, deadline - Date.now()) });
      if (typeof processes !== 'string' || !processes.trim()) throw new Error('unreadable process census');
      if ([scratchDir, realpathSync(scratchDir)].some(path => processes.includes(path)) || owners.some(({ record }) =>
        [record.launchRequestId, record.workerId].some(id => id && processes.includes(id)))) continue;
      if (owners.some(({ path, record }) => JSON.stringify(JSON.parse(readFileSync(path, 'utf8')))
        !== JSON.stringify(record))) continue;
      const parentNow = lstatSync(promptDir);
      const current = lstatSync(scratchDir);
      if (Date.now() >= deadline || !parentNow.isDirectory() || !current.isDirectory()
        || parentNow.ino !== parentStat.ino || parentNow.dev !== parentStat.dev
        || current.ino !== before.ino || current.dev !== before.dev
        || current.mtimeMs !== before.mtimeMs) continue;
      if (cleanupHammerScratchDir({ scratchDir, promptDir }, logger)) {
        removed.push({ name: entry.name, bytesFreed: size.bytes });
        logger.info?.(JSON.stringify({ event: 'ama_closer.scratch_swept',
          name: entry.name, bytesFreed: size.bytes, reason: owners.length ? 'terminal' : 'orphan' }));
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') logger.warn?.(`hammer scratch sweep deferred: ${error.message}`);
  } finally { dir?.closeSync(); }
  return removed;
}

export function createHammerScratchSweepTicker({ rootDir, now = Date.now,
  sweepImpl = sweepHammerScratchDirs, ...options }) {
  let lastStartedAt = null;
  let running = false;
  return {
    async tick() {
      const nowMs = now();
      if (running || (lastStartedAt !== null && nowMs - lastStartedAt < HAMMER_SCRATCH_SWEEP_INTERVAL_MS)) return [];
      running = true;
      lastStartedAt = nowMs;
      try { return await sweepImpl(rootDir, { ...options, nowMs }); }
      finally { running = false; }
    },
  };
}
