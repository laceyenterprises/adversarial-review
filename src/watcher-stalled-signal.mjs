// Stalled ≠ idle — CLZ-03.
//
// The no-progress lane (`watcher-no-progress-lane.mjs`) is correct about PACING:
// after K consecutive ticks that changed nothing it walks a subject on an
// exponentially-spaced, bounded schedule instead of every tick. What it was
// wrong about is what it SAYS. Every deferral tick emitted
//
//   [watcher] no-progress lane: deferring laceyenterprises/agent-os#6059 this tick
//             (lane=slow no_progress_ticks=15 backoff_ticks=12) — still tracked,
//             re-walked in 12 tick(s)
//
// which is byte-for-byte the line a healthy, quiet, nobody-has-pushed-in-an-hour
// PR emits. agent-os#6059 sat 12.7 hours behind exactly that line. The true
// statement was available the whole time and never said:
//
//   needs a settled verdict at head a111abc7f, and NO PRODUCER EXISTS for one,
//   because auto-refresh is suppressed for that head (closer-commit-trailer).
//
// That is the difference between "nothing is happening" and "nothing CAN
// happen". This module derives and emits the second statement.
//
// Three properties held deliberately:
//
//   1. The backoff is untouched. Nothing here changes `noProgressTicks`,
//      `skippedTicks`, `backoffTicksFor`, or the demotion rules. This module only
//      READS the counters the lane already keeps.
//   2. `stalled` is a distinct SIGNAL, not a severity bump. It is written to the
//      watcher log and to a JSONL event stream under `data/watcher-stalled-events/`.
//      It is deliberately NOT wired to `deliverAlert` (the paging bus): deciding
//      where a stall routes is a separate call, and a blanket page on every slow
//      PR is the storm risk this signal exists to avoid.
//   3. One event per stall. The stall's identity is (repo, pr, head, fingerprint)
//      — the exact key the lane's series is reset by — so a debounce marker on
//      that key means a re-emit is impossible until something actually changes,
//      and guaranteed once something does.
//
// Producer existence is reported as `yes | no | unknown`, and `unknown` is never
// reported as `yes`. Claiming "no producer exists" is the strong, actionable
// half of the signal; it is only claimed where the absence is derivable from
// state the watcher owns (a suppressed auto-refresh, a final posted review with
// no remediation dispatched, an operator-only input). Where the producer lives
// outside the watcher's observation — CI, a human push — the honest answer is
// `unknown`, not a fabricated `no`.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const STALLED_SIGNAL_EVENT = 'adversarial_review.subject_stalled';

// K — consecutive walked ticks with zero state change before the subject is
// called stalled. Matches `DEFAULT_NO_PROGRESS_LANE_CAP` on purpose: that is the
// lane's own answer to "how many identical ticks before we accept this is not
// moving on its own?", and the signal should not disagree with the pacing
// decision it describes. Intentionally NOT imported from the lane module so the
// dependency runs one way only (the lane imports this module's cleanup helper).
export const DEFAULT_STALLED_SIGNAL_TICKS = 3;

export const PRODUCER_YES = 'yes';
export const PRODUCER_NO = 'no';
export const PRODUCER_UNKNOWN = 'unknown';

// Producer classes. Which actor, if any, could produce the missing input.
const PRODUCER_KIND_REVIEWER = 'reviewer';
const PRODUCER_KIND_REMEDIATION = 'remediation';
const PRODUCER_KIND_EXTERNAL_CI = 'external-ci';
const PRODUCER_KIND_AUTHOR = 'author';
const PRODUCER_KIND_OPERATOR = 'operator';
const PRODUCER_KIND_UNKNOWN = 'unknown';

/**
 * AMA eligibility reason → the specific input the subject is missing.
 *
 * Keyed on the reason strings `isEligibleForAmaClosure` actually pushes
 * (`src/ama/eligibility.mjs`). A reason absent from this table still produces a
 * named missing input carrying the raw reason — never a generic "blocked"
 * label, which is the failure mode this whole ticket exists to end.
 */
