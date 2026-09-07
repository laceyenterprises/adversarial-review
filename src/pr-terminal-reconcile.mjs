// Reconcile the reviews.db lifecycle mirror against authoritative GitHub state.
//
// TREC-01. Two alert surfaces in `review-pipeline-health` decide entirely from
// `reviewed_prs.pr_state`:
//
//   review:queue_starvation      firstPassQueue  -> WHERE pr_state = 'open'
//                                                     AND review_status = 'pending'
//   review:terminal_but_unmerged ttm-tracker     -> `if (row.prState !== 'open') continue`
//
// Both then threshold on ELAPSED AGE. That combination is what turns a single
// missed terminal transition into a permanent alert: the row never leaves the
// population, and its age only grows, so nothing can ever clear it.
//
// Observed 2026-09-07 on the reference host (postmortem SEV2-pipeline-alerts-
// fire-on-merged-and-closed-prs-2026-09-07.md):
//
//   agent-os#6394  closed 05:50:15Z  still firstPassQueue.oldest at 06:18:52Z
//   agent-os#6364  merged 05:10:03Z  still flagged terminal_but_unmerged
//   agent-os#6383  merged 04:43:31Z  still flagged terminal_but_unmerged
//   agent-os#6384  merged 05:24:52Z  still flagged terminal_but_unmerged
//
// All four carried pr_state='open' and merged_at=NULL in reviews.db while
// GitHub reported them terminal. The alerts were reading the mirror correctly;
// the mirror was wrong.
//
// The mirror had exactly one writer on the normal path -- `syncPRLifecycle` --
// and it lost the terminal fact in two distinct ways:
//
//   1. A per-PR live-state fetch failure `continue`d before the merged/closed
//      check ran. The live watcher log for that window shows the whole open
//      list skipped in one tick on `gh: Bad credentials (HTTP 401)`.
//   2. The `stmtMarkMerged` / `stmtMarkClosed` write was the LAST statement in
//      the try block, behind a remote Linear `syncTriageStatus` await. A Linear
//      failure threw past the mark, so a fact we had already observed from
//      GitHub was discarded to "leave the row open for retry" -- and a durable
//      Linear fault makes that retry fail identically forever.
//
// This module is the reconciliation core for both. It is deliberately narrow:
// it decides ONLY "is this PR terminal on GitHub, and is the mirror's terminal
// column written". It takes no merge decision, spawns nothing, and never
// suppresses a finding -- a genuinely open PR is left exactly as it was, so a
// real backlog still alerts.
//
// Two invariants that the loop preserves and that its tests pin:
//
//   * A per-PR failure is contained to that PR. It is recorded in `unresolved`
//     and the sweep continues. One 401 must not blind the whole fleet.
//   * The terminal write is ordered AFTER durable owed-work is queued
//     (`onBeforeMark`) but BEFORE any best-effort remote call (`onAfterMark`).
//     Owed work that failed to persist must still block the mark, because the
//     row leaving the open list is what schedules its retry. A remote call that
//     merely failed to report must not, because the terminal fact is already
//     known and re-observing it costs another GitHub round trip.
//
// @module pr-terminal-reconcile

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';

const SCHEMA_VERSION = 1;
const RECONCILE_STATE_FILE = join('data', 'pr-lifecycle-reconcile', 'state.json');

// How long a reconciliation record may go unrefreshed before the health surface
// calls the mirror unverified. The watcher poll interval is 300s; three missed
// sweeps is a real outage rather than a slow tick.
export const DEFAULT_RECONCILE_STALE_AFTER_MS = 15 * 60 * 1000;

export function reconcileStatePath(rootDir) {
  return join(rootDir, RECONCILE_STATE_FILE);
}

/**
 * Read the last sweep's attestation. Returns null when no sweep has ever run or
 * the record is unreadable/corrupt -- callers must treat null as "the mirror is
 * unverified", never as "the mirror is clean". A missing record is precisely
 * the state the host was in during the incident.
 */
