/**
 * Time-to-merge tracking, split into SLOW and STUCK.
 *
 * These are different conditions and they used to share one finding. `slow`
 * means a PR is over budget but still moving, which under load is the expected
 * state and self-resolves; `stuck` means the PR is not progressing at all and
 * needs a human. Collapsing them is what made `review:ttm_budget_breach` page
 * continuously and stop carrying information: on 2026-09-05 a genuinely
 * deadlocked PR (agent-os#6288, stranded 3h44m on a closer-lease self-deadlock)
 * emitted the same finding as the fifteen PRs that were merely busy.
 *
 * So:
 *   SLOW  -- `round_budget_breach`. Budget is DERIVED from the measured merge
 *            distribution and scaled by measured queue pressure
 *            (`ttm-budget-model.mjs`); it belongs on a trend, not an alarm.
 *   STUCK -- `rereview_unanswered`, `reviewer_lease_expired`,
 *            `terminal_but_unmerged`. None of these consult the TTM budget:
 *            a PR that is not progressing is stuck at any elapsed time, and a
 *            PR that is progressing is not stuck no matter how slow the host
 *            is. This is what is worth paging on.
 *
 * @module ttm-tracker
 */
import {
  DEFAULT_TTM_BUDGET_PERCENTILE,
  DEFAULT_TTM_FIT_SAMPLE_LIMIT,
  DEFAULT_TTM_MIN_FIT_SAMPLES,
  TtmDistributionUnreadableError,
  deriveTtmBudget,
  readMergedTtmSamples,
} from './ttm-budget-model.mjs';

// Seeds, NOT the operating budget. These are what the tracker falls back to
// when the distribution cannot support a fit; the live budget comes from
// `deriveTtmBudget`. Measured 2026-09-06 the fitted p90 curve was
// base ~120m + ~49m/round, i.e. the seeds are 8x and 5x too tight, which is
// exactly why nothing may read them as a target.
const DEFAULT_TTM_BASE_BUDGET_MINUTES = 15;
const DEFAULT_TTM_PER_ROUND_BUDGET_MINUTES = 10;
const DEFAULT_TTM_TERMINAL_UNMERGED_MINUTES = 10;
const DEFAULT_TTM_ROLLUP_WINDOW_HOURS = 12;
// Grace before an unanswered re-review request or an expired reviewer lease is
// called stuck rather than in-flight. Deliberately a small fixed number and
// deliberately NOT the TTM budget: this measures "nothing happened since the
// pipeline said it would act", which does not get more acceptable on a busy
// host -- a busy host still starts the pass it promised.
const DEFAULT_TTM_PROGRESS_STALL_MINUTES = 30;

