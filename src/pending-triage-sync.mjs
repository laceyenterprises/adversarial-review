// Durable queue for the operator-surface (Linear) triage sync owed by a PR
// lifecycle transition.
//
// TREC-01. This module exists to dissolve a real conflict between two correct
// invariants that previously could not both hold.
//
//   A. A merged/closed PR's Linear ticket must never be left permanently stale.
//      The prior code enforced this by putting `stmtMarkMerged` AFTER the
//      remote `operatorSurface.syncTriageStatus` await inside one try block, so
//      a Linear failure threw past the mark and the row stayed `pr_state=open`
//      for the next tick to retry. `test/pr-lifecycle-triage-retry.test.mjs`
//      pinned exactly that ordering.
//
//   B. A PR that GitHub reports terminal must be recorded terminal promptly.
//      `review:queue_starvation` and `review:terminal_but_unmerged` both select
//      on `pr_state='open'` and then threshold on ELAPSED AGE, so a row held
//      open produces an alert whose age only grows and which can never clear.
//      On 2026-09-07 four merged PRs and one closed PR alerted this way.
//
// Under (A) the retry vehicle for the Linear obligation WAS the open row, which
// is why holding the row open looked necessary. That coupling is the bug: it
// makes an unrelated remote dependency decide whether local truth gets written.
//
// Giving the obligation its own durable record breaks the coupling. The row can
// be marked terminal the moment GitHub confirms it (satisfying B) because the
// Linear sync is now owed by a file on disk that a retry drain will keep
// attempting (satisfying A). The obligation outlives the process, the row, and
// the outage.
//
// Modeled directly on `dag-autowalk-on-merge.mjs`, which is the established
// house shape for "owed work persisted before the mark, drained on later
// ticks".
//
// @module pending-triage-sync

import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeFileAtomic } from './atomic-write.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SCHEMA_VERSION = 1;
const DEFAULT_TRIAGE_SYNC_RETRY_MS = 5 * 60 * 1000;
const DEFAULT_TRIAGE_SYNC_PER_POLL = 10;
// Higher than the dag-autowalk cap: this is a cheap single API call, and
// abandoning it silently reintroduces exactly the permanently-stale ticket that
// invariant (A) exists to prevent. When the cap IS reached the record is kept
// as `failed`, not deleted, so it stays visible to an operator.
const DEFAULT_TRIAGE_SYNC_MAX_ATTEMPTS = 12;

function sanitizeSegment(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 180) || 'unknown';
}

export function pendingTriageSyncDir(rootDir = ROOT) {
  return join(rootDir, 'data', 'follow-up-jobs', 'pending-triage-sync');
}

function pendingTriageSyncPath(rootDir, { repo, prNumber }) {
  return join(
    pendingTriageSyncDir(rootDir),
    `${sanitizeSegment(repo)}-pr-${sanitizeSegment(prNumber)}.json`
  );
}

