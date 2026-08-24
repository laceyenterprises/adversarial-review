// Durable record of WHY the AMA daemon clean-merge declined to merge a PR.
//
// The daemon already fails closed correctly — `worker-identity-unresolved`,
// `verdict-not-eligible`, and `lease-not-held` are deliberate parks, not bugs:
// they protect the head-binding security property and must never auto-resolve.
// The gap this module closes is OBSERVABILITY, not policy.
//
// Before this, a park existed only as an untimestamped line in the watcher's
// multi-million-line stdout log:
//
//   [watcher] AMA daemon clean-merge failed-closed for owner/repo#35@abc: worker-identity-unresolved
//
// `review-pipeline-health` could not read that, so a parked PR surfaced only as
// a generic `review:terminal_but_unmerged` whose recommended action listed the
// possible causes ("AMA eligibility misses such as worker-identity-unresolved/
// stale-review-head") instead of naming the one that actually applied. On
// 2026-08-23 laceyenterprises/foundry#35 sat parked 8.8 hours on
// `worker-identity-unresolved` — a one-command fix (`hq pr sign`) — because
// nothing told the operator which lever to pull.
//
// Records are keyed per (repo, PR) and are pure diagnostics: nothing reads them
// to make a merge decision. A stale record can therefore never authorize or
// block a merge; the worst case is a spurious ticket that clears on the next
// successful merge or park-reason change.

import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';

const PARK_DIR = 'daemon-merge-parks';
const SCHEMA_VERSION = 1;

// Parks the operator can clear directly, mapped to the specific lever. Reasons
// absent from this map still record — they just carry the generic remedy.
const PARK_REMEDIES = Object.freeze({
  'worker-identity-unresolved':
    'The PR has no `pr_opened` build-completion identity row, so both merge routes '
    + 'fail closed by design. If an interactive session opened this PR outside '
    + '`hq pr open`, sign it: `hq pr sign --worker-class <class> --pr <n> --repo '
    + '<owner/repo> --head-sha <head> --branch <branch>`. Otherwise apply a '
    + 'head-scoped operator merge label so it closes under an operator-accountable '
    + 'lease. Do NOT relax the identity gate.',
  'verdict-not-eligible':
    'The settled verdict is not daemon-mergeable (blocking findings, or non-blocking '
    + 'findings while strict_mode=true). Expect the hammer to remediate; if no hammer '
    + 'is dispatching, check hammer closeout liveness and the per-PR retry cap.',
  'lease-not-held':
    'The daemon could not take the shared merge lease. Check for a stale or orphaned '
    + 'lease under data/merge-leases and the ama-closer lease reaper.',
});

function repoSlug(repo) {
  return String(repo || '').replace(/[^A-Za-z0-9._-]+/g, '__');
}

function parkDir(rootDir) {
  return join(rootDir, 'data', PARK_DIR);
}

function parkRecordPath(rootDir, repo, prNumber) {
  return join(parkDir(rootDir), `${repoSlug(repo)}__pr-${Number(prNumber)}.json`);
}