const CLEAN_VERDICTS = new Set(['approved', 'comment-only']);
const REVIEW_PASS_KINDS = new Set(['first-pass', 'rereview']);
/** Flags that mean "over budget but moving" -- trend, never page. */
const TTM_SLOW_FLAG_KINDS = new Set(['round_budget_breach']);
/** Flags that mean "not progressing" -- the ones worth paging on. */
const TTM_STUCK_FLAG_KINDS = new Set([
  'rereview_unanswered',
  'reviewer_lease_expired',
  'terminal_but_unmerged',
]);

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toMs(value) {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function minutesBetween(start, end) {
  const startMs = toMs(start);
  const endMs = toMs(end);
  if (startMs === null || endMs === null) return null;
  return Math.max(0, (endMs - startMs) / 60_000);
}

function isoFromMs(value) {
  return new Date(value).toISOString();
}

function percentile(values, percentileValue) {
  const sorted = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (percentileValue / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

function resolveTtmTrackerConfig(env = process.env, overrides = {}) {
  const baseRaw = overrides.baseBudgetMinutes ?? env.ADVERSARIAL_TTM_BASE_BUDGET_MINUTES;
  const perRoundRaw = overrides.perRoundBudgetMinutes
    ?? env.ADVERSARIAL_TTM_PER_ROUND_BUDGET_MINUTES;
  // `resolveTtmTrackerConfig` is called twice on the health path: once to build
  // `config.ttm`, and again inside `evaluateTtmFromDb` with that resolved
  // object as the overrides. Without this, the seeded defaults from the first
  // resolve would look like an operator pin on the second and measurement
  // would never run. An already-resolved config carries its own verdict.
  const inherited = overrides.budgetPinned;
  const basePinned = inherited
    ? Boolean(inherited.base)
    : Number.isFinite(Number(baseRaw)) && Number(baseRaw) > 0;
  const perRoundPinned = inherited
    ? Boolean(inherited.perRound)
    : Number.isFinite(Number(perRoundRaw)) && Number(perRoundRaw) > 0;
  return {
    baseBudgetMinutes: parsePositiveNumber(baseRaw, DEFAULT_TTM_BASE_BUDGET_MINUTES),
    perRoundBudgetMinutes: parsePositiveNumber(
      perRoundRaw,
      DEFAULT_TTM_PER_ROUND_BUDGET_MINUTES
    ),
    // An explicit operator/test pin wins over measurement -- otherwise a pin
    // would be silently ignored, which is its own class of surprise. When
    // nothing is pinned the budget is DERIVED, never these seeds.
    budgetPinned: { base: basePinned, perRound: perRoundPinned },
    terminalUnmergedMinutes: parsePositiveNumber(
      overrides.terminalUnmergedMinutes ?? env.ADVERSARIAL_TTM_TERMINAL_UNMERGED_MINUTES,
      DEFAULT_TTM_TERMINAL_UNMERGED_MINUTES
    ),
    progressStallMinutes: parsePositiveNumber(
      overrides.progressStallMinutes ?? env.ADVERSARIAL_TTM_PROGRESS_STALL_MINUTES,
      DEFAULT_TTM_PROGRESS_STALL_MINUTES
    ),
    rollupWindowHours: parsePositiveNumber(
      overrides.rollupWindowHours ?? env.ADVERSARIAL_TTM_ROLLUP_WINDOW_HOURS,
      DEFAULT_TTM_ROLLUP_WINDOW_HOURS
    ),
    budgetPercentile: parsePositiveNumber(
      overrides.budgetPercentile ?? env.ADVERSARIAL_TTM_BUDGET_PERCENTILE,
      DEFAULT_TTM_BUDGET_PERCENTILE
    ),
    budgetSampleLimit: parsePositiveNumber(
      overrides.budgetSampleLimit ?? env.ADVERSARIAL_TTM_BUDGET_SAMPLE_LIMIT,
      DEFAULT_TTM_FIT_SAMPLE_LIMIT
    ),
    budgetMinSamples: parsePositiveNumber(
      overrides.budgetMinSamples ?? env.ADVERSARIAL_TTM_BUDGET_MIN_SAMPLES,
      DEFAULT_TTM_MIN_FIT_SAMPLES
    ),
  };
}

function ensureTtmTrackerSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ttm_flag_events (
      event_id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key                 TEXT NOT NULL,
      repo                      TEXT NOT NULL,
      pr_number                 INTEGER NOT NULL,
      flag_kind                 TEXT NOT NULL,
      state                     TEXT NOT NULL CHECK (state IN ('active', 'resolved')),
      observed_at               TEXT NOT NULL,
      opened_at                 TEXT,
      settled_at                TEXT,
      merged_at                 TEXT,
      elapsed_minutes           REAL,
      budget_minutes            REAL,
      terminal_unmerged_minutes REAL,
      review_rounds             INTEGER NOT NULL DEFAULT 0,
      details_json              TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(details_json) AND json_type(details_json) = 'object')
    );

    CREATE INDEX IF NOT EXISTS idx_ttm_flag_events_observed
      ON ttm_flag_events(observed_at);

    CREATE INDEX IF NOT EXISTS idx_ttm_flag_events_kind_state
      ON ttm_flag_events(flag_kind, state, observed_at);

    CREATE TABLE IF NOT EXISTS ttm_flag_state (
      event_key                 TEXT PRIMARY KEY,
      repo                      TEXT NOT NULL,
      pr_number                 INTEGER NOT NULL,
      flag_kind                 TEXT NOT NULL,
      state                     TEXT NOT NULL CHECK (state IN ('active', 'resolved')),
      first_observed_at         TEXT NOT NULL,
      last_observed_at          TEXT NOT NULL,
      resolved_at               TEXT,
      opened_at                 TEXT,
      settled_at                TEXT,
      merged_at                 TEXT,
      elapsed_minutes           REAL,
      budget_minutes            REAL,
      terminal_unmerged_minutes REAL,
      review_rounds             INTEGER NOT NULL DEFAULT 0,
      details_json              TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(details_json) AND json_type(details_json) = 'object')
    );

    CREATE INDEX IF NOT EXISTS idx_ttm_flag_state_active
      ON ttm_flag_state(state, flag_kind, last_observed_at);
  `);
}

function normalizeReviewPass(row) {
  const passKind = String(row.pass_kind || '').trim();
  if (!REVIEW_PASS_KINDS.has(passKind)) return null;
  return {
    startedAt: row.started_at || null,
    endedAt: row.ended_at || null,
    status: String(row.status || '').trim().toLowerCase(),
    verdict: row.verdict ? String(row.verdict).trim().toLowerCase() : null,
    attemptNumber: Number.isInteger(Number(row.attempt_number))
      ? Number(row.attempt_number)
      : null,
    passKind,
  };
}

function derivePrTtmTimeline(row, passes, { nowIso }) {
  const openedAt = row.reviewed_at || null;
  const mergedAt = row.merged_at || null;
  const closedAt = row.closed_at || null;
  const completedPasses = passes
    .map(normalizeReviewPass)
    .filter((pass) => pass && pass.status === 'completed');
  const reviewRoundStarts = completedPasses
    .map((pass) => pass.startedAt)
    .filter(Boolean)
    .sort();
  const reviewRoundEnds = completedPasses
    .map((pass) => pass.endedAt)
    .filter(Boolean)
    .sort();
  const latestCompleted = completedPasses
    .filter((pass) => pass.endedAt)
    .sort((a, b) => toMs(b.endedAt) - toMs(a.endedAt))[0] || null;
  const maxAttempt = completedPasses.reduce((max, pass) => {
    if (!Number.isInteger(pass.attemptNumber)) return max;
    return Math.max(max, pass.attemptNumber);
  }, 0);
  const reviewRounds = Math.max(0, maxAttempt - 1);
  const settledAt = row.posted_at || latestCompleted?.endedAt || null;
  const latestVerdict = latestCompleted?.verdict || null;
  const terminalClean = CLEAN_VERDICTS.has(latestVerdict)
    || (
      String(row.review_status || '').trim().toLowerCase() === 'posted'
      && !latestVerdict
      && Boolean(row.posted_at)
    );

  // Progress evidence, independent of the TTM budget. ANY pass counts here,
  // including a running one: a reviewer that is mid-pass is progress, and a
  // reviewer that never started is not, regardless of how long the PR has been
  // open or how loaded the host is.
  const allPassStartMs = passes
    .map(normalizeReviewPass)
    .filter(Boolean)
    .map((pass) => toMs(pass.startedAt))
    .filter((ms) => ms !== null);
  const latestPassStartedAtMs = allPassStartMs.length ? Math.max(...allPassStartMs) : null;
  const rereviewRequestedAt = row.rereview_requested_at || null;
  const rereviewRequestedMs = toMs(rereviewRequestedAt);
  const rereviewAnswered = rereviewRequestedMs !== null
    && latestPassStartedAtMs !== null
    && latestPassStartedAtMs >= rereviewRequestedMs;
  const reviewerLeaseExpiresAt = row.reviewer_lease_expires_at || null;
  const reviewerLeaseExpiresMs = toMs(reviewerLeaseExpiresAt);
  const nowMs = toMs(nowIso);

  return {
    repo: row.repo,
    prNumber: Number(row.pr_number),
    openedAt,
    reviewRoundStarts,
    reviewRoundEnds,
    settledAt,
    mergedAt,
    closedAt,
    prState: String(row.pr_state || 'open').trim().toLowerCase(),
    reviewStatus: String(row.review_status || '').trim().toLowerCase(),
    reviewRounds,
    latestVerdict,
    terminalClean,
    elapsedMinutes: minutesBetween(openedAt, mergedAt || closedAt || nowIso),
    terminalUnmergedMinutes: terminalClean && !mergedAt && String(row.pr_state || 'open').toLowerCase() === 'open'
      ? minutesBetween(settledAt || openedAt, nowIso)
      : null,
    rereviewRequestedAt,
    latestPassStartedAt: latestPassStartedAtMs === null ? null : isoFromMs(latestPassStartedAtMs),
    rereviewAnswered,
    // Null (not zero) when there is nothing to be unanswered about, so a PR
    // with no re-review request can never satisfy a `> threshold` test.
    rereviewUnansweredMinutes: rereviewRequestedMs !== null && !rereviewAnswered
      ? minutesBetween(rereviewRequestedAt, nowIso)
      : null,
    reviewerLeaseExpiresAt,
    // A lease that expired while the row still claims an in-flight review is
    // the lease/gate deadlock class: ownership was taken and never released,
    // so nothing else will pick the PR up.
    reviewerLeaseExpiredMinutes: reviewerLeaseExpiresMs !== null
      && nowMs !== null
      && nowMs > reviewerLeaseExpiresMs
      && String(row.review_status || '').trim().toLowerCase() === 'reviewing'
      ? (nowMs - reviewerLeaseExpiresMs) / 60_000
      : null,
  };
}

function computeTtmBudget(reviewRounds, config) {
  return config.baseBudgetMinutes + Math.max(0, Number(reviewRounds) || 0) * config.perRoundBudgetMinutes;
}

function flagKeyFor(row, flagKind) {
  return `${row.repo}#${row.prNumber}:${flagKind}`;
}