function readRecord(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeRecord(rootDir, record) {
  const path = pendingTriageSyncPath(rootDir, record);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

export function listPendingTriageSyncs(rootDir = ROOT) {
  try {
    return readdirSync(pendingTriageSyncDir(rootDir))
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const path = join(pendingTriageSyncDir(rootDir), name);
        const record = readRecord(path);
        return record ? { path, record } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parsePositiveInt(raw, fallback) {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveTriageSyncRetryMs(env = process.env) {
  return parsePositiveInt(env.ADVERSARIAL_TRIAGE_SYNC_RETRY_MS, DEFAULT_TRIAGE_SYNC_RETRY_MS);
}

export function resolveTriageSyncPerPoll(env = process.env) {
  return parsePositiveInt(env.ADVERSARIAL_TRIAGE_SYNC_PER_POLL, DEFAULT_TRIAGE_SYNC_PER_POLL);
}

export function resolveTriageSyncMaxAttempts(env = process.env) {
  return parsePositiveInt(env.ADVERSARIAL_TRIAGE_SYNC_MAX_ATTEMPTS, DEFAULT_TRIAGE_SYNC_MAX_ATTEMPTS);
}

/**
 * Persist the triage sync owed by a terminal transition.
 *
 * MUST be called (and MUST succeed) before the reviewed_prs terminal mark. If
 * this write fails the caller has to defer the mark, because at that point the
 * open row is once again the only record that the obligation exists.
 *
 * Everything needed to replay the call is stored, so the drain never has to
 * consult the reviewed_prs row -- which by then is terminal and no longer on
 * the open list.
 */
export function queuePendingTriageSync(rootDir, {
  repo,
  prNumber,
  transition,
  status,
  domainId = null,
  linearTicketId = null,
  labels = [],
  revisionRef = null,
  now = new Date(),
} = {}) {
  if (!repo || !Number.isFinite(Number(prNumber))) {
    throw new TypeError('queuePendingTriageSync requires repo and prNumber');
  }
  const iso = now.toISOString();
  const existing = readRecord(pendingTriageSyncPath(rootDir, { repo, prNumber }));
  const record = {
    schemaVersion: SCHEMA_VERSION,
    repo,
    prNumber: Number(prNumber),
    transition,
    status: 'pending',
    // The triage status to write, resolved by the caller so this module holds
    // no policy about what a transition means.
    triageStatus: status,
    domainId,
    linearTicketId,
    labels: Array.isArray(labels) ? labels : [],
    revisionRef,
    createdAt: existing?.createdAt || iso,
    updatedAt: iso,
    attempts: Number(existing?.attempts || 0),
    lastAttemptAt: existing?.lastAttemptAt || null,
    lastError: existing?.lastError || null,
  };
  writeRecord(rootDir, record);
  return record;
}

export function clearPendingTriageSync(rootDir, { repo, prNumber }) {
  rmSync(pendingTriageSyncPath(rootDir, { repo, prNumber }), { force: true });
}

/**
 * Attempt one owed triage sync. Deletes the record on success; on failure keeps
 * it pending (or marks it `failed` at the attempt cap) so it stays drainable
 * and visible.
 */
export async function attemptPendingTriageSync({
  rootDir = ROOT,
  record,
  operatorSurface,
  buildSubjectRef,
  logger = console,
  now = () => new Date(),
  maxAttempts = resolveTriageSyncMaxAttempts(),
} = {}) {
  const repo = record?.repo;
  const prNumber = record?.prNumber;
  if (!repo || !Number.isFinite(Number(prNumber))) {
    return { ok: false, skipped: true, reason: 'malformed-record' };
  }
  if (typeof operatorSurface?.syncTriageStatus !== 'function') {
    return { ok: false, skipped: true, reason: 'no-operator-surface' };
  }

  const attempts = Number(record.attempts || 0) + 1;
  const startedAt = now().toISOString();
  try {
    await operatorSurface.syncTriageStatus(
      buildSubjectRef(record),
      record.triageStatus
    );
    clearPendingTriageSync(rootDir, { repo, prNumber });
    return { ok: true, attempts };
  } catch (err) {
    const terminal = attempts >= maxAttempts;
    writeRecord(rootDir, {
      ...record,
      status: terminal ? 'failed' : 'pending',
      attempts,
      lastAttemptAt: startedAt,
      updatedAt: now().toISOString(),
      lastError: {
        message: String(err?.message || err).slice(0, 500),
        code: err?.code ?? null,
      },
    });
    logger.error?.(
      `[watcher] triage sync failed for ${repo}#${prNumber} `
      + `(attempt ${attempts}/${maxAttempts}): ${err?.message || err}`
    );
    return { ok: false, terminal, attempts, error: err };
  }
}

function shouldRetry(record, { nowMs, retryMs, maxAttempts }) {
  if (record?.status === 'failed') return false;
  if (Number(record?.attempts || 0) >= maxAttempts) return false;
  if (!record?.lastAttemptAt) return true;
  const lastMs = Date.parse(record.lastAttemptAt);
  if (!Number.isFinite(lastMs)) return true;
  return nowMs - lastMs >= retryMs;
}

/**
 * Drain owed triage syncs. Wired into the watcher poll tick beside the other
 * `retryPending*` drains; this is the vehicle that replaces "hold the reviewed
 * PR row open" as the retry mechanism for invariant (A).
 */
export async function retryPendingTriageSyncs({
  rootDir = ROOT,
  operatorSurface,
  buildSubjectRef,
  logger = console,
  env = process.env,
  nowMs = Date.now(),
  now = () => new Date(),
  retryMs = null,
  maxPerPoll = null,
  maxAttempts = null,
} = {}) {
  const resolvedRetryMs = retryMs ?? resolveTriageSyncRetryMs(env);
  const resolvedPerPoll = maxPerPoll ?? resolveTriageSyncPerPoll(env);
  const resolvedMaxAttempts = maxAttempts ?? resolveTriageSyncMaxAttempts(env);
  if (resolvedPerPoll <= 0) return { attempted: 0, synced: 0, skipped: 0, pending: 0 };
  if (typeof operatorSurface?.syncTriageStatus !== 'function'
    || typeof buildSubjectRef !== 'function') {
    return { attempted: 0, synced: 0, skipped: 0, pending: 0, reason: 'no-operator-surface' };
  }

  const pending = listPendingTriageSyncs(rootDir);
  let attempted = 0;
  let synced = 0;
  let skipped = 0;
  for (const item of pending) {
    if (attempted >= resolvedPerPoll
      || !shouldRetry(item.record, {
        nowMs,
        retryMs: resolvedRetryMs,
        maxAttempts: resolvedMaxAttempts,
      })) {
      skipped += 1;
      continue;
    }
    attempted += 1;
    const result = await attemptPendingTriageSync({
      rootDir,
      record: item.record,
      operatorSurface,
      buildSubjectRef,
      logger,
      now,
      maxAttempts: resolvedMaxAttempts,
    });
    if (result.ok) synced += 1;
  }
  return { attempted, synced, skipped, pending: pending.length };
}

export default {
  attemptPendingTriageSync,
  clearPendingTriageSync,
  listPendingTriageSyncs,
  pendingTriageSyncDir,
  queuePendingTriageSync,
  retryPendingTriageSyncs,
};
