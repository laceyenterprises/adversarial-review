// CIDEDUPE-01 — no silent refusal between the AMA closer and the merge daemon.
//
// The watcher runs the daemon clean-merge first. When the daemon returns
// `not-taken`, the tick falls through to the AMA closer; when the closer's own
// eligibility passes it answers `daemon-clean-route` ("the daemon owns this PR")
// and dispatches nothing. If the daemon keeps declining the same head, nothing
// acts: agent-os#7314 (SEV3 2026-09-28) sat STALLED that way, with no log line
// naming the daemon's reason, because the two sides read CI with different
// predicates. They now share one predicate; this module is the backstop for any
// disagreement that remains.
//
// Every closer `daemon-clean-route` answer that follows a daemon `not-taken` on
// the same tick is one disagreement. Each one is logged with the daemon's reason
// and counted per (repo, PR, head); a new head restarts the count. Once the count
// passes the bound, the caller either hands the PR to the capped hammer
// (`forceHammerAfterDaemonFailure`) when the daemon's gates are hammer-remediable,
// or parks it with an operator-visible alert. The hammer route stays behind the
// closer's own per-PR retry cap, and the park is re-evaluated every tick, so a
// daemon merge on a later tick still lands the PR.
//
// A decline made only of transient GitHub reads (mergeability UNKNOWN, labels
// unreadable) is logged but never counted (DIRTYOWN-01): it says nothing about
// the head, so it must not walk a PR toward the park/page escalation.

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';

// Disagreements tolerated on one head before escalating. A single tick can
// disagree for benign reasons (the closer reads the watcher's candidate
// snapshot, the daemon a fresh live rollup), so the first few are only logged.
// Same K as the AMA retain-loop cap: the (K+1)th observation escalates.
export const DAEMON_ROUTE_DISAGREEMENT_BOUND = 3;
export const DAEMON_ROUTE_DISAGREEMENT_REASON = 'daemon-route-disagreement';

const SCHEMA_VERSION = 1;

function ledgerDir(rootDir) {
  return join(rootDir, 'data', 'follow-up-jobs', 'daemon-route-disagreement');
}

function sanitizePathSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

export function daemonRouteDisagreementFilePath(rootDir, { repo, prNumber } = {}) {
  const safeRepo = sanitizePathSegment(String(repo ?? '').replace(/\//g, '__'));
  // Keyed per PR; the head lives inside the doc so a new head resets the count
  // without leaving one file per head behind.
  return join(ledgerDir(rootDir), `${safeRepo}-pr-${Number(prNumber)}.json`);
}

function normalizeHead(value) {
  const str = String(value ?? '').trim();
  return str.length ? str : null;
}

function readLedger(rootDir, identity, logger) {
  const filePath = daemonRouteDisagreementFilePath(rootDir, identity);
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    // Absent is the normal first observation. Anything else restarts the
    // series: this ledger only escalates, so reading low costs at most a few
    // more logged ticks, never a merge.
    if (err?.code !== 'ENOENT') {
      logger?.warn?.(
        `[daemon-route-disagreement] unreadable ledger ${filePath} ` +
          `(${err?.code || err?.message || 'unknown'}); treating as a fresh series`,
      );
    }
    return null;
  }
}

/**
 * The daemon's decline, reduced to the fields the log and alert carry.
 */
export function daemonDeclineSummary(daemonCleanMerge) {
  return {
    daemonDisposition: daemonCleanMerge?.disposition || null,
    daemonReason: String(daemonCleanMerge?.reason || 'daemon-result-missing'),
    daemonReasons: Array.isArray(daemonCleanMerge?.reasons) ? daemonCleanMerge.reasons.map(String) : [],
  };
}

/**
 * How many disagreements are already on record for `headSha`.
 *
 * @returns {{ count:number, bound:number, boundReached:boolean, headSha:(string|null) }}
 */
export function readDaemonRouteDisagreement(rootDir, identity, {
  headSha,
  bound = DAEMON_ROUTE_DISAGREEMENT_BOUND,
  logger = console,
} = {}) {
  const head = normalizeHead(headSha);
  const ledger = head && rootDir ? readLedger(rootDir, identity, logger) : null;
  const count = ledger && normalizeHead(ledger.headSha) === head
    ? Math.max(0, Number(ledger.count || 0))
    : 0;
  return { count, bound, boundReached: count >= bound, headSha: head };
}

/**
 * Record one disagreement on `headSha` and report whether it is past the bound.
 * Persistence is best-effort: a write failure is logged and the count still
 * returned, so the observation is never silent.
 *
 * @returns {{ count:number, bound:number, escalate:boolean, headSha:(string|null) }}
 */
export function recordDaemonRouteDisagreement(rootDir, identity, {
  headSha,
  daemonCleanMerge = null,
  bound = DAEMON_ROUTE_DISAGREEMENT_BOUND,
  now = new Date().toISOString(),
  logger = console,
} = {}) {
  const head = normalizeHead(headSha);
  const existing = head && rootDir ? readLedger(rootDir, identity, logger) : null;
  const sameHead = Boolean(existing) && normalizeHead(existing.headSha) === head;
  const count = (sameHead ? Math.max(0, Number(existing.count || 0)) : 0) + 1;
  if (head && rootDir) {
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      repo: identity.repo,
      prNumber: Number(identity.prNumber),
      headSha: head,
      count,
      firstObservedAt: (sameHead && existing.firstObservedAt) || now,
      lastObservedAt: now,
      ...daemonDeclineSummary(daemonCleanMerge),
    };
    try {
      mkdirSync(ledgerDir(rootDir), { recursive: true });
      writeFileAtomic(daemonRouteDisagreementFilePath(rootDir, identity), `${JSON.stringify(doc, null, 2)}\n`);
    } catch (err) {
      logger?.warn?.(
        `[daemon-route-disagreement] ledger write failed for ${identity.repo}#${identity.prNumber}: ` +
          `${err?.message || err}`,
      );
    }
  }
  // No head to key on → the series cannot be bounded; keep logging, never escalate.
  return { count, bound, escalate: Boolean(head) && count > bound, headSha: head };
}