const MISSING_INPUT_BY_AMA_REASON = new Map([
  ['verdict-not-settled-success', {
    input: 'settled-verdict',
    describe: (head) => `a settled verdict at head ${head}`,
    producerKind: PRODUCER_KIND_REVIEWER,
  }],
  ['blocking-findings-unknown', {
    input: 'blocking-findings-classification',
    describe: (head) => `a readable blocking-findings classification at head ${head}`,
    producerKind: PRODUCER_KIND_REVIEWER,
  }],
  ['non-blocking-findings-unknown', {
    input: 'non-blocking-findings-classification',
    describe: (head) => `a readable non-blocking-findings classification at head ${head}`,
    producerKind: PRODUCER_KIND_REVIEWER,
  }],
  ['remediation-state-unknown', {
    input: 'remediation-state',
    describe: (head) => `a readable remediation state at head ${head}`,
    producerKind: PRODUCER_KIND_REVIEWER,
  }],
  ['stale-review-head', {
    input: 'review-at-current-head',
    describe: (head) => `a review of head ${head} (the posted review is on an older head)`,
    producerKind: PRODUCER_KIND_REVIEWER,
  }],
  ['blocking-findings-present', {
    input: 'blocking-finding-remediation',
    describe: (head) => `remediation of the standing blocking findings at head ${head}`,
    producerKind: PRODUCER_KIND_REMEDIATION,
  }],
  ['non-blocking-findings-present', {
    input: 'non-blocking-finding-remediation',
    describe: (head) => `remediation of the standing non-blocking findings at head ${head}`,
    producerKind: PRODUCER_KIND_REMEDIATION,
  }],
  ['remediation-pending', {
    input: 'remediation-completion',
    describe: (head) => `completion of the remediation round open at head ${head}`,
    producerKind: PRODUCER_KIND_REMEDIATION,
  }],
  ['ci-not-green', {
    input: 'green-ci',
    describe: (head) => `a green CI rollup at head ${head}`,
    producerKind: PRODUCER_KIND_EXTERNAL_CI,
  }],
  ['pr-not-mergeable', {
    input: 'mergeable-pr',
    describe: () => 'a mergeable PR (GitHub reports it as not mergeable)',
    producerKind: PRODUCER_KIND_AUTHOR,
  }],
  ['pr-is-draft', {
    input: 'ready-for-review-pr',
    describe: () => 'the PR marked ready for review (it is a draft)',
    producerKind: PRODUCER_KIND_AUTHOR,
  }],
  ['branch-protection-missing-gate', {
    input: 'required-status-gate',
    describe: () => 'the configured required status gate on the branch protection rule',
    producerKind: PRODUCER_KIND_OPERATOR,
  }],
  ['risk-class-not-permitted', {
    input: 'operator-authorization',
    describe: () => "operator authorization for this risk class ('operator-approved' + 'adversarial-merge-requested')",
    producerKind: PRODUCER_KIND_OPERATOR,
  }],
  ['fast-merge-state-unsupported', {
    input: 'fast-merge-state-exit',
    describe: () => 'an exit from the fast-merge override state, which AMA fails closed on',
    producerKind: PRODUCER_KIND_OPERATOR,
  }],
  ['ama-disabled', {
    input: 'ama-enablement',
    describe: () => 'AMA enabled in config (it is currently disabled)',
    producerKind: PRODUCER_KIND_OPERATOR,
  }],
]);

// Which reason names the missing INPUT when several are standing at once.
// Verdict/finding-knowledge gates come first: they are the inputs the review
// pipeline itself owes the subject, and they are what #6059 was actually
// missing. Structural and operator-only gates come last — they are real, but
// they are consequences an operator reads after the pipeline gate is understood.
const AMA_REASON_PRIORITY = [
  'verdict-not-settled-success',
  'blocking-findings-unknown',
  'non-blocking-findings-unknown',
  'remediation-state-unknown',
  'stale-review-head',
  'blocking-findings-present',
  'non-blocking-findings-present',
  'remediation-pending',
  'ci-not-green',
  'pr-not-mergeable',
  'pr-is-draft',
  'branch-protection-missing-gate',
  'risk-class-not-permitted',
  'fast-merge-state-unsupported',
  'ama-disabled',
];

