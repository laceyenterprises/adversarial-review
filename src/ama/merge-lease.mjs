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

import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { writeFileAtomic } from '../atomic-write.mjs';

const LEASE_DIR_SEGMENTS = ['data', 'merge-leases'];
const LEASE_FILE_MODE = 0o640;
const LEASE_SCHEMA_VERSION = 1;
const DEFAULT_DEADLINE_SECONDS = 900;

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
  } catch {
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

function validateIdentity({ rootDir, repo, base } = {}) {
  if (!rootDir) throw new Error('merge lease: rootDir is required');
  if (!repo) throw new Error('merge lease: repo is required');
  if (!base) throw new Error('merge lease: base is required');
}

function normalizeHolderPr(value, fieldName = 'holderPr') {
  if (!Number.isFinite(Number(value))) {
    throw new Error(`merge lease: ${fieldName} must be numeric`);
  }
  return Number(value);
}

function normalizeHolderPid(value) {
  if (!Number.isFinite(Number(value))) {
    throw new Error('merge lease: holderPid must be numeric');
  }
  return Number(value);
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
  waiterId = `mw_${randomUUID()}`,
  arrivedAt,
  updatedAt,
  attempt = 1,
} = {}) {
  validateIdentity({ rootDir, repo, base });
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
  };
  const waiters = doc.waiters.filter((w) => w.waiterId !== waiterId);
  waiters.push(nextWaiter);
  writeJsonFile(waitersPath, waiterFileDoc(waiters, now));
  return { waitersPath, waiter: nextWaiter, waiters: sortWaiters(waiters) };
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
  const waitersPath = mergeLeaseWaitersFilePath(rootDir, { repo, base });
  const doc = readWaiterDoc(waitersPath);
  const waiters = doc.waiters.filter((w) => w.waiterId !== waiterId);
  const removed = waiters.length !== doc.waiters.length;
  if (removed || doc.waiters.length > 0) {
    writeJsonFile(waitersPath, waiterFileDoc(waiters, updatedAt || isoNow()));
  }
  return { removed, waitersPath, waiters: sortWaiters(waiters) };
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
} = {}) {
  validateIdentity({ rootDir, repo, base });
  const leasePath = mergeLeaseFilePath(rootDir, { repo, base });
  const acquiredAt = now || isoNow();
  let waiter = null;

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
    });
    waiter = registered.waiter;
  }

  const existingLease = readJsonFile(leasePath, null);
  if (existingLease) {
    return { acquired: false, leasePath, lease: existingLease, existingLease, waiter };
  }

  const waiters = readMergeLeaseWaiters(rootDir, { repo, base });
  if (waiters.length > 0) {
    if (!waiter?.waiterId) {
      return { acquired: false, leasePath, lease: null, existingLease: null, waiters };
    }
    if (waiters[0]?.waiterId !== waiter.waiterId) {
      return { acquired: false, leasePath, lease: null, existingLease: null, waiter, waiters };
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

  if (waiter?.waiterId) {
    removeMergeLeaseWaiter({ rootDir, repo, base, waiterId: waiter.waiterId, updatedAt: acquiredAt });
  }
  return { acquired: true, leasePath, lease, waiter };
}

export function releaseMergeLease({
  rootDir,
  repo,
  base,
  leaseId: id,
  holderPr,
  holderHead,
  acquiredAt,
} = {}) {
  validateIdentity({ rootDir, repo, base });
  const leasePath = mergeLeaseFilePath(rootDir, { repo, base });
  const lease = readJsonFile(leasePath, null);
  const matched = holderMatches(lease, { leaseId: id, holderPr, holderHead, acquiredAt });
  if (!matched) {
    return { released: false, leasePath, existingLease: lease };
  }
  rmSync(leasePath, { force: true });
  return { released: true, leasePath, lease };
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
  if (!deadSameHostPid && !staleByDeadline) {
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
    return { reclaimed: false, reason: 'identity-changed', inspection, release: released };
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