function readRecord(filePath, readFileSyncImpl) {
  try {
    const parsed = JSON.parse(readFileSyncImpl(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // Missing, truncated, or hand-edited: treat as absent so a corrupt
    // diagnostic file can never wedge the daemon that writes it.
    return null;
  }
}

function activeParkKeySet(activeReviewRows) {
  if (!activeReviewRows) return null;
  const rows = activeReviewRows instanceof Map
    ? activeReviewRows.values()
    : Array.isArray(activeReviewRows)
      ? activeReviewRows
      : [];
  const keys = new Set();
  for (const row of rows) {
    const repo = row?.repo;
    const prNumber = Number(row?.pr_number ?? row?.prNumber);
    if (!repo || !Number.isFinite(prNumber)) continue;
    if (String(row?.pr_state ?? row?.prState ?? 'open') !== 'open') continue;
    keys.add(`${repo}#${prNumber}`);
  }
  return keys;
}

/**
 * Record (or refresh) a park for `repo#prNumber`.
 *
 * A repeat park with the SAME reason increments `observationCount` and moves
 * `lastObservedAt`, preserving `firstObservedAt` so health can report how long
 * the PR has actually been stuck. A park with a DIFFERENT reason restarts the
 * record — the previous reason is no longer the thing blocking the merge.
 */
function recordDaemonMergePark({
  rootDir,
  repo,
  prNumber,
  headSha = null,
  reason,
  observedAt,
  mkdirSyncImpl = mkdirSync,
  readFileSyncImpl = readFileSync,
  writeFileAtomicImpl = writeFileAtomic,
} = {}) {
  if (!rootDir || !repo || !Number.isFinite(Number(prNumber)) || !reason) return null;
  const at = observedAt || new Date().toISOString();
  const filePath = parkRecordPath(rootDir, repo, prNumber);
  const prior = readRecord(filePath, readFileSyncImpl);
  const continuing = prior?.reason === reason;

  const record = {
    schemaVersion: SCHEMA_VERSION,
    repo: String(repo),
    prNumber: Number(prNumber),
    headSha: headSha ? String(headSha) : null,
    reason: String(reason),
    firstObservedAt: continuing ? (prior.firstObservedAt || at) : at,
    lastObservedAt: at,
    observationCount: continuing ? Number(prior.observationCount || 0) + 1 : 1,
    remedy: PARK_REMEDIES[reason] || null,
  };

  try {
    mkdirSyncImpl(parkDir(rootDir), { recursive: true });
    writeFileAtomicImpl(filePath, `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // Diagnostics must never break the merge path they observe.
    return null;
  }
  return record;
}

/**
 * Drop the park record for `repo#prNumber`. Called when the daemon merges, or
 * when the PR leaves the parked population, so a cleared park stops ticketing.
 */
function clearDaemonMergePark({
  rootDir,
  repo,
  prNumber,
  rmSyncImpl = rmSync,
} = {}) {
  if (!rootDir || !repo || !Number.isFinite(Number(prNumber))) return false;
  try {
    rmSyncImpl(parkRecordPath(rootDir, repo, prNumber), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * All current park records, newest-stuck first. Unreadable entries are skipped
 * rather than thrown so one bad file cannot blind the whole health surface.
 */
function readDaemonMergeParks({
  rootDir,
  activeReviewRows = null,
  readdirSyncImpl = readdirSync,
  readFileSyncImpl = readFileSync,
  rmSyncImpl = rmSync,
} = {}) {
  if (!rootDir) return [];
  let entries;
  try {
    entries = readdirSyncImpl(parkDir(rootDir));
  } catch {
    return [];
  }
  const parks = [];
  const activeKeys = activeParkKeySet(activeReviewRows);
  for (const entry of entries) {
    if (!String(entry).endsWith('.json')) continue;
    const filePath = join(parkDir(rootDir), entry);
    const record = readRecord(filePath, readFileSyncImpl);
    if (record?.repo && Number.isFinite(Number(record.prNumber)) && record.reason) {
      if (activeKeys && !activeKeys.has(`${record.repo}#${Number(record.prNumber)}`)) {
        try {
          rmSyncImpl(filePath, { force: true });
        } catch {
          // Diagnostics stay best-effort. Even if deletion fails, do not emit a
          // ticket for a PR that the active review ledger says is gone.
        }
        continue;
      }
      parks.push(record);
    }
  }
  parks.sort((a, b) => String(a.firstObservedAt || '').localeCompare(String(b.firstObservedAt || '')));
  return parks;
}

export {
  PARK_DIR,
  PARK_REMEDIES,
  clearDaemonMergePark,
  parkRecordPath,
  readDaemonMergeParks,
  recordDaemonMergePark,
};