const TTM_STALL_MINUTES_BY_KIND = Object.freeze({
  rereview_unanswered: (row) => row.rereviewUnansweredMinutes,
  reviewer_lease_expired: (row) => row.reviewerLeaseExpiredMinutes,
  terminal_but_unmerged: (row) => row.terminalUnmergedMinutes,
});

function buildTtmFlag(row, flagKind, observedAt, config, extraDetails = {}) {
  const budgetMinutes = computeTtmBudget(row.reviewRounds, config);
  const stallMinutes = TTM_STALL_MINUTES_BY_KIND[flagKind]?.(row) ?? null;
  return {
    eventKey: flagKeyFor(row, flagKind),
    repo: row.repo,
    prNumber: row.prNumber,
    flagKind,
    // The whole point of the split: a consumer must be able to tell "over
    // budget but moving" from "not progressing" without parsing prose.
    progressClass: TTM_STUCK_FLAG_KINDS.has(flagKind) ? 'stuck' : 'slow',
    state: 'active',
    observedAt,
    openedAt: row.openedAt,
    settledAt: row.settledAt,
    mergedAt: row.mergedAt,
    elapsedMinutes: row.elapsedMinutes,
    budgetMinutes,
    terminalUnmergedMinutes: row.terminalUnmergedMinutes,
    stallMinutes,
    reviewRounds: row.reviewRounds,
    details: {
      prState: row.prState,
      reviewStatus: row.reviewStatus,
      latestVerdict: row.latestVerdict,
      baseBudgetMinutes: config.baseBudgetMinutes,
      perRoundBudgetMinutes: config.perRoundBudgetMinutes,
      terminalUnmergedThresholdMinutes: config.terminalUnmergedMinutes,
      progressStallThresholdMinutes: config.progressStallMinutes,
      budgetProvenance: config.budgetProvenance || null,
      stallMinutes,
      ...extraDetails,
    },
  };
}