export function clearDaemonRouteDisagreement(rootDir, identity) {
  if (!rootDir) return false;
  try {
    rmSync(daemonRouteDisagreementFilePath(rootDir, identity), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pre-closer read: should this tick's closer call skip `daemon-clean-route` and
 * dispatch the capped hammer? True only when the daemon declined again on a
 * head that has already used up its tolerated disagreements, and the caller
 * judged the daemon's gates hammer-remediable.
 */
export function daemonRouteDisagreementForcesHammer({
  rootDir,
  repo,
  prNumber,
  headSha,
  daemonCleanMerge,
  hammerRemediable,
  bound = DAEMON_ROUTE_DISAGREEMENT_BOUND,
  logger = console,
} = {}) {
  if (!hammerRemediable) return false;
  const prior = readDaemonRouteDisagreement(rootDir, { repo, prNumber }, { headSha, bound, logger });
  if (!prior.boundReached) return false;
  const decline = daemonDeclineSummary(daemonCleanMerge);
  logger?.log?.(JSON.stringify({
    schemaVersion: 1,
    event: 'ama.daemon_route_disagreement.hammer_fallback',
    repo,
    pr: prNumber,
    headSha: prior.headSha,
    disagreements: prior.count,
    bound,
    ...decline,
    hammerFallback: true,
  }));
  logger?.warn?.(
    `[watcher] AMA closer/daemon route disagreement for ${repo}#${prNumber}` +
      `@${String(prior.headSha || '').slice(0, 12)} hit the bound (${prior.count}/${bound}); ` +
      `daemon still ${decline.daemonDisposition || 'unknown'} (${decline.daemonReason}` +
      (decline.daemonReasons.length ? `; gates=${decline.daemonReasons.join(',')}` : '') +
      `) — forcing the capped hammer instead of re-selecting the daemon route`,
  );
  return true;
}

/**
 * Post-closer: the closer answered `daemon-clean-route` although the daemon
 * declined this tick. Log it, count it, and past the bound either note the
 * pending hammer fallback or return the operator-visible park result.
 *
 * @returns {{ count:number, bound:number, escalate:boolean, parkResult:(object|null) }}
 */
export function observeDaemonRouteDisagreement({
  rootDir,
  repo,
  prNumber,
  headSha,
  daemonCleanMerge,
  hammerRemediable,
  transientRead = false,
  bound = DAEMON_ROUTE_DISAGREEMENT_BOUND,
  recordParkImpl = null,
  now = new Date().toISOString(),
  logger = console,
} = {}) {
  const decline = daemonDeclineSummary(daemonCleanMerge);
  if (transientRead) {
    // DIRTYOWN-01: the daemon declined only on a still-settling GitHub read
    // (mergeability UNKNOWN, labels unreadable). That says nothing about the
    // head, so log it but never count it: repeated transient reads under a
    // moving base must not reach the park/page escalation.
    const prior = readDaemonRouteDisagreement(rootDir, { repo, prNumber }, { headSha, bound, logger });
    logger?.log?.(JSON.stringify({
      schemaVersion: 1,
      event: 'ama.daemon_route_disagreement',
      repo,
      pr: prNumber,
      headSha: prior.headSha,
      disagreements: prior.count,
      bound,
      ...decline,
      hammerRemediable: false,
      transientRead: true,
      escalation: null,
    }));
    logger?.warn?.(
      `[watcher] AMA closer routed ${repo}#${prNumber}@${String(prior.headSha || headSha || 'unknown').slice(0, 12)} ` +
        `to the daemon (daemon-clean-route) but the daemon declined on a transient GitHub read: ` +
        `${decline.daemonDisposition || 'no-result'} ${decline.daemonReason}` +
        (decline.daemonReasons.length ? `; gates=${decline.daemonReasons.join(',')}` : '') +
        ' — not counted; the next tick re-reads',
    );
    return { count: prior.count, bound, escalate: false, headSha: prior.headSha, transientRead: true, parkResult: null };
  }
  const recorded = recordDaemonRouteDisagreement(rootDir, { repo, prNumber }, {
    headSha,
    daemonCleanMerge,
    bound,
    now,
    logger,
  });
  const headShort = String(recorded.headSha || headSha || 'unknown').slice(0, 12);
  const gates = decline.daemonReasons.length ? `; gates=${decline.daemonReasons.join(',')}` : '';
  const park = recorded.escalate && !hammerRemediable;
  logger?.log?.(JSON.stringify({
    schemaVersion: 1,
    event: 'ama.daemon_route_disagreement',
    repo,
    pr: prNumber,
    headSha: recorded.headSha,
    disagreements: recorded.count,
    bound,
    ...decline,
    hammerRemediable: Boolean(hammerRemediable),
    escalation: !recorded.escalate ? null : park ? 'park' : 'hammer',
  }));
  logger?.warn?.(
    `[watcher] AMA closer routed ${repo}#${prNumber}@${headShort} to the daemon ` +
      `(daemon-clean-route) but the daemon declined: ${decline.daemonDisposition || 'no-result'} ` +
      `${decline.daemonReason}${gates} (disagreement ${recorded.count}/${bound} on this head)` +
      (!recorded.escalate
        ? ''
        : park
          ? ' — not hammer-remediable; parking for the operator'
          : ' — the next closer call forces the capped hammer'),
  );
  if (!park) return { ...recorded, parkResult: null };

  if (typeof recordParkImpl === 'function') {
    try {
      recordParkImpl({ rootDir, repo, prNumber, headSha: recorded.headSha, reason: DAEMON_ROUTE_DISAGREEMENT_REASON });
    } catch {
      // Diagnostics only; the alert below still fires.
    }
  }
  // Same pageable event the daemon clean-park path already emits, so the
  // superproject observability layer alerts on it without new wiring. Paged
  // once per head; later ticks keep the disagreement log line and park record.
  if (recorded.count === bound + 1) {
    logger?.log?.(JSON.stringify({
      schemaVersion: 1,
      event: 'ama.daemon_clean_park.manual_close_required',
      repo,
      pr: prNumber,
      headSha: recorded.headSha,
      reason: DAEMON_ROUTE_DISAGREEMENT_REASON,
      reasons: decline.daemonReasons.length ? decline.daemonReasons : [decline.daemonReason],
      ...decline,
      disagreements: recorded.count,
      hammerFallback: false,
    }));
  }
  return {
    ...recorded,
    parkResult: {
      dispatched: false,
      skipMergeAgent: true,
      needsOperator: true,
      reason: DAEMON_ROUTE_DISAGREEMENT_REASON,
      operatorReason: `${DAEMON_ROUTE_DISAGREEMENT_REASON}:${decline.daemonReasons[0] || decline.daemonReason}`,
      reasons: decline.daemonReasons,
      routeDisagreement: {
        count: recorded.count,
        bound,
        headSha: recorded.headSha,
        ...decline,
      },
    },
  };
}