export function readPrTerminalReconcileState(rootDir) {
  try {
    const parsed = JSON.parse(readFileSync(reconcileStatePath(rootDir), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writePrTerminalReconcileState(rootDir, summary) {
  const path = reconcileStatePath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...summary }, null, 2)}\n`);
  return path;
}

function normalizePrState(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'merged' || normalized === 'closed' || normalized === 'open') return normalized;
  return null;
}

/**
 * Classify a live GitHub PR payload into a terminal transition.
 *
 * `mergedAt` is checked before `state` on purpose: GitHub reports a merged PR
 * as `state: 'CLOSED'` on some REST shapes and `'MERGED'` on GraphQL, and
 * mis-filing a merge as a close would lose the merge closeout work. A non-null
 * `mergedAt` is unambiguous, so it wins.
 *
 * @returns {'merged'|'closed'|null} null means "open, or not enough information".
 */
export function classifyTerminalTransition(live) {
  if (!live) return null;
  if (live.mergedAt) return 'merged';
  const state = normalizePrState(live.state ?? live.prState);
  if (state === 'merged') return 'merged';
  if (state === 'closed') return 'closed';
  return null;
}

function describeError(error) {
  const message = String(error?.message || error || 'unknown error');
  // Live `gh` failures arrive with the whole GraphQL document inlined, which is
  // several hundred lines of noise in a record an operator has to read. Keep
  // the first line -- that is where `gh: Bad credentials (HTTP 401)` and the
  // rate-limit and timeout messages actually live -- and bound the rest.
  const firstLine = message.split('\n').map((line) => line.trim()).filter(Boolean);
  const head = firstLine[0] || 'unknown error';
  const tail = firstLine.slice(1).find((line) => /HTTP \d{3}|Bad credentials|rate limit|timed out|timeout/i.test(line));
  return (tail ? `${head} — ${tail}` : head).slice(0, 300);
}

/**
 * Sweep a set of mirror rows against live GitHub state and write the terminal
 * fact for any PR that has since merged or closed.
 *
 * Every hook is injected so the sweep can be driven in a test without a
 * database, a network, or a clock.
 *
 * @param {Object} opts
 * @param {Array<{repo: string, pr_number: number}>} opts.rows open mirror rows.
 * @param {Function} opts.fetchLiveState async (repo, prNumber) => live payload.
 *   Throwing marks that PR unresolved; it does not abort the sweep.
 * @param {Function} [opts.onBeforeMark] async (ctx) => void. Queue durable owed
 *   work here. A throw SKIPS the mark for that PR so the row stays eligible for
 *   the next sweep -- this is what keeps owed closeout work from being dropped.
 * @param {Function} [opts.onAfterMark] async (ctx) => void. Best-effort remote
 *   reporting. A throw is recorded and logged but never rolls back the mark.
 * @param {Function} opts.markMerged (mergedAt, repo, prNumber) => void.
 * @param {Function} opts.markClosed (closedAt, repo, prNumber) => void.
 * @param {number} [opts.cap] max PRs to resolve in one sweep.
 * @returns {Promise<Object>} sweep summary, safe to persist verbatim.
 */
export async function reconcileTerminalPrState({
  rows = [],
  fetchLiveState,
  onBeforeMark = async () => {},
  onAfterMark = async () => {},
  markMerged,
  markClosed,
  now = () => new Date(),
  cap = Number.POSITIVE_INFINITY,
  logger = console,
  source = 'sweep',
} = {}) {
  if (typeof fetchLiveState !== 'function') {
    throw new TypeError('reconcileTerminalPrState requires fetchLiveState');
  }
  if (typeof markMerged !== 'function' || typeof markClosed !== 'function') {
    throw new TypeError('reconcileTerminalPrState requires markMerged and markClosed');
  }

  const startedAt = now().toISOString();
  const summary = {
    source,
    observedAt: startedAt,
    checked: 0,
    merged: 0,
    closed: 0,
    stillOpen: 0,
    skippedOverCap: 0,
    deferredCount: 0,
    reportFailureCount: 0,
    unresolvedCount: 0,
    // Named PRs, not just counts: an operator triaging a phantom alert needs to
    // know WHICH rows are unverified, because those are exactly the rows whose
    // queue_starvation / terminal_but_unmerged findings cannot be trusted.
    unresolved: [],
    deferred: [],
    reportFailures: [],
  };

  for (const row of rows) {
    const repo = row?.repo;
    const prNumber = row?.pr_number ?? row?.prNumber;
    if (!repo || !Number.isFinite(Number(prNumber))) continue;

    if (summary.checked >= cap) {
      summary.skippedOverCap += 1;
      continue;
    }
    summary.checked += 1;

    let live;
    try {
      live = await fetchLiveState(repo, prNumber);
    } catch (error) {
      // The single most important line in this module. The pre-TREC-01 code
      // `continue`d here without recording anything, so a fleet-wide auth
      // outage was indistinguishable from "every PR is genuinely still open".
      summary.unresolved.push({ repo, prNumber: Number(prNumber), reason: describeError(error) });
      continue;
    }

    const transition = classifyTerminalTransition(live);
    if (!transition) {
      summary.stillOpen += 1;
      continue;
    }

    const ctx = { repo, prNumber: Number(prNumber), transition, live, row };

    try {
      await onBeforeMark(ctx);
    } catch (error) {
      // Owed work did not persist. Leave the row open so the next sweep retries
      // the whole transition; marking now would drop the closeout permanently
      // because the row would no longer appear in the open list.
      summary.deferred.push({
        repo,
        prNumber: Number(prNumber),
        transition,
        reason: describeError(error),
      });
      continue;
    }

    if (transition === 'merged') {
      markMerged(live.mergedAt || now().toISOString(), repo, prNumber);
      summary.merged += 1;
    } else {
      markClosed(live.closedAt || now().toISOString(), repo, prNumber);
      summary.closed += 1;
    }

    try {
      await onAfterMark(ctx);
    } catch (error) {
      // The terminal fact is already durable. A reporting failure is worth
      // surfacing but must not resurrect the row into the alerting population.
      summary.reportFailures.push({
        repo,
        prNumber: Number(prNumber),
        transition,
        reason: describeError(error),
      });
      logger.error?.(
        `[watcher] ${repo}#${prNumber} recorded ${transition}; downstream reporting failed: `
        + `${describeError(error)}`
      );
    }
  }

  summary.unresolvedCount = summary.unresolved.length;
  summary.deferredCount = summary.deferred.length;
  summary.reportFailureCount = summary.reportFailures.length;
  summary.completedAt = now().toISOString();
  return summary;
}

