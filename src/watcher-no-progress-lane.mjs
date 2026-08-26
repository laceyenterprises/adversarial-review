// No-progress lane — a bounded, per-(repo, pr, head) backoff for PRs the poll
// loop re-walks every tick without ever advancing them.
//
// Why this exists (WPS-01, confirmed incident: agent-os#5915 got NO first review
// for 30+ minutes):
//   Three PRs (#5908/#5909/#5911) sat in `posted` with a `stale-review-head`
//   gate. Every tick, each one ran its full posted-review handler: gate
//   projection → AMA closer eligibility → auto-hammer terminal remediation →
//   "retained ownership". Every component was CORRECT — the hammer was right
//   that they needed remediation, right to refuse merging over a blocking
//   verdict, and `closer-commit-identity` was right to suppress a re-review.
//   The composition made the tick unbounded, so the NEXT tick's discovery never
//   ran, and a brand-new PR was never even seen: zero watcher log lines, zero
//   `reviews.db` rows. 72 of the last 400 log lines belonged to those three PRs;
//   0 belonged to the PR waiting for a first look.
//
// This module is the "stop re-walking what cannot move" half of the fix. It is a
// deliberate extension of the idea already proven in `ama-retain-loop-cap.mjs`:
// a per-head ledger that counts consecutive no-progress ticks and resets on a
// new head. The difference is the consequence. The retain cap ESCALATES to
// `AWAIT_OPERATOR_ACTION` for one specific AMA reason (`not-eligible`); this lane
// is reason-agnostic and DEMOTES — after K consecutive ticks that produced no
// observable state change, the PR is walked on an exponentially-spaced schedule
// instead of every tick, freeing the loop for PRs that can still move.
//
// Three properties this deliberately preserves:
//
//   1. Nothing is weakened. The lane never changes what a handler decides, only
//      how often it is asked. The auto-hammer eligibility decision, the
//      blocking-findings hard stop, and `closer-commit-identity` auto-refresh
//      suppression all still run, verbatim, whenever the PR is due.
//   2. Nothing is dropped. The backoff is capped at `maxBackoffTicks`, so a
//      demoted PR is still re-walked on a bounded cadence forever. There is no
//      terminal "give up" state, and every skip writes an operator-visible log
//      line plus a ledger file under `data/watcher-no-progress-lane/`.
//   3. Progress always wins. Any observable change — a new head, a status
//      transition, a new attempt, a merge — resets the series to `active`
//      immediately, so a PR that starts moving is never held back a single tick.
//
// "Progress" is measured by fingerprint, not by asking the handler. A handler
// that returns cleanly having decided "retain ownership, nothing to do" is
// indistinguishable at the call site from one that dispatched real work; only
// the resulting review-state row tells the truth. `subjectProgressFingerprint`
// is that truth: if it is byte-identical to the previous tick's, the tick did
// nothing for this PR.

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';

// Consecutive no-progress ticks tolerated before a PR is demoted to the slow
// lane. Matches `AMA_RETAIN_LOOP_CAP`'s default of 3 on purpose: both answer the
// same question ("how many identical ticks before we accept this is not moving
// on its own?") and an operator reading two different numbers for the same
// judgement would reasonably assume one of them was wrong.
export const DEFAULT_NO_PROGRESS_LANE_CAP = 3;

// Ceiling on the backoff, in ticks. At the production 5m poll interval, 12 ticks
// is one hour — the longest a genuinely-wedged PR can go unlooked-at. The cap is
// what makes this a LANE and not a drop: growth is exponential but bounded, so
// the PR is guaranteed to be re-walked at least hourly no matter how long it has
// been stuck.
export const DEFAULT_NO_PROGRESS_MAX_BACKOFF_TICKS = 12;

const NO_PROGRESS_LANE_SCHEMA_VERSION = 1;

export const LANE_ACTIVE = 'active';
export const LANE_SLOW = 'slow';

function noProgressLaneDir(rootDir) {
  return join(rootDir, 'data', 'watcher-no-progress-lane');
}

function sanitizePathSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