/**
 * @param {Object} opts
 * @param {boolean} [opts.budgetBlind] when true the merged-PR distribution
 *   could not be read, so no budget exists to compare against. The SLOW flag
 *   is withheld -- a budget nobody measured is not a threshold -- while every
 *   STUCK flag still evaluates, because none of them consult the budget. That
 *   is blindness about slowness, not a clean bill of health.
 */
function evaluateTtmTimelines(rows, { observedAt, config, budgetBlind = false }) {
  const flags = [];
  for (const row of rows) {
    if (row.prState !== 'open') continue;

    // ── SLOW: over budget, still moving. Trend, not alarm. ────────────────
    const budgetMinutes = computeTtmBudget(row.reviewRounds, config);
    if (!budgetBlind && row.elapsedMinutes !== null && row.elapsedMinutes > budgetMinutes) {
      flags.push(buildTtmFlag(row, 'round_budget_breach', observedAt, config));
    }

    // ── STUCK: not progressing. None of these read the budget. ────────────
    if (
      row.terminalClean
      && row.terminalUnmergedMinutes !== null
      && row.terminalUnmergedMinutes > config.terminalUnmergedMinutes
    ) {
      flags.push(buildTtmFlag(row, 'terminal_but_unmerged', observedAt, config, {
        stallReason: 'terminal clean verdict is settled but the PR will not merge',
      }));
    }
    if (
      row.rereviewUnansweredMinutes !== null
      && row.rereviewUnansweredMinutes > config.progressStallMinutes
    ) {
      flags.push(buildTtmFlag(row, 'rereview_unanswered', observedAt, config, {
        stallReason: 'a re-review was requested and no reviewer pass has started since',
        rereviewRequestedAt: row.rereviewRequestedAt,
        latestPassStartedAt: row.latestPassStartedAt,
      }));
    }
    if (
      row.reviewerLeaseExpiredMinutes !== null
      && row.reviewerLeaseExpiredMinutes > config.progressStallMinutes
    ) {
      flags.push(buildTtmFlag(row, 'reviewer_lease_expired', observedAt, config, {
        stallReason: 'the reviewer lease expired while the row still claims an in-flight review',
        reviewerLeaseExpiresAt: row.reviewerLeaseExpiresAt,
        latestPassStartedAt: row.latestPassStartedAt,
      }));
    }
  }
  return flags;
}