/**
 * Is the mirror's terminal state verified against GitHub right now?
 *
 * `blind` is deliberately true when the record is MISSING. A surface that has
 * never reconciled has not established that its population is real, and the
 * incident this module exists for looked exactly like that.
 */
export function evaluateReconcileFreshness(state, { nowMs, staleAfterMs = DEFAULT_RECONCILE_STALE_AFTER_MS } = {}) {
  if (!state) {
    return {
      present: false,
      blind: true,
      reason: 'no-reconcile-record',
      observedAt: null,
      ageMs: null,
      staleAfterMs,
      unresolvedCount: 0,
      unresolved: [],
    };
  }
  const observedAt = state.completedAt || state.observedAt || null;
  const observedMs = observedAt ? Date.parse(observedAt) : NaN;
  const ageMs = Number.isFinite(observedMs) && Number.isFinite(nowMs)
    ? Math.max(0, nowMs - observedMs)
    : null;
  const stale = ageMs === null || ageMs > staleAfterMs;
  const unresolved = Array.isArray(state.unresolved) ? state.unresolved : [];
  return {
    present: true,
    blind: stale || unresolved.length > 0,
    reason: stale ? 'reconcile-record-stale' : (unresolved.length > 0 ? 'live-state-unresolved' : null),
    observedAt,
    ageMs,
    staleAfterMs,
    unresolvedCount: unresolved.length,
    unresolved,
    checked: Number(state.checked || 0),
    merged: Number(state.merged || 0),
    closed: Number(state.closed || 0),
    deferredCount: Number(state.deferredCount || 0),
  };
}

/**
 * Is a specific PR one the last sweep could not verify?
 *
 * The health surface uses this to stamp each alert payload, which is what lets
 * an operator tell a phantom from a real finding without hand-checking every PR
 * on GitHub.
 */
export function isPrUnverified(freshness, repo, prNumber) {
  if (!freshness) return true;
  if (!freshness.present) return true;
  if (freshness.blind && freshness.reason === 'reconcile-record-stale') return true;
  const target = Number(prNumber);
  return (freshness.unresolved || []).some(
    (entry) => entry.repo === repo && Number(entry.prNumber) === target
  );
}

export default {
  DEFAULT_RECONCILE_STALE_AFTER_MS,
  classifyTerminalTransition,
  evaluateReconcileFreshness,
  isPrUnverified,
  readPrTerminalReconcileState,
  reconcileStatePath,
  reconcileTerminalPrState,
  writePrTerminalReconcileState,
};
