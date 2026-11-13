// QWV-04: one closer-outcome store.
//
// `data/ama-closer-outcomes` `lease-terminal` rows are the only writer of
// whether a closer landed (operator decision 2026-11-13, from the QWV-01
// 30-day join: 81 of 81 `succeeded` launches merged; reviewer_passes recorded
// 0 completed of 634 closer passes). The `reviewer_passes.status` of a
// `pass_kind='closer'` row is a projection of that journal and is written only
// here: at pass-record time, on every later reconcile of the same launch, after
// every lease-terminal journal append, and by `bin/closer-outcome-status.mjs
// --apply` for history. The pass row still owns its token usage.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export const CLOSER_OUTCOME_SOURCE = 'data/ama-closer-outcomes';
const DAY_MS = 24 * 60 * 60 * 1000;
const JOURNAL_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
// The closer ended without a verdict of its own: another owner, a later head,
// a later retry or an outside merge decides the PR.
const NOT_CONCLUDED = new Set(['superseded', 'deferred', 'pr-merged-externally']);

/**
 * Project one launch's lease-terminal outcomes (terminalAt order) onto a
 * reviewer_passes status. `succeeded` is affirmative merge evidence and a later
 * observation cannot erase it. A launch with no terminal lease outcome (for
 * example `handed-to-review`) did not land and did not refuse: `cancelled`.
 */
export function projectCloserOutcome(outcomes = []) {
  if (outcomes.includes('succeeded')) return { status: 'completed', closerOutcome: 'succeeded' };
  const last = outcomes.at(-1) ?? null;
  if (!last || NOT_CONCLUDED.has(last) || last.startsWith('retryable-')) {
    return { status: 'cancelled', closerOutcome: last };
  }
  return { status: 'failed', closerOutcome: last };
}

function dayBefore(iso) {
  const ms = Date.parse(iso || '');
  return Number.isFinite(ms) ? new Date(ms - DAY_MS).toISOString().slice(0, 10) : null;
}

/**
 * Read lease-terminal outcomes per launch. Journal files are named for their
 * rows' terminal date, and a lease cannot terminate before its launch started,
 * so `since` (a launch start) bounds the files read with one day of slack.
 * Torn or foreign rows are counted, never guessed.
 */
export function readCloserLeaseOutcomes(rootDir, { since = null, launchRequestIds = null } = {}) {
  const dir = join(rootDir, CLOSER_OUTCOME_SOURCE);
  const outcomes = new Map();
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') return { outcomes, tornRows: 0 };
    throw err;
  }
  const firstDay = since ? dayBefore(since) : null;
  const rows = [];
  let tornRows = 0;
  for (const name of names.filter(n => JOURNAL_FILE_RE.test(n)).sort()) {
    if (firstDay && name.slice(0, 10) < firstDay) continue;
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { tornRows += 1; continue; }
      if (row?.kind !== 'lease-terminal' || typeof row.outcome !== 'string'
        || typeof row.launchRequestId !== 'string') continue;
      if (typeof row.terminalAt !== 'string' || !Number.isFinite(Date.parse(row.terminalAt))) continue;
      if (launchRequestIds && !launchRequestIds.has(row.launchRequestId)) continue;
      rows.push(row);
    }
  }
  rows.sort((a, b) => Date.parse(a.terminalAt) - Date.parse(b.terminalAt));
  for (const row of rows) {
    const entry = outcomes.get(row.launchRequestId) || { outcomes: [], firstTerminalAt: row.terminalAt };
    entry.outcomes.push(row.outcome);
    outcomes.set(row.launchRequestId, entry);
  }
  return { outcomes, tornRows };
}

/** The projected status for one launch's closer pass, read at record time. */
export function projectCloserPassStatus(rootDir, { launchRequestId, since = null } = {}) {
  try {
    const { outcomes } = readCloserLeaseOutcomes(rootDir, {
      since, launchRequestIds: new Set([String(launchRequestId || '')]),
    });
    return projectCloserOutcome(outcomes.get(String(launchRequestId || ''))?.outcomes);
  } catch {
    // An unreadable journal must not cost the pass its token row; the next
    // lease-terminal append or `--apply` re-projects it.
    return projectCloserOutcome([]);
  }
}

