/**
 * AMG-01 — durable merge lease keyed by `(repo, base)`.
 *
 * The holder lease is a per-base file at
 * `<rootDir>/data/merge-leases/<repo-slug>__<base>.json`, with durable
 * waiters at the sibling `.waiters.json` path.
 *
 * Atomic holder acquire mirrors `closer-lease.mjs`: `writeFileAtomic(...,
 * { overwrite: false })` links the final path and returns EEXIST to every
 * losing contender.
 *
 * @module ama/merge-lease
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { writeFileAtomic } from '../atomic-write.mjs';

const execFileAsync = promisify(execFile);
const LEASE_DIR_SEGMENTS = ['data', 'merge-leases'];
const LEASE_FILE_MODE = 0o640;
const LEASE_SCHEMA_VERSION = 1;
const DEFAULT_DEADLINE_SECONDS = 900;
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_FETCH_ATTEMPTS = 2;
const MUTATION_LOCK_RETRY_ATTEMPTS = 50;
const MUTATION_LOCK_RETRY_DELAY_MS = 5;
const MUTATION_LOCK_STALE_MS = 5000;
const FULL_SHA_RE = /^[0-9a-f]{40}$/iu;

function sanitizeSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

function isoNow() {
  return new Date().toISOString();
}

function leaseId() {
  return `ml_${randomUUID()}`;
}

function parseDeadlineSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DEADLINE_SECONDS;
}

function normalizeGitRef(value) {
  return String(value || '').trim();
}

function normalizeBaseBranch(value) {
  const base = normalizeGitRef(value);
  if (!base || base.startsWith('-') || base.includes('..') || base.includes('\\')) return '';
  return base;
}

function normalizeFullSha(value) {
  const sha = normalizeGitRef(value);
  return FULL_SHA_RE.test(sha) ? sha.toLowerCase() : '';
}

function splitNameOnly(stdout) {
  return String(stdout || '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function gitErrorDetail(err) {
  const stderr = String(err?.stderr || '').trim();
  const message = String(err?.message || '').trim();
  const detail = stderr || message;
  return detail ? detail.split(/\r?\n/u)[0].slice(0, 500) : null;
}

function failClosed(reason, { currentBase = null, mainAdvancedBy = null, overlappingFiles = [], detail = null } = {}) {
  const decision = {
    needsRevalidation: true,
    reason,
    currentBase,
    mainAdvancedBy,
    overlappingFiles: uniqueSorted(overlappingFiles),
  };
  if (detail) decision.detail = detail;
  return decision;
}

function noRevalidation(reason, { currentBase, mainAdvancedBy = 0, overlappingFiles = [] } = {}) {
  return {
    needsRevalidation: false,
    reason,
    currentBase,
    mainAdvancedBy,
    overlappingFiles: uniqueSorted(overlappingFiles),
  };
}

async function git(execFileImpl, repoPath, args, { timeoutMs = DEFAULT_GIT_TIMEOUT_MS } = {}) {
  return execFileImpl('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
  });
}

async function gitStdout(execFileImpl, repoPath, args, options = {}) {
  const { stdout } = await git(execFileImpl, repoPath, args, options);
  return String(stdout || '').trim();
}

function defaultDeadlineSeconds() {
  return parseDeadlineSeconds(process.env.AMG_LEASE_DEADLINE_SECONDS);
}

function ageSecondsFrom(acquiredAt, nowIso) {
  const start = Date.parse(acquiredAt);
  const end = Date.parse(nowIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1000));
}

function pidIsLive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    if (err?.code === 'EPERM') return true;
    if (err?.code === 'ESRCH') return false;
    return false;
  }
}

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback;
    throw err;
  }
}

function writeJsonFile(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: LEASE_FILE_MODE,
    overwrite: true,
  });
}

function sleepSync(ms) {
  // AMA currently calls this library from short-lived closer processes. Keep
  // lock waiting bounded and synchronous so release/renew stay fence-linear.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function mutationLockPath(leasePath) {
  return `${leasePath}.mutation.lock`;
}

function mutationLockIsStale(lock, { nowIso, host, pidAliveFn }) {
  if (!lock || typeof lock !== 'object') return true;
  const currentHost = host || hostname();
  const sameHost = lock.holderHost === currentHost;
  const pid = Number(lock.holderPid);
  if (sameHost && Number.isInteger(pid) && pid > 0 && !pidAliveFn(pid)) {
    return true;
  }
  const acquiredMs = Date.parse(lock.acquiredAt);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(acquiredMs) || !Number.isFinite(nowMs)) {
    return true;
  }
  return nowMs - acquiredMs >= MUTATION_LOCK_STALE_MS;
}

function breakStaleMutationLock(lockPath, { nowIso = isoNow(), host, pidAliveFn = pidIsLive } = {}) {
  const existing = readJsonFile(lockPath, null);
  if (!mutationLockIsStale(existing, { nowIso, host, pidAliveFn })) {
    return { broken: false, lock: existing };
  }
  rmSync(lockPath, { force: true });
  return { broken: true, lock: existing };
}

function acquireMutationLock(lockPath, { nowIso = isoNow(), host, pidAliveFn = pidIsLive } = {}) {
  const lock = {
    schemaVersion: LEASE_SCHEMA_VERSION,
    lockId: `mll_${randomUUID()}`,
    holderPid: process.pid,
    holderHost: host || hostname(),
    acquiredAt: nowIso,
  };
  for (let attempt = 0; attempt < MUTATION_LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      writeFileAtomic(lockPath, `${JSON.stringify(lock, null, 2)}\n`, {
        mode: LEASE_FILE_MODE,
        overwrite: false,
      });
      return { acquired: true, lock };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const stale = breakStaleMutationLock(lockPath, { nowIso, host, pidAliveFn });
      if (stale.broken) continue;
      sleepSync(MUTATION_LOCK_RETRY_DELAY_MS);
    }
  }
  return { acquired: false, lock };
}

function withMutationLock(leasePath, fn, options = {}) {
  const lockPath = mutationLockPath(leasePath);
  const lock = acquireMutationLock(lockPath, options);
  if (!lock.acquired) return { acquired: false, lockPath };
  try {
    return { acquired: true, lockPath, value: fn() };
  } finally {
    rmSync(lockPath, { force: true });
  }
}

function withWaiterMutationLock({ rootDir, repo, base }, fn) {
  const leasePath = mergeLeaseFilePath(rootDir, { repo, base });
  const locked = withMutationLock(leasePath, fn);
  if (!locked.acquired) {
    throw new Error(`merge lease: mutation lock busy while updating waiters for ${repo}::${base}`);
  }
  return locked.value;
}

function isMutationLockBusyError(err) {
  return /\bmutation lock busy\b/.test(String(err?.message || ''));
}

function validateIdentity({ rootDir, repo, base } = {}) {
  if (!rootDir) throw new Error('merge lease: rootDir is required');
  if (!repo) throw new Error('merge lease: repo is required');
  if (!base) throw new Error('merge lease: base is required');
}

function normalizeHolderPr(value, fieldName = 'holderPr') {
  if (value == null || value === '' || typeof value === 'boolean') {
    throw new Error(`merge lease: ${fieldName} must be a positive integer`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`merge lease: ${fieldName} must be a positive integer`);
  }
  return n;
}

function normalizeHolderPid(value) {
  if (value == null || value === '' || typeof value === 'boolean') {
    throw new Error('merge lease: holderPid must be a positive integer');
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('merge lease: holderPid must be a positive integer');
  }
  return n;
}

function sortWaiters(waiters) {
  return [...waiters].sort((a, b) => {
    const arrived = String(a.arrivedAt || '').localeCompare(String(b.arrivedAt || ''));
    if (arrived !== 0) return arrived;
    return String(a.waiterId || '').localeCompare(String(b.waiterId || ''));
  });
}

function waiterFileDoc(waiters, now) {
  return {
    schemaVersion: LEASE_SCHEMA_VERSION,
    updatedAt: now,
    waiters: sortWaiters(waiters),
  };
}

function readWaiterDoc(filePath) {
  const doc = readJsonFile(filePath, null);
  if (!doc) return { schemaVersion: LEASE_SCHEMA_VERSION, updatedAt: null, waiters: [] };
  if (Array.isArray(doc)) {
    return { schemaVersion: LEASE_SCHEMA_VERSION, updatedAt: null, waiters: sortWaiters(doc) };
  }
  return {
    schemaVersion: Number(doc.schemaVersion) || LEASE_SCHEMA_VERSION,
    updatedAt: doc.updatedAt || null,
    waiters: sortWaiters(Array.isArray(doc.waiters) ? doc.waiters : []),
  };
}

function waiterExpired(waiter, nowIso) {
  const ageSeconds = ageSecondsFrom(waiter.arrivedAt, nowIso);
  if (ageSeconds === null) return false;
  const deadlineSeconds = parseDeadlineSeconds(waiter.deadlineSeconds);
  return ageSeconds >= deadlineSeconds;
}

function waiterProcessDead(waiter, host, pidAliveFn) {
  if (!waiter.holderHost || waiter.holderHost !== host) return false;
  const pid = Number(waiter.holderPid);
  return Number.isInteger(pid) && pid > 0 && !pidAliveFn(pid);
}

function pruneMergeLeaseWaiters({ rootDir, repo, base, now, host, pidAliveFn }) {
  return withWaiterMutationLock({ rootDir, repo, base }, () => {
    const waitersPath = mergeLeaseWaitersFilePath(rootDir, { repo, base });
    const doc = readWaiterDoc(waitersPath);
    if (doc.waiters.length === 0) return { pruned: [], waiters: [] };
    const currentHost = host || hostname();
    const updatedAt = now || isoNow();
    const waiters = [];
    const pruned = [];
    for (const waiter of doc.waiters) {
      const expired = waiterExpired(waiter, updatedAt);
      const dead = waiterProcessDead(waiter, currentHost, pidAliveFn);
      if (expired || dead) {
        pruned.push({ ...waiter, staleReason: dead ? 'dead-waiter-pid' : 'expired-waiter' });
      } else {
        waiters.push(waiter);
      }
    }
    if (pruned.length > 0) {
      writeJsonFile(waitersPath, waiterFileDoc(waiters, updatedAt));
    }
    return { pruned, waiters: sortWaiters(waiters) };
  });
}

function holderMatches(lease, fence = {}) {
  return Boolean(
    lease &&
    lease.leaseId === fence.leaseId &&
    Number(lease.holderPr) === Number(fence.holderPr) &&
    lease.holderHead === fence.holderHead &&
    lease.acquiredAt === fence.acquiredAt,
  );
}

/**
 * Derive the canonical key and filesystem slug for `(repo, base)`.
 */
