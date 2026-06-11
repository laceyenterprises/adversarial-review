/**
 * AMA-07 — durable closer lease keyed by `(repo, prNumber, headSha)`.
 *
 * The lease is a per-head file at
 * `<rootDir>/data/ama-closer-leases/<repo>-pr-<n>-<headSha>.json`.
 *
 * Two watcher ticks on the same eligible head must not launch two
 * closers. Per SPEC §4.9, the watcher:
 *
 *   1. Calls `acquireAmaCloserLease(...)` BEFORE dispatching.
 *   2. On `acquired: true` → dispatches the closer + updates the lease
 *      to `dispatched` with the launch request id.
 *   3. On `acquired: false` → the existing lease is duplicate-dispatch
 *      protection; skip this tick.
 *
 * The closer worker's terminal audit-write (AMA-04) updates the lease
 * to `terminal` with the resolved `terminalOutcome`. Head-change
 * naturally invalidates an older lease — a new head SHA gets a fresh
 * lease file; the old one persists for audit.
 *
 * State machine:
 *
 *   pending  ──dispatched()──▶ dispatched
 *                                  │
 *                                  └── terminalized()──▶ terminal (FINAL)
 *
 * Transitions are write-once-per-state. `terminal` is never reverted
 * to `pending` or `dispatched`.
 *
 * @module ama/closer-lease
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../atomic-write.mjs';

const LEASE_DIR_SEGMENTS = ['data', 'ama-closer-leases'];
const LEASE_FILE_MODE = 0o640;
const LEASE_SCHEMA_VERSION = 1;

const PENDING = 'pending';
const DISPATCHED = 'dispatched';
const TERMINAL = 'terminal';

const VALID_STATUSES = new Set([PENDING, DISPATCHED, TERMINAL]);
const VALID_TERMINAL_OUTCOMES = new Set([
  'succeeded',
  'failed-without-merge',
  'deferred',
  'superseded',
]);

/**
 * Sanitize a path segment — the same regex the rest of the AMA module
 * uses (allow alnum + `.` + `_` + `-`; replace everything else).
 * Slashes in `<owner>/<name>` collapse to a stable `__` so the lease
 * file is one filename per head and `ls`-able by repo.
 */
function sanitizeSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * Resolve the canonical lease path. Exported so tests + ad-hoc
 * inspection don't re-derive it.
 *
 * @param {string} rootDir   adversarial-review submodule root (or a tmp root in tests).
 * @param {object} identity
 * @param {string} identity.repo       `<owner>/<name>`
 * @param {number} identity.prNumber
 * @param {string} identity.headSha
 * @returns {string} absolute lease file path
 */