// Fallback when no AMA reasons reached the lane (the handler returned before
// eligibility ran, or returned an outcome that carries none). The review row's
// own status still names a specific input.
const MISSING_INPUT_BY_REVIEW_STATUS = new Map([
  ['pending', {
    input: 'first-review-pass',
    describe: (head) => `a first review pass at head ${head}`,
    producerKind: PRODUCER_KIND_REVIEWER,
  }],
  ['pending-upstream', {
    input: 'upstream-capacity',
    describe: () => 'upstream reviewer capacity (the row is parked in the cascade backoff)',
    producerKind: PRODUCER_KIND_REVIEWER,
  }],
  ['reviewing', {
    input: 'reviewer-completion',
    describe: (head) => `the in-flight reviewer pass at head ${head} to settle`,
    producerKind: PRODUCER_KIND_REVIEWER,
  }],
  ['posted', {
    input: 'settled-verdict',
    describe: (head) => `a settled verdict at head ${head}`,
    producerKind: PRODUCER_KIND_REVIEWER,
  }],
  ['failed', {
    input: 'reviewer-retry',
    describe: () => 'a reviewer retry (the last pass failed terminally)',
    producerKind: PRODUCER_KIND_REVIEWER,
  }],
  ['failed-orphan', {
    input: 'reviewer-reclaim',
    describe: () => 'a guarded reclaim of the orphaned reviewer claim, or an operator retrigger',
    producerKind: PRODUCER_KIND_OPERATOR,
  }],
  ['malformed-title', {
    input: 'worker-class-title-prefix',
    describe: () => 'a correctly-prefixed PR title; the row is terminal-by-design as malformed',
    producerKind: PRODUCER_KIND_AUTHOR,
  }],
]);

function shortHead(headSha) {
  const head = String(headSha ?? '').trim();
  return head ? head.slice(0, 12) : 'unknown';
}

function normalizeStatus(value) {
  return String(value ?? '').trim().toLowerCase() || null;
}

