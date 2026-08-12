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
 * The closer worker's terminal audit-write (AMA-04) or watcher-side
 * repair updates the lease to `terminal` with the resolved
 * `terminalOutcome`. Head-change naturally invalidates an older lease
 * — a new head SHA gets a fresh lease file; the old one persists for
 * audit until watcher-side repair clears it for a same-head retry.
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

import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

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

function supersededHeadsFor(lease) {
  const heads = new Set();
  if (Array.isArray(lease?.supersededHeads)) {
    for (const head of lease.supersededHeads) {
      if (head) heads.add(String(head));
    }
  }
  if (lease?.rekeyedFromHeadSha) {
    heads.add(String(lease.rekeyedFromHeadSha));
  }
  return [...heads];
}

function leaseSupersedesHead(lease, headSha) {
  const needle = String(headSha || '');
  return Boolean(needle) && supersededHeadsFor(lease).includes(needle);
}

function compareUpdatedAtDesc(a, b) {
  return String(b.lease.updatedAt || '').localeCompare(String(a.lease.updatedAt || ''));
}

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
 * Delete the durable lease file for a `(repo, prNumber, headSha)` tuple.
 * Used only by watcher-side repair once another durable record proves
 * the lease no longer represents live ownership.
 *
 * @param {string} rootDir
 * @param {object} identity
 * @returns {string} deleted lease path
 */
export function deleteAmaCloserLease(rootDir, identity) {
  const leasePath = amaCloserLeaseFilePath(rootDir, identity);
  rmSync(leasePath, { force: true });
  return leasePath;
}

/**
 * Carry a live lease forward when the closer moves the head it already owns.
 *
 * The lease is keyed by `(repo, prNumber, headSha)`, so a rebase performed BY the
 * closer orphans its own lease: the file still exists under the old SHA, that SHA
 * is no longer in the branch, and nothing can finalize it. Observed on
 * adversarial-review#825 on 2026-08-11 -- the hammer rebased the head, then the
 * lease sat at `status: dispatched` on a discarded commit while the watcher looped
 * `review-queued -> skip-re-review (terminal closer commit) -> release claim`
 * forever. CI was green and the review clean; nothing could merge it, and there is
 * no operator CLI for closer leases.
 *
 * Deliberately conservative:
 *  - refuses when no lease exists at `fromHeadSha` (nothing to carry)
 *  - refuses when an unrelated lease already exists at `toHeadSha` (would clobber a real owner)
 *  - resumes an interrupted carry when the destination points back to `fromHeadSha`
 *  - refuses a terminal lease (a finished lease must not be resurrected onto a new head)
 *  - preserves `acquiredAt`, `lrqId` and `watcherPid`; only `headSha` and `updatedAt`
 *    change, so the audit trail still shows one continuous ownership
 *
 * @param {object} args
 * @param {string} args.rootDir
 * @param {string} args.repo
 * @param {number} args.prNumber
 * @param {string} args.fromHeadSha    The head the lease is currently keyed to.
 * @param {string} args.toHeadSha      The head the closer just moved to.
 * @param {string=} args.now           ISO 8601 UTC; caller-provided so tests stay deterministic.
 * @returns {{ rekeyed: boolean, reason?: string, leasePath?: string, lease?: object }}
 */