function readTtmTimelines(db, { nowIso }) {
  let reviewRows;
  let passRows;
  try {
    reviewRows = db.prepare(
      `SELECT repo, pr_number, reviewed_at, pr_state, merged_at, closed_at,
              review_status, posted_at, rereview_requested_at,
              reviewer_lease_expires_at
         FROM reviewed_prs`
    ).all();
    passRows = db.prepare(
      `SELECT repo, pr_number, attempt_number, pass_kind, started_at, ended_at,
              status, verdict
         FROM reviewer_passes
        WHERE pass_kind IN ('first-pass', 'rereview')`
    ).all();
  } catch (error) {
    const message = String(error?.message || '');
    if (
      error?.code === 'SQLITE_ERROR'
      && (message.includes('no such table') || message.includes('no such column'))
    ) {
      return [];
    }
    throw error;
  }
  const passesByPr = new Map();
  for (const pass of passRows) {
    const key = `${pass.repo}#${pass.pr_number}`;
    const list = passesByPr.get(key) || [];
    list.push(pass);
    passesByPr.set(key, list);
  }
  return reviewRows.map((row) => derivePrTtmTimeline(
    row,
    passesByPr.get(`${row.repo}#${row.pr_number}`) || [],
    { nowIso }
  ));
}

function insertTtmFlagEvent(db, flag, state, observedAt) {
  db.prepare(
    `INSERT INTO ttm_flag_events (
       event_key, repo, pr_number, flag_kind, state, observed_at,
       opened_at, settled_at, merged_at, elapsed_minutes, budget_minutes,
       terminal_unmerged_minutes, review_rounds, details_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    flag.eventKey,
    flag.repo,
    flag.prNumber,
    flag.flagKind,
    state,
    observedAt,
    flag.openedAt,
    flag.settledAt,
    flag.mergedAt,
    flag.elapsedMinutes,
    flag.budgetMinutes,
    flag.terminalUnmergedMinutes,
    flag.reviewRounds,
    JSON.stringify(flag.details || {})
  );
  return {
    event_key: flag.eventKey,
    repo: flag.repo,
    pr_number: flag.prNumber,
    flag_kind: flag.flagKind,
    state,
    observed_at: observedAt,
    opened_at: flag.openedAt,
    settled_at: flag.settledAt,
    merged_at: flag.mergedAt,
    elapsed_minutes: flag.elapsedMinutes,
    budget_minutes: flag.budgetMinutes,
    terminal_unmerged_minutes: flag.terminalUnmergedMinutes,
    review_rounds: flag.reviewRounds,
    details_json: JSON.stringify(flag.details || {}),
  };
}

function syncTtmFlags(db, flags, { observedAt }) {
  ensureTtmTrackerSchema(db);
  const activeKeys = new Set(flags.map((flag) => flag.eventKey));
  const eventRows = [];
  let activated = 0;
  let refreshed = 0;
  let resolved = 0;

  const tx = db.transaction(() => {
    for (const flag of flags) {
      const existing = db.prepare(
        'SELECT state FROM ttm_flag_state WHERE event_key = ?'
      ).get(flag.eventKey);
      if (!existing || existing.state !== 'active') {
        eventRows.push(insertTtmFlagEvent(db, flag, 'active', observedAt));
        activated += 1;
      } else {
        refreshed += 1;
      }
      db.prepare(
        `INSERT INTO ttm_flag_state (
           event_key, repo, pr_number, flag_kind, state, first_observed_at,
           last_observed_at, resolved_at, opened_at, settled_at, merged_at,
           elapsed_minutes, budget_minutes, terminal_unmerged_minutes,
           review_rounds, details_json
         ) VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_key) DO UPDATE SET
           state = 'active',
           last_observed_at = excluded.last_observed_at,
           resolved_at = NULL,
           opened_at = excluded.opened_at,
           settled_at = excluded.settled_at,
           merged_at = excluded.merged_at,
           elapsed_minutes = excluded.elapsed_minutes,
           budget_minutes = excluded.budget_minutes,
           terminal_unmerged_minutes = excluded.terminal_unmerged_minutes,
           review_rounds = excluded.review_rounds,
           details_json = excluded.details_json`
      ).run(
        flag.eventKey,
        flag.repo,
        flag.prNumber,
        flag.flagKind,
        observedAt,
        observedAt,
        flag.openedAt,
        flag.settledAt,
        flag.mergedAt,
        flag.elapsedMinutes,
        flag.budgetMinutes,
        flag.terminalUnmergedMinutes,
        flag.reviewRounds,
        JSON.stringify(flag.details || {})
      );
    }

    const activeRows = db.prepare(
      "SELECT * FROM ttm_flag_state WHERE state = 'active'"
    ).all();
    for (const row of activeRows) {
      if (activeKeys.has(row.event_key)) continue;
      const flag = {
        eventKey: row.event_key,
        repo: row.repo,
        prNumber: row.pr_number,
        flagKind: row.flag_kind,
        openedAt: row.opened_at,
        settledAt: row.settled_at,
        mergedAt: row.merged_at,
        elapsedMinutes: row.elapsed_minutes,
        budgetMinutes: row.budget_minutes,
        terminalUnmergedMinutes: row.terminal_unmerged_minutes,
        reviewRounds: row.review_rounds,
        details: JSON.parse(row.details_json || '{}'),
      };
      eventRows.push(insertTtmFlagEvent(db, flag, 'resolved', observedAt));
      db.prepare(
        `UPDATE ttm_flag_state
            SET state = 'resolved',
                last_observed_at = ?,
                resolved_at = ?
          WHERE event_key = ?`
      ).run(observedAt, observedAt, row.event_key);
      resolved += 1;
    }
  });

  tx();
  return { activated, refreshed, resolved, active: flags.length, eventRows };
}

function summarizeTtmRollupFromTimelines(rows, {
  observedAt,
  config,
  eventRows = [],
  budgetBlind = false,
  budget = null,
}) {
  const observedMs = toMs(observedAt);
  const windowStartMs = observedMs - config.rollupWindowHours * 60 * 60 * 1000;
  const mergedDurations = rows
    .filter((row) => row.mergedAt && toMs(row.mergedAt) >= windowStartMs)
    .map((row) => minutesBetween(row.openedAt, row.mergedAt))
    .filter((value) => value !== null);
  const allFlags = evaluateTtmTimelines(rows, { observedAt, config, budgetBlind });
  const openBreaches = allFlags.filter((flag) => flag.flagKind === 'round_budget_breach');
  const stuckFlags = allFlags.filter((flag) => flag.progressClass === 'stuck');
  const terminalUnmerged = allFlags
    .filter((flag) => flag.flagKind === 'terminal_but_unmerged');
  const terminalEventRows = eventRows.filter((row) => (
    row.flag_kind === 'terminal_but_unmerged'
    && toMs(row.observed_at) !== null
    && toMs(row.observed_at) >= windowStartMs
  ));
  const activeTerminalDurations = terminalUnmerged
    .map((flag) => flag.terminalUnmergedMinutes)
    .filter((value) => Number.isFinite(value));
  const resolvedTerminalDurations = terminalEventRows
    .filter((row) => row.state === 'resolved')
    .map((row) => Number(row.terminal_unmerged_minutes))
    .filter((value) => Number.isFinite(value));
  const terminalDurations = [...activeTerminalDurations, ...resolvedTerminalDurations];
  const terminalStallKeys = new Set([
    ...terminalEventRows.map((row) => row.event_key).filter(Boolean),
    ...terminalUnmerged.map((flag) => flag.eventKey).filter(Boolean),
  ]);

  return {
    windowHours: config.rollupWindowHours,
    medianTimeToMergeMinutes: percentile(mergedDurations, 50),
    p90TimeToMergeMinutes: percentile(mergedDurations, 90),
    mergedPrs: mergedDurations.length,
    // The trend pair. `openPrsBreachingBudget` is the SLOW counter and is null
    // (not 0) when blind, so a graph can show a gap instead of a clean line.
    openPrsBreachingBudget: budgetBlind ? null : openBreaches.length,
    budgetBlind,
    budgetSource: budget?.source || config.budgetProvenance?.source || null,
    baseBudgetMinutes: budgetBlind ? null : config.baseBudgetMinutes,
    perRoundBudgetMinutes: budgetBlind ? null : config.perRoundBudgetMinutes,
    budgetPercentile: config.budgetPercentile,
    queuePressureMultiplier: budget?.pressure?.multiplier ?? null,
    // True when queue depth exceeds the widest budget the model will grant.
    // Surfaced deliberately: at that point the pipeline is oversubscribed and
    // the residual breaches are a throughput deficit, not a budget error.
    queuePressureSaturated: Boolean(budget?.pressure?.saturated),
    // The page-worthy counter.
    stuckOpenPrs: stuckFlags.length,
    terminalButUnmergedOpenCount: terminalUnmerged.length,
    terminalButUnmergedStallsLast12h: terminalStallKeys.size,
    terminalButUnmergedMaxDurationMinutesLast12h: terminalDurations.length
      ? Math.max(...terminalDurations)
      : 0,
    terminalButUnmergedTotalDurationMinutesLast12h: terminalDurations.reduce((sum, value) => sum + value, 0),
    standingSev1Metric: '100% hammer-closed / 12h requires zero terminal-but-unmerged stalls requiring manual close',
  };
}

function readRecentTtmFlagEvents(db, { observedAt, config }) {
  const observedMs = toMs(observedAt);
  const windowStart = isoFromMs(observedMs - config.rollupWindowHours * 60 * 60 * 1000);
  try {
    return db.prepare(
      `SELECT *
         FROM ttm_flag_events
        WHERE observed_at >= ?
        ORDER BY observed_at ASC, event_id ASC`
    ).all(windowStart);
  } catch (error) {
    if (String(error?.message || '').includes('no such table')) return [];
    throw error;
  }
}

/**
 * Replace the seeded budget with one derived from the measured merge
 * distribution, scaled by measured queue pressure.
 *
 * Returns `{config, budget}` where `budget.blind` is true when the
 * distribution could not be read at all. Blind is SEN-02 vocabulary: the
 * caller reports that it could not look. It must not report health, and it
 * must not present the seeds as a measured budget.
 */
function applyMeasuredTtmBudget(db, config, timelines) {
  const openPrCount = timelines.filter((row) => row.prState === 'open').length;
  const pinned = config.budgetPinned || { base: false, perRound: false };
  if (pinned.base && pinned.perRound) {
    return {
      config: {
        ...config,
        budgetProvenance: { source: 'pinned', blind: false, openPrCount },
      },
      budget: { blind: false, source: 'pinned', model: null, pressure: null, openPrCount },
    };
  }

  let samples;
  try {
    samples = readMergedTtmSamples(db, { limit: config.budgetSampleLimit });
  } catch (error) {
    if (!(error instanceof TtmDistributionUnreadableError)) throw error;
    const provenance = {
      source: 'blind',
      blind: true,
      blindReason: error.message,
      openPrCount,
    };
    return {
      config: { ...config, budgetProvenance: provenance },
      budget: {
        blind: true,
        source: 'blind',
        blindReason: error.message,
        model: null,
        pressure: null,
        openPrCount,
      },
    };
  }

  const derived = deriveTtmBudget(samples, {
    percentile: config.budgetPercentile,
    minSamples: config.budgetMinSamples,
    openPrCount,
  });
  const source = derived.usable ? derived.model.source : 'seeded-insufficient-samples';
  const baseBudgetMinutes = !pinned.base && derived.usable
    ? derived.baseBudgetMinutes
    : config.baseBudgetMinutes;
  const perRoundBudgetMinutes = !pinned.perRound && derived.usable
    ? derived.perRoundBudgetMinutes
    : config.perRoundBudgetMinutes;
  const provenance = {
    source,
    blind: false,
    percentile: config.budgetPercentile,
    sampleCount: derived.model.sampleCount,
    minSamples: config.budgetMinSamples,
    fittedBaseMinutes: derived.model.baseBudgetMinutes,
    fittedPerRoundMinutes: derived.model.perRoundBudgetMinutes,
    queuePressureMultiplier: derived.pressure.multiplier,
    queuePressureRaw: derived.pressure.rawPressure,
    queuePressureSaturated: derived.pressure.saturated,
    referenceOpenPrCount: derived.pressure.referenceOpenPrCount,
    openPrCount,
    pinnedBase: pinned.base,
    pinnedPerRound: pinned.perRound,
  };
  return {
    config: {
      ...config,
      baseBudgetMinutes,
      perRoundBudgetMinutes,
      budgetProvenance: provenance,
    },
    budget: {
      blind: false,
      source,
      model: derived.model,
      pressure: derived.pressure,
      openPrCount,
    },
  };
}

function evaluateTtmFromDb(db, {
  now = () => new Date(),
  env = process.env,
  config: configOverrides = {},
} = {}) {
  const observedAt = typeof now === 'function' ? now().toISOString() : new Date(now).toISOString();
  const seededConfig = resolveTtmTrackerConfig(env, configOverrides);
  const timelines = readTtmTimelines(db, { nowIso: observedAt });
  const { config, budget } = applyMeasuredTtmBudget(db, seededConfig, timelines);
  const flags = evaluateTtmTimelines(timelines, {
    observedAt,
    config,
    budgetBlind: budget.blind,
  });
  const eventRows = readRecentTtmFlagEvents(db, { observedAt, config });
  return {
    observedAt,
    config,
    budget,
    timelines,
    flags,
    eventRows,
    rollup: summarizeTtmRollupFromTimelines(timelines, {
      observedAt,
      config,
      eventRows,
      budgetBlind: budget.blind,
      budget,
    }),
  };
}

function runTtmTrackerTick(db, options = {}) {
  const result = evaluateTtmFromDb(db, options);
  const sync = syncTtmFlags(db, result.flags, { observedAt: result.observedAt });
  const eventRows = [...result.eventRows, ...sync.eventRows];
  return {
    ...result,
    sync,
    rollup: summarizeTtmRollupFromTimelines(result.timelines, {
      observedAt: result.observedAt,
      config: result.config,
      eventRows,
      budgetBlind: result.budget?.blind === true,
      budget: result.budget,
    }),
  };
}

function runTtmTrackerWatcherTick({ db, logger = console } = {}) {
  try {
    const ttm = runTtmTrackerTick(db);
    if (ttm.sync.activated > 0 || ttm.sync.resolved > 0) {
      logger.log?.(
        `[watcher] ttm-tracker active=${ttm.sync.active} activated=${ttm.sync.activated} `
        + `resolved=${ttm.sync.resolved} terminal_unmerged_open=${ttm.rollup.terminalButUnmergedOpenCount} `
        + `stuck=${ttm.rollup.stuckOpenPrs} budget_breaches=${ttm.rollup.openPrsBreachingBudget} `
        + `budget=${ttm.rollup.budgetSource}:`
        + `${ttm.rollup.baseBudgetMinutes === null ? 'blind' : Math.round(ttm.rollup.baseBudgetMinutes)}m`
        + `+${ttm.rollup.perRoundBudgetMinutes === null ? 'blind' : Math.round(ttm.rollup.perRoundBudgetMinutes)}m/round`
      );
    }
    return ttm;
  } catch (ttmErr) {
    logger.error?.(`[watcher] ttm-tracker tick raised: ${ttmErr?.message || ttmErr}`);
    return null;
  }
}

export {
  CLEAN_VERDICTS,
  DEFAULT_TTM_BASE_BUDGET_MINUTES,
  DEFAULT_TTM_PER_ROUND_BUDGET_MINUTES,
  DEFAULT_TTM_PROGRESS_STALL_MINUTES,
  DEFAULT_TTM_ROLLUP_WINDOW_HOURS,
  DEFAULT_TTM_TERMINAL_UNMERGED_MINUTES,
  TTM_SLOW_FLAG_KINDS,
  TTM_STUCK_FLAG_KINDS,
  applyMeasuredTtmBudget,
  computeTtmBudget,
  derivePrTtmTimeline,
  ensureTtmTrackerSchema,
  evaluateTtmFromDb,
  evaluateTtmTimelines,
  resolveTtmTrackerConfig,
  runTtmTrackerTick,
  runTtmTrackerWatcherTick,
  summarizeTtmRollupFromTimelines,
  syncTtmFlags,
};