function parseMetadata(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Compare every terminal closer pass row (optionally one launch, or rows
 * started at or after `since`) with the journal and, unless `dryRun`, rewrite
 * the rows that disagree. Running rows are never touched.
 */
export function refreshCloserPassStatuses(db, rootDir, {
  launchRequestId = null, since = null, dryRun = false,
} = {}) {
  const rows = db.prepare(
    `SELECT pass_id, status, started_at, metadata_json FROM reviewer_passes
      WHERE pass_kind = 'closer' AND status <> 'running'
        AND (? IS NULL OR started_at >= ?)
        AND (? IS NULL OR CASE WHEN json_valid(metadata_json)
          THEN json_extract(metadata_json, '$.launchRequestId') END = ?)`,
  ).all(since, since, launchRequestId, launchRequestId);
  const attributed = rows
    .map(row => ({ ...row, metadata: parseMetadata(row.metadata_json) }))
    .filter(row => typeof row.metadata.launchRequestId === 'string' && row.metadata.launchRequestId);
  if (!attributed.length) {
    return { closerRows: rows.length, unattributed: rows.length, agree: 0, disagree: [], updated: 0, tornRows: 0 };
  }
  const earliest = attributed.map(row => row.started_at).filter(Boolean).sort()[0] || since;
  const { outcomes, tornRows } = readCloserLeaseOutcomes(rootDir, {
    since: earliest, launchRequestIds: new Set(attributed.map(row => row.metadata.launchRequestId)),
  });
  const update = db.prepare(
    `UPDATE reviewer_passes
        SET status = ?, metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.closerOutcome', ?)
      WHERE pass_id = ? AND pass_kind = 'closer' AND status <> 'running'`,
  );
  const disagree = [];
  for (const row of attributed) {
    const projected = projectCloserOutcome(outcomes.get(row.metadata.launchRequestId)?.outcomes);
    if (row.status === projected.status
      && (row.metadata.closerOutcome ?? null) === projected.closerOutcome) continue;
    disagree.push({ passId: row.pass_id, launchRequestId: row.metadata.launchRequestId,
      from: row.status, to: projected.status, closerOutcome: projected.closerOutcome });
  }
  if (!dryRun && disagree.length) {
    db.transaction(() => {
      for (const item of disagree) update.run(item.to, item.closerOutcome, item.passId);
    })();
  }
  return {
    closerRows: rows.length,
    unattributed: rows.length - attributed.length,
    agree: attributed.length - disagree.length,
    disagree,
    updated: dryRun ? 0 : disagree.length,
    tornRows,
  };
}

/**
 * Re-project one launch's pass after its lease-terminal journal append (and
 * on a later reconcile of an already-recorded launch). The
 * journal write already happened; a projection failure stays local telemetry
 * and never changes closure. No reviews.db means no pass to project.
 */
export function projectCloserPassAfterOutcome(rootDir, launchRequestId, {
  warn = message => console.warn(message), busyTimeoutMs = 1000,
} = {}) {
  const dbPath = join(rootDir, 'data', 'reviews.db');
  if (!launchRequestId || !existsSync(dbPath)) return null;
  let db = null;
  try {
    db = new Database(dbPath, { fileMustExist: true });
    // Callers may hold the lease mutation lock: wait briefly, never long. A
    // miss heals on the launch's next reconcile or `closer-outcome-status --apply`.
    db.pragma(`busy_timeout = ${Math.max(0, Number(busyTimeoutMs) || 0)}`);
    return refreshCloserPassStatuses(db, rootDir, { launchRequestId });
  } catch {
    try { warn('ama_closer.pass_projection_unavailable'); } catch { /* telemetry only */ }
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/**
 * Closer outcomes in a window, straight from the authority: one count per
 * launch whose first lease-terminal row is at or after `since`.
 */
export function summarizeCloserOutcomes(rootDir, { since }) {
  const { outcomes, tornRows } = readCloserLeaseOutcomes(rootDir, { since });
  const sinceMs = Date.parse(since);
  const counts = { completed: 0, failed: 0, cancelled: 0 };
  let launches = 0;
  for (const entry of outcomes.values()) {
    if (Date.parse(entry.firstTerminalAt) < sinceMs) continue;
    launches += 1;
    counts[projectCloserOutcome(entry.outcomes).status] += 1;
  }
  return { source: CLOSER_OUTCOME_SOURCE, since, launches, ...counts, tornRows };
}