export function deriveLeaseKey({ repo, base } = {}) {
  if (!repo) throw new Error('deriveLeaseKey: repo is required');
  if (!base) throw new Error('deriveLeaseKey: base is required');
  const repoSlug = sanitizeSegment(String(repo).replace(/\//g, '__'));
  const baseSlug = sanitizeSegment(base);
  return {
    repo,
    base,
    key: `${repo}::${base}`,
    repoSlug,
    baseSlug,
    fileSlug: `${repoSlug}__${baseSlug}`,
  };
}

export function mergeLeaseFilePath(rootDir, identity = {}) {
  validateIdentity({ rootDir, ...identity });
  const { fileSlug } = deriveLeaseKey(identity);
  return join(rootDir, ...LEASE_DIR_SEGMENTS, `${fileSlug}.json`);
}

export function mergeLeaseWaitersFilePath(rootDir, identity = {}) {
  validateIdentity({ rootDir, ...identity });
  const { fileSlug } = deriveLeaseKey(identity);
  return join(rootDir, ...LEASE_DIR_SEGMENTS, `${fileSlug}.waiters.json`);
}

export async function assessMergeLeaseNeedsRevalidation({
  repoPath,
  base,
  validationBase,
  currentBase,
  changedFilesFrom = 'HEAD',
  execFileImpl = execFileAsync,
  fetchAttempts = DEFAULT_FETCH_ATTEMPTS,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
} = {}) {
  const baseBranch = normalizeBaseBranch(base);
  const validationSha = normalizeFullSha(validationBase);
  const currentSha = normalizeFullSha(currentBase);
  const prRef = normalizeGitRef(changedFilesFrom) || 'HEAD';
  if (!repoPath) {
    return failClosed('repo-path-required', { currentBase: currentSha || null });
  }
  if (!baseBranch) {
    return failClosed('malformed-base', { currentBase: currentSha || null });
  }
  if (!validationSha) {
    return failClosed('malformed-validation-base', { currentBase: currentSha || null });
  }
  if (!currentSha) {
    return failClosed('malformed-current-base', { currentBase: null });
  }
  if (prRef.startsWith('-') || prRef.includes('\\')) {
    return failClosed('malformed-changed-files-from', { currentBase: currentSha });
  }

  try {
    await git(execFileImpl, repoPath, ['cat-file', '-e', `${validationSha}^{commit}`], { timeoutMs });
  } catch (err) {
    return failClosed('unresolvable-validation-base', { currentBase: currentSha, detail: gitErrorDetail(err) });
  }

  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  let resolvedRemote = null;
  let lastFetchError = null;
  let lastRevParseError = null;
  for (let attempt = 0; attempt <= Math.max(0, Number(fetchAttempts) || 0); attempt += 1) {
    try {
      resolvedRemote = normalizeFullSha(
        await gitStdout(execFileImpl, repoPath, ['rev-parse', '--verify', `${remoteRef}^{commit}`], { timeoutMs }),
      );
      lastRevParseError = null;
    } catch (err) {
      resolvedRemote = null;
      lastRevParseError = err;
    }
    if (resolvedRemote === currentSha) break;
    if (attempt >= Math.max(0, Number(fetchAttempts) || 0)) break;
    try {
      await git(execFileImpl, repoPath, ['fetch', '--no-tags', 'origin', baseBranch], { timeoutMs });
      lastFetchError = null;
    } catch (err) {
      lastFetchError = err;
      // Keep retrying until attempts are exhausted; unresolved freshness fails closed below.
    }
  }
  if (resolvedRemote !== currentSha) {
    return failClosed('unverified-current-base', {
      currentBase: currentSha,
      detail: gitErrorDetail(lastFetchError || lastRevParseError),
    });
  }

  if (validationSha === currentSha) {
    return noRevalidation('base-not-advanced', {
      currentBase: currentSha,
      mainAdvancedBy: 0,
      overlappingFiles: [],
    });
  }

  let mainAdvancedBy = null;
  try {
    const countText = await gitStdout(
      execFileImpl,
      repoPath,
      ['rev-list', '--count', `${validationSha}..${currentSha}`],
      { timeoutMs },
    );
    mainAdvancedBy = Number.parseInt(countText, 10);
    if (!Number.isFinite(mainAdvancedBy)) mainAdvancedBy = null;
  } catch (err) {
    return failClosed('unresolvable-base-drift', { currentBase: currentSha, detail: gitErrorDetail(err) });
  }

  let baseChangedFiles = [];
  let prChangedFiles = [];
  try {
    baseChangedFiles = splitNameOnly(
      await gitStdout(execFileImpl, repoPath, ['diff', '--name-only', `${validationSha}..${currentSha}`], { timeoutMs }),
    );
    const mergeBase = await gitStdout(execFileImpl, repoPath, ['merge-base', currentSha, prRef], { timeoutMs });
    prChangedFiles = splitNameOnly(
      await gitStdout(execFileImpl, repoPath, ['diff', '--name-only', `${mergeBase}..${prRef}`], { timeoutMs }),
    );
  } catch (err) {
    return failClosed('changed-files-unavailable', {
      currentBase: currentSha,
      mainAdvancedBy,
      detail: gitErrorDetail(err),
    });
  }

  const prFileSet = new Set(prChangedFiles);
  const overlappingFiles = uniqueSorted(baseChangedFiles.filter((file) => prFileSet.has(file)));
  if (overlappingFiles.length > 0) {
    return {
      needsRevalidation: true,
      reason: 'overlapping-files',
      currentBase: currentSha,
      mainAdvancedBy,
      overlappingFiles,
    };
  }
  return noRevalidation('no-overlapping-files', {
    currentBase: currentSha,
    mainAdvancedBy,
    overlappingFiles: [],
  });
}

export function readMergeLeaseWaiters(rootDir, identity = {}) {
  const waitersPath = mergeLeaseWaitersFilePath(rootDir, identity);
  return readWaiterDoc(waitersPath).waiters;
}

export function upsertMergeLeaseWaiter({
  rootDir,
  repo,
  base,
  pr,
  head,
  holderPid,
  holderHost,
  deadlineSeconds,
  waiterId = `mw_${randomUUID()}`,
  arrivedAt,
  updatedAt,
  attempt = 1,
} = {}) {
  validateIdentity({ rootDir, repo, base });
  return withWaiterMutationLock({ rootDir, repo, base }, () => {
    const waitersPath = mergeLeaseWaitersFilePath(rootDir, { repo, base });
    const now = updatedAt || arrivedAt || isoNow();
    const doc = readWaiterDoc(waitersPath);
    const existing = doc.waiters.find((w) => w.waiterId === waiterId);
    const nextWaiter = {
      repo,
      base,
      pr: normalizeHolderPr(pr, 'pr'),
      head: String(head || ''),
      waiterId,
      arrivedAt: existing?.arrivedAt || arrivedAt || now,
      updatedAt: now,
      attempt: Number.isFinite(Number(attempt)) ? Number(attempt) : 1,
      holderPid: normalizeHolderPid(holderPid),
      holderHost: holderHost || hostname(),
      deadlineSeconds: parseDeadlineSeconds(deadlineSeconds ?? process.env.AMG_LEASE_DEADLINE_SECONDS),
    };
    const waiters = doc.waiters.filter((w) => w.waiterId !== waiterId);
    waiters.push(nextWaiter);
    writeJsonFile(waitersPath, waiterFileDoc(waiters, now));
    return { waitersPath, waiter: nextWaiter, waiters: sortWaiters(waiters) };
  });
}

export function removeMergeLeaseWaiter({
  rootDir,
  repo,
  base,
  waiterId,
  updatedAt,
} = {}) {
  validateIdentity({ rootDir, repo, base });
  if (!waiterId) return { removed: false, waiters: readMergeLeaseWaiters(rootDir, { repo, base }) };
  return withWaiterMutationLock({ rootDir, repo, base }, () => {
    const waitersPath = mergeLeaseWaitersFilePath(rootDir, { repo, base });
    const doc = readWaiterDoc(waitersPath);
    const waiters = doc.waiters.filter((w) => w.waiterId !== waiterId);
    const removed = waiters.length !== doc.waiters.length;
    if (removed || doc.waiters.length > 0) {
      writeJsonFile(waitersPath, waiterFileDoc(waiters, updatedAt || isoNow()));
    }
    return { removed, waitersPath, waiters: sortWaiters(waiters) };
  });
}

export function inspectMergeLease({
  rootDir,
  repo,
  base,
  now,
  host,
  pidAliveFn = pidIsLive,
} = {}) {
  validateIdentity({ rootDir, repo, base });
  const leasePath = mergeLeaseFilePath(rootDir, { repo, base });
  const waitersPath = mergeLeaseWaitersFilePath(rootDir, { repo, base });
  const inspectedAt = now || isoNow();
  const currentHost = host || hostname();
  const lease = readJsonFile(leasePath, null);
  const waiters = readWaiterDoc(waitersPath).waiters;
  const ageSeconds = lease ? ageSecondsFrom(lease.acquiredAt, inspectedAt) : null;
  const deadlineSeconds = lease?.deadlineSeconds ?? defaultDeadlineSeconds();
  const pastDeadline = lease && ageSeconds !== null ? ageSeconds >= deadlineSeconds : false;
  const sameHost = lease ? lease.holderHost === currentHost : false;
  const holderPidLive = lease && sameHost ? Boolean(pidAliveFn(lease.holderPid)) : null;
  return {
    key: deriveLeaseKey({ repo, base }).key,
    leasePath,
    waitersPath,
    holder: lease,
    lease,
    exists: Boolean(lease),
    ageSeconds,
    deadlineSeconds,
    pastDeadline,
    holderPidLive,
    waiters,
    inspectedAt,
  };
}

export function acquireMergeLease({
  rootDir,
  repo,
  base,
  holderPr,
  holderHead,
  holderPid,
  holderHost,
  holderProcessGroup,
  deadlineSeconds,
  leaseId: suppliedLeaseId,
  now,
  waiterId,
  registerWaiter = false,
  attempt = 1,
  pidAliveFn = pidIsLive,
  _afterHolderWrite,
} = {}) {
  validateIdentity({ rootDir, repo, base });
  const leasePath = mergeLeaseFilePath(rootDir, { repo, base });
  const acquiredAt = now || isoNow();
  let waiter = null;
  let reclaim = null;

  if (registerWaiter) {
    const registered = upsertMergeLeaseWaiter({
      rootDir,
      repo,
      base,
      pr: holderPr,
      head: holderHead,
      waiterId,
      arrivedAt: acquiredAt,
      updatedAt: acquiredAt,
      attempt,
      holderPid,
      holderHost,
      deadlineSeconds,
    });
    waiter = registered.waiter;
  }

  const existingLease = readJsonFile(leasePath, null);
  if (existingLease) {
    reclaim = reclaimIfStale({
      rootDir,
      repo,
      base,
      now: acquiredAt,
      host: holderHost,
      pidAliveFn,
    });
    if (!reclaim.reclaimed) {
      return { acquired: false, leasePath, lease: existingLease, existingLease, waiter, reclaim };
    }
  }

  const waiterState = pruneMergeLeaseWaiters({
    rootDir,
    repo,
    base,
    now: acquiredAt,
    host: holderHost,
    pidAliveFn,
  });
  const waiters = waiterState.waiters;
  if (waiters.length > 0) {
    if (!waiter?.waiterId) {
      return { acquired: false, leasePath, lease: null, existingLease: null, waiters, prunedWaiters: waiterState.pruned };
    }
    if (waiters[0]?.waiterId !== waiter.waiterId) {
      return { acquired: false, leasePath, lease: null, existingLease: null, waiter, waiters, prunedWaiters: waiterState.pruned };
    }
  }

  const lease = {
    schemaVersion: LEASE_SCHEMA_VERSION,
    repo,
    base,
    leaseId: suppliedLeaseId || leaseId(),
    holderPr: normalizeHolderPr(holderPr),
    holderHead: String(holderHead || ''),
    holderPid: normalizeHolderPid(holderPid),
    holderHost: holderHost || hostname(),
    ...(holderProcessGroup != null ? { holderProcessGroup: Number(holderProcessGroup) } : {}),
    acquiredAt,
    deadlineSeconds: parseDeadlineSeconds(deadlineSeconds ?? process.env.AMG_LEASE_DEADLINE_SECONDS),
    updatedAt: acquiredAt,
  };

  try {
    writeFileAtomic(leasePath, `${JSON.stringify(lease, null, 2)}\n`, {
      mode: LEASE_FILE_MODE,
      overwrite: false,
    });
  } catch (err) {
    if (err?.code === 'EEXIST') {
      const beat = readJsonFile(leasePath, null);
      return { acquired: false, leasePath, lease: beat, existingLease: beat, waiter };
    }
    throw err;
  }

  if (typeof _afterHolderWrite === 'function') _afterHolderWrite({ leasePath, lease });
  if (waiter?.waiterId) {
    try {
      removeMergeLeaseWaiter({ rootDir, repo, base, waiterId: waiter.waiterId, updatedAt: acquiredAt });
    } catch (err) {
      if (!isMutationLockBusyError(err)) throw err;
    }
  }
  return { acquired: true, leasePath, lease, waiter, prunedWaiters: waiterState.pruned, reclaim };
}

export function releaseMergeLease({
  rootDir,
  repo,
  base,
  leaseId: id,
  holderPr,
  holderHead,
  acquiredAt,
  _afterFenceRead,
} = {}) {
  validateIdentity({ rootDir, repo, base });
  const leasePath = mergeLeaseFilePath(rootDir, { repo, base });
  const lease = readJsonFile(leasePath, null);
  const matched = holderMatches(lease, { leaseId: id, holderPr, holderHead, acquiredAt });
  if (!matched) {
    return { released: false, leasePath, existingLease: lease };
  }
  // Test-only race injection hook used to prove the second fence read below.
  if (typeof _afterFenceRead === 'function') _afterFenceRead({ leasePath, lease });
  const locked = withMutationLock(leasePath, () => {
    const currentLease = readJsonFile(leasePath, null);
    const currentMatched = holderMatches(currentLease, {
      leaseId: id,
      holderPr,
      holderHead,
      acquiredAt,
    });
    if (!currentMatched) {
      return { released: false, leasePath, existingLease: currentLease };
    }
    rmSync(leasePath, { force: true });
    return { released: true, leasePath, lease: currentLease };
  });
  if (!locked.acquired) {
    return { released: false, leasePath, existingLease: readJsonFile(leasePath, null), reason: 'mutation-lock-busy' };
  }
  return locked.value;
}

export function renewMergeLease({
  rootDir,
  repo,
  base,
  leaseId: id,
  holderPr,
  holderHead,
  acquiredAt,
  now,
  _afterFenceRead,
} = {}) {
  validateIdentity({ rootDir, repo, base });
  const leasePath = mergeLeaseFilePath(rootDir, { repo, base });
  const lease = readJsonFile(leasePath, null);
  const matched = holderMatches(lease, { leaseId: id, holderPr, holderHead, acquiredAt });
  if (!matched) {
    return { renewed: false, leasePath, existingLease: lease };
  }
  // Test-only race injection hook used to prove the second fence read below.
  if (typeof _afterFenceRead === 'function') _afterFenceRead({ leasePath, lease });
  const locked = withMutationLock(leasePath, () => {
    const currentLease = readJsonFile(leasePath, null);
    const currentMatched = holderMatches(currentLease, {
      leaseId: id,
      holderPr,
      holderHead,
      acquiredAt,
    });
    if (!currentMatched) {
      return { renewed: false, leasePath, existingLease: currentLease };
    }
    const renewedAt = now || isoNow();
    const renewed = {
      ...currentLease,
      acquiredAt: renewedAt,
      updatedAt: renewedAt,
      previousAcquiredAt: currentLease.acquiredAt,
    };
    writeJsonFile(leasePath, renewed);
    return { renewed: true, leasePath, lease: renewed, previousLease: currentLease };
  });
  if (!locked.acquired) {
    return { renewed: false, leasePath, existingLease: readJsonFile(leasePath, null), reason: 'mutation-lock-busy' };
  }
  return locked.value;
}

export function reclaimIfStale({
  rootDir,
  repo,
  base,
  now,
  host,
  pidAliveFn = pidIsLive,
} = {}) {
  const inspection = inspectMergeLease({ rootDir, repo, base, now, host, pidAliveFn });
  const lease = inspection.lease;
  if (!lease) {
    return { reclaimed: false, reason: 'absent', inspection };
  }

  const sameHost = lease.holderHost === (host || hostname());
  const deadSameHostPid = sameHost && !pidAliveFn(lease.holderPid);
  const staleByDeadline = inspection.pastDeadline;
  const reclaimByDeadline = staleByDeadline && !sameHost;
  if (!deadSameHostPid && !reclaimByDeadline) {
    return { reclaimed: false, reason: 'live-within-deadline', inspection };
  }

  const released = releaseMergeLease({
    rootDir,
    repo,
    base,
    leaseId: lease.leaseId,
    holderPr: lease.holderPr,
    holderHead: lease.holderHead,
    acquiredAt: lease.acquiredAt,
  });
  if (!released.released) {
    return { reclaimed: false, reason: released.reason || 'identity-changed', inspection, release: released };
  }
  return {
    reclaimed: true,
    reason: deadSameHostPid ? 'dead-holder-pid' : 'past-deadline',
    inspection,
    release: released,
  };
}

export const MERGE_LEASE_SCHEMA_VERSION = LEASE_SCHEMA_VERSION;
export const MERGE_LEASE_DEFAULT_DEADLINE_SECONDS = DEFAULT_DEADLINE_SECONDS;