export function rekeyAmaCloserLease({
  rootDir,
  repo,
  prNumber,
  fromHeadSha,
  toHeadSha,
  now,
} = {}) {
  if (!fromHeadSha || !toHeadSha) {
    throw new Error('rekeyAmaCloserLease: fromHeadSha and toHeadSha are required');
  }
  if (String(fromHeadSha) === String(toHeadSha)) {
    return { rekeyed: false, reason: 'same-head' };
  }

  const fromPath = amaCloserLeaseFilePath(rootDir, { repo, prNumber, headSha: fromHeadSha });
  const existing = readLeaseFile(fromPath);
  if (!existing) {
    return { rekeyed: false, reason: 'no-lease-at-from-head' };
  }
  if (String(existing.status) === TERMINAL) {
    // A finished lease must not be resurrected onto a new head; that would let a
    // completed close be replayed against different code.
    return { rekeyed: false, reason: 'refusing-to-rekey-terminal-lease', lease: existing };
  }

  const toPath = amaCloserLeaseFilePath(rootDir, { repo, prNumber, headSha: toHeadSha });
  const destination = readLeaseFile(toPath);
  if (destination) {
    // RESUME an interrupted rekey before refusing. This is a two-step operation
    // (write destination, then remove source), so a crash between the steps leaves
    // BOTH files on disk. A guard that only refuses would then refuse forever on
    // every retry -- turning one transient interruption into a permanently orphaned
    // lease, which is the very strand this function exists to fix. If the destination
    // carries this fromHeadSha, step 1 already succeeded and the source is obsolete
    // even if the destination has since progressed to terminal or a replacement owner.
    if (
      String(destination.headSha || '') === String(toHeadSha)
      && leaseSupersedesHead(destination, fromHeadSha)
    ) {
      rmSync(fromPath, { force: true });
      if (String(destination.status) === TERMINAL) {
        return {
          rekeyed: false,
          reason: 'destination-already-terminal',
          resumed: true,
          leasePath: toPath,
          lease: destination,
        };
      }
      return { rekeyed: true, resumed: true, leasePath: toPath, lease: destination };
    }
    // A genuinely different owner holds the destination head. Carrying ours forward
    // would silently clobber a live owner, which is worse than the strand.
    return { rekeyed: false, reason: 'lease-already-exists-at-to-head' };
  }

  const carried = {
    ...existing,
    headSha: String(toHeadSha),
    rekeyedFromHeadSha: String(fromHeadSha),
    supersededHeads: [...supersededHeadsFor(existing), String(fromHeadSha)],
    updatedAt: now || new Date().toISOString(),
  };
  try {
    writeFileAtomic(toPath, `${JSON.stringify(carried, null, 2)}\n`, { overwrite: false });
  } catch (err) {
    if (err?.code === 'EEXIST') {
      return { rekeyed: false, reason: 'lease-already-exists-at-to-head' };
    }
    throw err;
  }
  rmSync(fromPath, { force: true });
  return { rekeyed: true, leasePath: toPath, lease: carried };
}

/**
 * Find this PR's live (non-terminal) lease whatever head it is keyed to.
 *
 * Needed because the lease head is the head the CLOSER was dispatched for, which is
 * not the reviewer's head and not necessarily the current head. On #825 the lease sat
 * at 5fdfb3bf (dispatch head) while the reviewer row pointed at ebd6c55 and the branch
 * had moved to ab9aafb -- so a caller that only knows one of those cannot find it.
 *
 * @returns {{ headSha: string, leasePath: string, lease: object } | null}
 */
export function findLiveAmaCloserLease(rootDir, { repo, prNumber } = {}) {
  if (!repo) {
    throw new TypeError('findLiveAmaCloserLease: identity.repo is required');
  }
  if (!Number.isFinite(Number(prNumber))) {
    throw new TypeError('findLiveAmaCloserLease: identity.prNumber must be numeric');
  }

  const dir = join(rootDir, ...LEASE_DIR_SEGMENTS);
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  // Derive the prefix from the canonical path builder rather than re-deriving the
  // naming scheme. Duplicating it is how this function was wrong on first write:
  // the builder maps `/` -> `__` BEFORE sanitizing, while a direct sanitize maps it
  // to `-`, so the scan silently matched nothing.
  const SENTINEL = 'H';
  const sampleName = basename(amaCloserLeaseFilePath(rootDir, { repo, prNumber, headSha: SENTINEL }));
  const prefix = sampleName.slice(0, sampleName.length - `${SENTINEL}.json`.length);
  const candidates = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const leasePath = join(dir, name);
    const lease = readLeaseFile(leasePath);
    if (!lease) continue;
    candidates.push({ headSha: String(lease.headSha || ''), leasePath, lease });
  }

  const supersededHeads = new Set(candidates.flatMap(({ lease }) => supersededHeadsFor(lease)));
  return candidates.sort(compareUpdatedAtDesc).find(({ headSha, lease }) => (
    !supersededHeads.has(headSha)
    && String(lease.status) !== TERMINAL
  )) || null;
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