export function noProgressLaneFilePath(rootDir, { repo, prNumber } = {}) {
  const safeRepo = sanitizePathSegment(String(repo ?? '').replace(/\//g, '__'));
  // Keyed on (repo, pr); the head lives INSIDE the doc so a new head resets the
  // series without leaking one file per head — same shape as
  // `amaRetainLoopCapFilePath`.
  return join(noProgressLaneDir(rootDir), `${safeRepo}-pr-${Number(prNumber)}.json`);
}

function normalizeHead(value) {
  const str = String(value ?? '').trim();
  return str.length ? str : null;
}

function normalizeCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function positiveIntOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

/**
 * Stable, order-independent fingerprint of everything about a review subject that
 * a productive tick could plausibly change. Two ticks producing the same
 * fingerprint made no observable progress on this PR.
 *
 * Deliberately narrow: only fields the watcher itself advances. It does NOT
 * include `labels_json` or `updated_at` — a label churned by an external actor
 * (or a timestamp that ticks on its own) would otherwise read as watcher
 * progress and keep an unadvanceable PR pinned in the active lane forever, which
 * is the exact failure this module exists to end.
 */
export function subjectProgressFingerprint(row, { headSha = null } = {}) {
  return JSON.stringify({
    head: normalizeHead(headSha),
    status: row?.review_status ?? null,
    prState: row?.pr_state ?? null,
    reviewerHead: row?.reviewer_head_sha ?? null,
    attempts: normalizeCount(row?.review_attempts),
    postedAt: row?.posted_at ?? null,
    failedAt: row?.failed_at ?? null,
    mergedAt: row?.merged_at ?? null,
  });
}

export function readNoProgressLane(rootDir, identity, { logger = console } = {}) {
  const filePath = noProgressLaneFilePath(rootDir, identity);
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    // An absent ledger is the expected first-tick path. Any OTHER read error is
    // also treated as a fresh series: this lane only DEFERS work, so failing
    // toward "not yet demoted" costs at most one extra full-speed tick and can
    // never suppress a PR that should have been walked.
    if (err && err.code === 'ENOENT') return null;
    logger?.warn?.(
      `[watcher] no-progress lane: failed to read ledger ${filePath} ` +
        `(${err?.code || err?.message || 'unknown'}); treating as a fresh series`,
    );
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    logger?.warn?.(
      `[watcher] no-progress lane: ledger ${filePath} is corrupt ` +
        `(${err?.message || 'parse error'}); treating as a fresh series`,
    );
    return null;
  }
}

function writeLedger(rootDir, identity, doc) {
  mkdirSync(noProgressLaneDir(rootDir), { recursive: true });
  writeFileAtomic(noProgressLaneFilePath(rootDir, identity), `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

/**
 * Backoff spacing for a demoted PR, in ticks. Doubles per no-progress tick past
 * the cap and saturates at `maxBackoffTicks`, so the schedule is
 * 1, 2, 4, 8, … capped — never unbounded, never zero.
 */
export function backoffTicksFor(noProgressTicks, {
  cap = DEFAULT_NO_PROGRESS_LANE_CAP,
  maxBackoffTicks = DEFAULT_NO_PROGRESS_MAX_BACKOFF_TICKS,
} = {}) {
  const over = normalizeCount(noProgressTicks) - positiveIntOr(cap, DEFAULT_NO_PROGRESS_LANE_CAP);
  if (over <= 0) return 0;
  const ceiling = positiveIntOr(maxBackoffTicks, DEFAULT_NO_PROGRESS_MAX_BACKOFF_TICKS);
  // 2**over grows fast; clamp the exponent too so a long-lived ledger can never
  // overflow into Infinity before Math.min sees it.
  const exponent = Math.min(over, 30);
  return Math.min(ceiling, 2 ** (exponent - 1));
}

/**
 * Pure decision: given a ledger doc and the PR's CURRENT head, is this PR due to
 * be walked this tick?
 *
 * A head change always returns due — a new head is new evidence, and holding it
 * back would turn this lane into the very stall it prevents.
 *
 * @returns {{ lane:string, due:boolean, noProgressTicks:number, skippedTicks:number,
 *             backoffTicks:number, headSha:(string|null), reason:string }}
 */
export function evaluateNoProgressLane(ledger, {
  headSha = null,
  cap = DEFAULT_NO_PROGRESS_LANE_CAP,
  maxBackoffTicks = DEFAULT_NO_PROGRESS_MAX_BACKOFF_TICKS,
} = {}) {
  const head = normalizeHead(headSha);
  const ledgerHead = normalizeHead(ledger?.headSha);
  const base = {
    lane: LANE_ACTIVE,
    due: true,
    noProgressTicks: 0,
    skippedTicks: 0,
    backoffTicks: 0,
    headSha: head,
  };
  if (!ledger) return { ...base, reason: 'no-ledger' };
  if (!head || ledgerHead === null || ledgerHead !== head) {
    return { ...base, reason: 'head-changed' };
  }
  const noProgressTicks = normalizeCount(ledger.noProgressTicks);
  const backoffTicks = backoffTicksFor(noProgressTicks, { cap, maxBackoffTicks });
  if (backoffTicks <= 0) {
    return { ...base, noProgressTicks, reason: 'under-cap' };
  }
  const skippedTicks = normalizeCount(ledger.skippedTicks);
  const due = skippedTicks >= backoffTicks;
  return {
    lane: LANE_SLOW,
    due,
    noProgressTicks,
    skippedTicks,
    backoffTicks,
    headSha: head,
    reason: due ? 'slow-lane-due' : 'slow-lane-backoff',
  };
}

/**
 * Record that a demoted PR was skipped this tick. Bumps only the skip counter, so
 * the PR walks closer to being due rather than further from it.
 */
export function recordNoProgressLaneSkip(rootDir, identity, {
  headSha,
  now = null,
  logger = console,
} = {}) {
  const head = normalizeHead(headSha);
  const existing = readNoProgressLane(rootDir, identity, { logger });
  if (!existing || normalizeHead(existing.headSha) !== head) {
    // Skipping is only ever decided from a matching-head ledger; a mismatch here
    // means the head moved between evaluate and record. Do nothing rather than
    // fabricate a series against the new head.
    return { skippedTicks: 0, headSha: head };
  }
  const skippedTicks = normalizeCount(existing.skippedTicks) + 1;
  writeLedger(rootDir, identity, {
    ...existing,
    schemaVersion: NO_PROGRESS_LANE_SCHEMA_VERSION,
    skippedTicks,
    updatedAt: now || existing.updatedAt || null,
  });
  return { skippedTicks, headSha: head };
}

/**
 * Record the outcome of actually walking this PR. `fingerprint` is the
 * post-walk `subjectProgressFingerprint`; comparing it with the previous tick's
 * is what decides progress.
 *
 * @returns {{ lane:string, progressed:boolean, noProgressTicks:number,
 *             backoffTicks:number, demoted:boolean, headSha:(string|null) }}
 */
export function recordNoProgressLaneRun(rootDir, identity, {
  headSha,
  fingerprint,
  cap = DEFAULT_NO_PROGRESS_LANE_CAP,
  maxBackoffTicks = DEFAULT_NO_PROGRESS_MAX_BACKOFF_TICKS,
  now = null,
  logger = console,
} = {}) {
  const head = normalizeHead(headSha);
  // No head to key on → no series is possible, so record nothing rather than
  // writing a ledger that can never match a later tick. `evaluateNoProgressLane`
  // already returns `due` for a headless subject, so this fails open by
  // construction: an unknown head is walked at full speed, every tick.
  if (head === null) return null;
  const existing = readNoProgressLane(rootDir, identity, { logger });
  const sameHead = normalizeHead(existing?.headSha) === head;
  const sameFingerprint = sameHead
    && typeof existing?.fingerprint === 'string'
    && existing.fingerprint === fingerprint;
  const priorNoProgress = sameHead ? normalizeCount(existing?.noProgressTicks) : 0;
  const noProgressTicks = sameFingerprint ? priorNoProgress + 1 : 0;
  const backoffTicks = backoffTicksFor(noProgressTicks, { cap, maxBackoffTicks });
  const lane = backoffTicks > 0 ? LANE_SLOW : LANE_ACTIVE;
  const priorLane = sameHead ? (existing?.lane || LANE_ACTIVE) : LANE_ACTIVE;
  writeLedger(rootDir, identity, {
    schemaVersion: NO_PROGRESS_LANE_SCHEMA_VERSION,
    repo: identity?.repo ?? null,
    prNumber: Number(identity?.prNumber),
    headSha: head,
    fingerprint: typeof fingerprint === 'string' ? fingerprint : null,
    noProgressTicks,
    // A walked PR starts its next backoff window from zero regardless of outcome.
    skippedTicks: 0,
    lane,
    firstNoProgressAt: (sameFingerprint ? existing?.firstNoProgressAt : null) || (noProgressTicks > 0 ? now : null) || null,
    updatedAt: now || null,
  });
  return {
    lane,
    progressed: !sameFingerprint,
    noProgressTicks,
    backoffTicks,
    demoted: lane === LANE_SLOW && priorLane !== LANE_SLOW,
    headSha: head,
  };
}