function normalizeTicks(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function positiveIntOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

export function resolveStalledSignalTicks(env = process.env) {
  return positiveIntOr(
    env?.ADVERSARIAL_WATCHER_STALLED_SIGNAL_TICKS,
    DEFAULT_STALLED_SIGNAL_TICKS,
  );
}

/**
 * Terminal subjects never stall — there is no missing input, because no further
 * transition is wanted. Derived from live-synced row state plus the handler's
 * own `prTerminal` finding (the dispatch-time live candidate read), so a merge
 * observed mid-tick suppresses the signal even before the row catches up.
 */
export function isTerminalSubject(reviewRow, handlerValue = null) {
  if (handlerValue?.prTerminal === true) return true;
  const prState = normalizeStatus(reviewRow?.pr_state);
  if (prState === 'merged' || prState === 'closed') return true;
  if (reviewRow?.merged_at) return true;
  const reviewStatus = normalizeStatus(reviewRow?.review_status);
  return reviewStatus === 'fast_merge_skipped';
}

/**
 * What the AMA hammer route is doing for this subject right now, read from the
 * posted-review handler's own return value. This is the producer-existence
 * answer for every remediation-shaped missing input.
 */
function classifyAmaDispatch(handlerValue) {
  const outcome = normalizeStatus(handlerValue?.outcome);
  if (outcome === 'ama-dispatched') {
    return { active: true, name: 'the AMA hammer dispatched this tick' };
  }
  if (outcome === 'ama-pending') {
    return { active: true, name: 'the AMA hammer route (dispatch pending, ownership retained)' };
  }
  return { active: false, name: null };
}

function producerFor(producerKind, {
  reviewRow,
  headSha,
  autoRefreshSuppression,
  amaDispatch,
}) {
  const status = normalizeStatus(reviewRow?.review_status);
  const reviewerHead = String(reviewRow?.reviewer_head_sha ?? '').trim() || null;
  const head = String(headSha ?? '').trim() || null;

  if (producerKind === PRODUCER_KIND_REVIEWER) {
    if (status === 'pending' || status === 'pending-upstream') {
      return {
        exists: PRODUCER_YES,
        name: 'the queued reviewer dispatch',
        detail: `the review row is '${status}'; the reviewer claim CAS can still pick it up`,
      };
    }
    if (status === 'reviewing') {
      return {
        exists: PRODUCER_YES,
        name: 'the in-flight reviewer pass',
        detail: "the review row holds a durable 'reviewing' claim",
      };
    }
    if (status === 'posted' && head && reviewerHead && reviewerHead !== head) {
      if (autoRefreshSuppression?.suppressed === true) {
        return {
          exists: PRODUCER_NO,
          name: null,
          detail:
            `auto-refresh is suppressed for this head (${autoRefreshSuppression.reason || 'reason unrecorded'}), ` +
            `so no re-review will be requested for ${shortHead(head)}`,
        };
      }
      return {
        exists: PRODUCER_YES,
        name: 'the stale-posted-review auto-refresh',
        detail: `the posted review is on ${shortHead(reviewerHead)}; auto-refresh re-arms review at ${shortHead(head)}`,
      };
    }
    if (status === 'posted') {
      if (amaDispatch?.active) {
        return {
          exists: PRODUCER_YES,
          name: amaDispatch.name,
          detail: 'a remediation/close route is live and can still change this verdict',
        };
      }
      return {
        exists: PRODUCER_NO,
        name: null,
        detail:
          `the review at head ${shortHead(head)} is already posted and final, and no remediation ` +
          'or close route is dispatched; nothing is scheduled to change it',
      };
    }
    return {
      exists: PRODUCER_UNKNOWN,
      name: null,
      detail: `review row status is '${status || 'unknown'}'; no producer is derivable from it`,
    };
  }

  if (producerKind === PRODUCER_KIND_REMEDIATION) {
    if (amaDispatch?.active) {
      return {
        exists: PRODUCER_YES,
        name: amaDispatch.name,
        detail: 'a remediation/close route holds ownership for this head',
      };
    }
    return {
      exists: PRODUCER_NO,
      name: null,
      detail: 'no remediation or close route is dispatched or pending for this head',
    };
  }

  if (producerKind === PRODUCER_KIND_OPERATOR) {
    return {
      exists: PRODUCER_NO,
      name: null,
      detail: 'only an operator decision produces this input; no automated producer exists',
    };
  }

  if (producerKind === PRODUCER_KIND_EXTERNAL_CI) {
    return {
      exists: PRODUCER_UNKNOWN,
      name: 'CI on this head',
      detail: 'CI runs outside the watcher; whether a run is still pending is not observable here',
    };
  }

  if (producerKind === PRODUCER_KIND_AUTHOR) {
    return {
      exists: PRODUCER_UNKNOWN,
      name: 'a push from the PR author',
      detail: 'only a new push can produce this; nothing in the pipeline is scheduled to',
    };
  }

  return {
    exists: PRODUCER_UNKNOWN,
    name: null,
    detail: 'the producer for this input is not derivable from watcher state',
  };
}

/**
 * Pick the specific missing input. Never returns a generic label: an
 * unrecognised AMA reason is still surfaced by name.
 */
export function deriveMissingInput({
  reviewRow = null,
  headSha = null,
  handlerValue = null,
} = {}) {
  const head = shortHead(headSha);
  const rawReasons = handlerValue?.amaClosureResult?.reasons;
  const reasons = Array.isArray(rawReasons)
    ? rawReasons.map((reason) => String(reason ?? '').trim()).filter(Boolean)
    : [];

  for (const reason of AMA_REASON_PRIORITY) {
    if (!reasons.includes(reason)) continue;
    const entry = MISSING_INPUT_BY_AMA_REASON.get(reason);
    return {
      input: entry.input,
      description: entry.describe(head),
      producerKind: entry.producerKind,
      source: 'ama-eligibility',
      amaReason: reason,
      standingReasons: reasons,
    };
  }

  const hardStopLabel = reasons.find((reason) => reason.startsWith('label-'));
  if (hardStopLabel) {
    return {
      input: 'hard-stop-label-removal',
      description: `removal of the hard-stop label '${hardStopLabel.slice('label-'.length)}'`,
      producerKind: PRODUCER_KIND_OPERATOR,
      source: 'ama-eligibility',
      amaReason: hardStopLabel,
      standingReasons: reasons,
    };
  }

  if (reasons.length > 0) {
    // Unrecognised reason: name it verbatim rather than degrading to "blocked".
    // A reason this table has not learned yet is exactly the case where an
    // operator most needs the raw string.
    const reason = reasons[0];
    return {
      input: reason,
      description: `the input named by AMA eligibility reason '${reason}' at head ${head}`,
      producerKind: PRODUCER_KIND_UNKNOWN,
      source: 'ama-eligibility-unmapped',
      amaReason: reason,
      standingReasons: reasons,
    };
  }

  const status = normalizeStatus(reviewRow?.review_status);
  const byStatus = status ? MISSING_INPUT_BY_REVIEW_STATUS.get(status) : null;
  if (byStatus) {
    return {
      input: byStatus.input,
      description: byStatus.describe(head),
      producerKind: byStatus.producerKind,
      source: 'review-status',
      amaReason: null,
      standingReasons: [],
    };
  }

  return {
    input: 'unclassified-input',
    description:
      `an input this signal cannot name: review status '${status || 'unknown'}' at head ${head} ` +
      'produced no AMA eligibility reasons',
    producerKind: PRODUCER_KIND_UNKNOWN,
    source: 'unclassified',
    amaReason: null,
    standingReasons: [],
  };
}

/**
 * Pure decision. Given the lane's counters and the tick's observed state, is
 * this subject stalled, and if so what is it missing and who could produce it?
 *
 * Reads the lane's counters; changes none of them.
 */
export function evaluateStalledSignal({
  reviewRow = null,
  headSha = null,
  handlerValue = null,
  autoRefreshSuppression = null,
  noProgressTicks = 0,
  thresholdTicks = DEFAULT_STALLED_SIGNAL_TICKS,
} = {}) {
  const ticks = normalizeTicks(noProgressTicks);
  const threshold = positiveIntOr(thresholdTicks, DEFAULT_STALLED_SIGNAL_TICKS);
  const head = String(headSha ?? '').trim() || null;
  if (!head) {
    return { stalled: false, skipReason: 'no-head', noProgressTicks: ticks, thresholdTicks: threshold };
  }
  if (isTerminalSubject(reviewRow, handlerValue)) {
    return { stalled: false, skipReason: 'terminal', noProgressTicks: ticks, thresholdTicks: threshold };
  }
  if (ticks < threshold) {
    return { stalled: false, skipReason: 'under-threshold', noProgressTicks: ticks, thresholdTicks: threshold };
  }
  const missingInput = deriveMissingInput({ reviewRow, headSha: head, handlerValue });
  const producer = producerFor(missingInput.producerKind, {
    reviewRow,
    headSha: head,
    autoRefreshSuppression,
    amaDispatch: classifyAmaDispatch(handlerValue),
  });
  return {
    stalled: true,
    skipReason: null,
    noProgressTicks: ticks,
    thresholdTicks: threshold,
    headSha: head,
    missingInput,
    producer,
  };
}

export function stalledSignalStateDir(rootDir) {
  return join(rootDir, 'data', 'watcher-no-progress-lane', 'stalled-signals');
}

export function stalledSignalEventDir(rootDir) {
  return join(rootDir, 'data', 'watcher-stalled-events');
}

function sanitizePathSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

function stalledSignalFilePrefix(identity) {
  const safeRepo = sanitizePathSegment(String(identity?.repo ?? '').replace(/\//g, '__'));
  return `${safeRepo}-pr-${Number(identity?.prNumber)}-`;
}

function fingerprintKey(value) {
  const normalized = typeof value === 'string' && value.length > 0 ? value : 'no-fingerprint';
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Debounce path. Keyed on (repo, pr, head, fingerprint) — the same key the lane
 * resets its series on — so "one event per stall" and "a new event once
 * something actually changes" are the same rule.
 */
export function stalledSignalStatePath(rootDir, identity, headSha, fingerprint) {
  const safeHead = sanitizePathSegment(String(headSha ?? '').trim() || 'no-sha');
  return join(
    stalledSignalStateDir(rootDir),
    `${stalledSignalFilePrefix(identity)}${safeHead}-${fingerprintKey(fingerprint)}.json`,
  );
}

/**
 * Drop this PR's stalled-signal debounce markers. Called by the lane's
 * merge/close cleanup so a terminal PR leaves nothing behind, and so a reopened
 * PR that stalls again can say so.
 */
export function clearStalledSignalState(rootDir, identity, {
  logger = console,
  fsImpl = null,
} = {}) {
  const dir = stalledSignalStateDir(rootDir);
  const prefix = stalledSignalFilePrefix(identity);
  const readdir = fsImpl?.readdirSync ?? readdirSync;
  const remove = fsImpl?.rmSync ?? rmSync;
  let entries = [];
  try {
    entries = readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return true;
    logger?.warn?.(
      `[watcher] stalled signal: failed to list debounce dir ${dir} ` +
        `(${err?.code || err?.message || 'unknown'})`,
    );
    return false;
  }
  let ok = true;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.json')) continue;
    const filePath = join(dir, entry.name);
    try {
      remove(filePath, { force: true });
    } catch (err) {
      ok = false;
      logger?.warn?.(
        `[watcher] stalled signal: failed to remove debounce marker ${filePath} ` +
          `(${err?.code || err?.message || 'unknown'})`,
      );
    }
  }
  return ok;
}

function formatDuration(fromIso, nowMs) {
  const startMs = Date.parse(String(fromIso ?? ''));
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs) || nowMs < startMs) return null;
  const totalMinutes = Math.floor((nowMs - startMs) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}

/**
 * The operator-facing sentence. This is the whole point of the ticket: it must
 * be impossible to mistake for the "quiet PR" line it replaces.
 */
export function formatStalledSignalLine(event) {
  const duration = event.stalledForHuman ? ` (${event.stalledForHuman})` : '';
  const producerSentence = event.producer.exists === PRODUCER_NO
    ? `No producer exists — ${event.producer.detail}.`
    : event.producer.exists === PRODUCER_YES
      ? `A producer exists: ${event.producer.name} — ${event.producer.detail}.`
      : `Producer unknown: ${event.producer.detail}.`;
  const closing = event.producer.exists === PRODUCER_NO
    ? ' This cannot self-resolve; it needs a new input.'
    : '';
  return (
    `[watcher] STALLED ${event.repo}#${event.prNumber} for ${event.noProgressTicks} ticks${duration}: ` +
    `needs ${event.missingInput.description}. ${producerSentence}${closing}`
  );
}

/**
 * Emit the `stalled` event at most once per stall.
 *
 * Never throws: a sink fault is logged and reported as "not emitted", which
 * leaves the debounce marker unwritten so the next due tick retries. A failure
 * to describe a stall must never be able to wedge the tick that found it.
 *
 * @returns {object|null} the emitted event, or null when nothing was emitted.
 */
export function maybeEmitStalledSignal({
  rootDir,
  identity,
  headSha = null,
  fingerprint = null,
  noProgressTicks = 0,
  firstNoProgressAt = null,
  reviewRow = null,
  handlerValue = null,
  autoRefreshSuppression = null,
  thresholdTicks = DEFAULT_STALLED_SIGNAL_TICKS,
  now = new Date().toISOString(),
  logger = console,
  fsImpl = {},
} = {}) {
  const decision = evaluateStalledSignal({
    reviewRow,
    headSha,
    handlerValue,
    autoRefreshSuppression,
    noProgressTicks,
    thresholdTicks,
  });
  if (!decision.stalled) return null;

  const fileExists = fsImpl.existsSync ?? existsSync;
  const makeDir = fsImpl.mkdirSync ?? mkdirSync;
  const appendFile = fsImpl.appendFileSync ?? appendFileSync;
  const writeFile = fsImpl.writeFileSync ?? writeFileSync;

  const statePath = stalledSignalStatePath(rootDir, identity, decision.headSha, fingerprint);
  try {
    if (fileExists(statePath)) return null;
  } catch {
    // A read fault fails toward emitting once; the marker write below still
    // debounces every subsequent tick.
  }

  const observedAtMs = Date.parse(String(now ?? ''));
  const event = {
    event: STALLED_SIGNAL_EVENT,
    at: now,
    repo: identity?.repo ?? 'unknown-repo',
    prNumber: Number(identity?.prNumber),
    headSha: decision.headSha,
    noProgressTicks: decision.noProgressTicks,
    thresholdTicks: decision.thresholdTicks,
    firstNoProgressAt: firstNoProgressAt || null,
    stalledForHuman: formatDuration(firstNoProgressAt, observedAtMs),
    missingInput: decision.missingInput,
    producer: decision.producer,
    fingerprintKey: fingerprintKey(fingerprint),
  };

  try {
    const eventDir = stalledSignalEventDir(rootDir);
    makeDir(eventDir, { recursive: true });
    const day = String(event.at).slice(0, 10);
    appendFile(join(eventDir, `${day}.jsonl`), `${JSON.stringify(event)}\n`, 'utf8');
  } catch (err) {
    logger?.warn?.(
      `[watcher] stalled signal: failed to append the event stream for ` +
        `${event.repo}#${event.prNumber} (${err?.message || err}); not marking it emitted ` +
        'so the next due tick retries',
    );
    return null;
  }

  logger?.warn?.(formatStalledSignalLine(event));

  try {
    makeDir(stalledSignalStateDir(rootDir), { recursive: true });
    writeFile(statePath, `${JSON.stringify(event, null, 2)}\n`, 'utf8');
  } catch (err) {
    // The event is out. Losing the marker only risks a duplicate on the next due
    // tick, which is strictly better than losing the signal.
    logger?.warn?.(
      `[watcher] stalled signal: failed to persist the debounce marker ${statePath} ` +
        `(${err?.message || err})`,
    );
  }
  return event;
}