export function amaCloserLeaseFilePath(rootDir, { repo, prNumber, headSha } = {}) {
  if (!rootDir) {
    throw new Error('amaCloserLeaseFilePath: rootDir is required');
  }
  if (!repo) {
    throw new Error('amaCloserLeaseFilePath: identity.repo is required');
  }
  if (!Number.isFinite(Number(prNumber))) {
    throw new Error('amaCloserLeaseFilePath: identity.prNumber must be numeric');
  }
  if (!headSha) {
    throw new Error('amaCloserLeaseFilePath: identity.headSha is required');
  }
  const safeRepo = sanitizeSegment(String(repo).replace(/\//g, '__'));
  const safeHead = sanitizeSegment(String(headSha));
  return join(
    rootDir,
    ...LEASE_DIR_SEGMENTS,
    `${safeRepo}-pr-${Number(prNumber)}-${safeHead}.json`,
  );
}

/**
 * Read an existing lease from disk; `null` if absent. Wrapped here so
 * callers can branch on first-acquire vs already-held without leaking
 * fs error shapes.
 */
function readLeaseFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Public — read the lease for a given `(repo, prNumber, headSha)`.
 * Returns `null` when no lease exists.
 *
 * @param {string} rootDir
 * @param {object} identity
 * @returns {object|null}
 */
export function readAmaCloserLease(rootDir, identity) {
  return readLeaseFile(amaCloserLeaseFilePath(rootDir, identity));
}

/**
 * Atomically acquire the lease for `(repo, prNumber, headSha)`.
 *
 * Race semantics: the underlying `writeFileAtomic(..., { overwrite: false })`
 * does a tmp + `linkSync` rather than `renameSync`. `linkSync` throws
 * `EEXIST` when the destination file already exists, so two concurrent
 * acquirers cannot both succeed — exactly one wins, the loser sees
 * `acquired: false` and the existing lease on disk.
 *
 * @param {object} args
 * @param {string} args.rootDir
 * @param {string} args.repo
 * @param {number} args.prNumber
 * @param {string} args.headSha
 * @param {number} args.watcherPid     For audit; recorded on the lease.
 * @param {string=} args.now           ISO 8601 UTC for `acquiredAt`. Caller-provided so tests stay deterministic.
 * @returns {{ acquired: boolean, leasePath: string, lease: object, existingLease?: object }}
 */
export function acquireAmaCloserLease({
  rootDir,
  repo,
  prNumber,
  headSha,
  watcherPid,
  now,
} = {}) {
  const leasePath = amaCloserLeaseFilePath(rootDir, { repo, prNumber, headSha });
  // Pre-check — cheap path when an existing lease is on disk. The
  // atomic linkSync below would also detect this, but the pre-read
  // gives a clean existingLease payload to return without sniffing
  // error codes.
  const existingLease = readLeaseFile(leasePath);
  if (existingLease) {
    return { acquired: false, leasePath, lease: existingLease, existingLease };
  }
  const lease = {
    schemaVersion: LEASE_SCHEMA_VERSION,
    repo,
    prNumber: Number(prNumber),
    headSha,
    acquiredAt: now || new Date().toISOString(),
    watcherPid: Number.isFinite(Number(watcherPid)) ? Number(watcherPid) : null,
    lrqId: null,
    status: PENDING,
    terminalOutcome: null,
    updatedAt: now || new Date().toISOString(),
  };
  try {
    writeFileAtomic(leasePath, `${JSON.stringify(lease, null, 2)}\n`, {
      mode: LEASE_FILE_MODE,
      overwrite: false,
    });
  } catch (err) {
    if (err?.code === 'EEXIST') {
      // Race: another acquirer beat us. Re-read the now-present lease.
      const beat = readLeaseFile(leasePath);
      return { acquired: false, leasePath, lease: beat, existingLease: beat };
    }
    throw err;
  }
  return { acquired: true, leasePath, lease };
}

/**
 * Apply a state transition to an existing lease. The state machine is
 * `pending → dispatched → terminal`; transitions are write-once-per-
 * state. Demoting `terminal` to anything else is refused with a
 * thrown error (mirrors the AMA-04 audit writer's sticky-succeeded
 * refusal).
 *
 * Caller selects the transition via the args:
 *
 *   - `{ status: 'dispatched', lrqId }` — moves a `pending` lease to
 *     `dispatched`. Required: `lrqId`.
 *   - `{ status: 'terminal', terminalOutcome }` — moves a `dispatched`
 *     (or `pending`, if the closer never got dispatched) lease to
 *     `terminal`. Required: `terminalOutcome ∈ {succeeded,
 *     failed-without-merge, deferred, superseded}`.
 *
 * @param {object} args
 * @param {string} args.rootDir
 * @param {string} args.repo
 * @param {number} args.prNumber
 * @param {string} args.headSha
 * @param {string} args.status
 * @param {string=} args.lrqId
 * @param {string=} args.terminalOutcome
 * @param {string=} args.now
 * @returns {{ leasePath: string, lease: object }}
 */
export function updateAmaCloserLease({
  rootDir,
  repo,
  prNumber,
  headSha,
  status,
  lrqId,
  terminalOutcome,
  now,
} = {}) {
  if (!VALID_STATUSES.has(String(status || ''))) {
    throw new RangeError(
      `updateAmaCloserLease: status '${status}' is not in ` +
      `${[...VALID_STATUSES].join('|')}`,
    );
  }
  if (status === DISPATCHED && !lrqId) {
    throw new Error(`updateAmaCloserLease: status='dispatched' requires lrqId`);
  }
  if (status === TERMINAL && !VALID_TERMINAL_OUTCOMES.has(String(terminalOutcome || ''))) {
    throw new RangeError(
      `updateAmaCloserLease: status='terminal' requires terminalOutcome ` +
      `in (${[...VALID_TERMINAL_OUTCOMES].join('|')}); got '${terminalOutcome}'`,
    );
  }

  const leasePath = amaCloserLeaseFilePath(rootDir, { repo, prNumber, headSha });
  const existing = readLeaseFile(leasePath);
  if (!existing) {
    throw new Error(
      `updateAmaCloserLease: no lease at ${leasePath} — ` +
      `call acquireAmaCloserLease first`,
    );
  }

  // Refuse to demote a terminal lease — same shape as the AMA-04
  // sticky-succeeded refusal. If the closer reaches a different
  // terminal on a re-tick (e.g. failed-without-merge then deferred),
  // the watcher should reconcile from fresh GitHub state via the
  // SPEC §4.4 repair logic instead of mutating the lease.
  if (existing.status === TERMINAL) {
    throw new Error(
      `updateAmaCloserLease: refusing to demote terminal lease for ` +
      `${repo} pr#${prNumber} head=${headSha}. Existing terminalOutcome=` +
      `'${existing.terminalOutcome}', attempted status='${status}'.`,
    );
  }

  // Allow pending→terminal (closer never dispatched but the watcher
  // observed a terminal outcome) and dispatched→terminal. Refuse
  // pending←dispatched (going backwards).
  if (existing.status === DISPATCHED && status === PENDING) {
    throw new Error(
      `updateAmaCloserLease: refusing to revert dispatched lease back ` +
      `to pending for ${repo} pr#${prNumber} head=${headSha}`,
    );
  }

  const updatedAt = now || new Date().toISOString();
  const next = {
    ...existing,
    status,
    updatedAt,
    ...(status === DISPATCHED ? { lrqId: String(lrqId) } : {}),
    ...(status === TERMINAL ? { terminalOutcome: String(terminalOutcome) } : {}),
  };
  writeFileAtomic(leasePath, `${JSON.stringify(next, null, 2)}\n`, {
    mode: LEASE_FILE_MODE,
    overwrite: true,
  });
  return { leasePath, lease: next };
}

/**
 * Lease status constants — exported so consumers don't re-stringify.
 */
export const AMA_CLOSER_LEASE_STATUS = Object.freeze({
  PENDING,
  DISPATCHED,
  TERMINAL,
});
