const DEFAULT_TTM_BASE_BUDGET_MINUTES = 15;
const DEFAULT_TTM_PER_ROUND_BUDGET_MINUTES = 10;
const DEFAULT_TTM_TERMINAL_UNMERGED_MINUTES = 10;
const DEFAULT_TTM_ROLLUP_WINDOW_HOURS = 12;

const CLEAN_VERDICTS = new Set(['approved', 'comment-only']);
const REVIEW_PASS_KINDS = new Set(['first-pass', 'rereview']);

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
  return {
    baseBudgetMinutes: parsePositiveNumber(
      overrides.baseBudgetMinutes ?? env.ADVERSARIAL_TTM_BASE_BUDGET_MINUTES,
      DEFAULT_TTM_BASE_BUDGET_MINUTES
    ),
    perRoundBudgetMinutes: parsePositiveNumber(
      overrides.perRoundBudgetMinutes ?? env.ADVERSARIAL_TTM_PER_ROUND_BUDGET_MINUTES,
      DEFAULT_TTM_PER_ROUND_BUDGET_MINUTES
    ),
    terminalUnmergedMinutes: parsePositiveNumber(
      overrides.terminalUnmergedMinutes ?? env.ADVERSARIAL_TTM_TERMINAL_UNMERGED_MINUTES,
      DEFAULT_TTM_TERMINAL_UNMERGED_MINUTES
    ),
    rollupWindowHours: parsePositiveNumber(
      overrides.rollupWindowHours ?? env.ADVERSARIAL_TTM_ROLLUP_WINDOW_HOURS,
      DEFAULT_TTM_ROLLUP_WINDOW_HOURS
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
  };
}

function computeTtmBudget(reviewRounds, config) {
  return config.baseBudgetMinutes + Math.max(0, Number(reviewRounds) || 0) * config.perRoundBudgetMinutes;
}

function flagKeyFor(row, flagKind) {
  return `${row.repo}#${row.prNumber}:${flagKind}`;
}

function buildTtmFlag(row, flagKind, observedAt, config) {
  const budgetMinutes = computeTtmBudget(row.reviewRounds, config);
  return {
    eventKey: flagKeyFor(row, flagKind),
    repo: row.repo,
    prNumber: row.prNumber,
    flagKind,
    state: 'active',
    observedAt,
    openedAt: row.openedAt,
    settledAt: row.settledAt,
    mergedAt: row.mergedAt,
    elapsedMinutes: row.elapsedMinutes,
    budgetMinutes,
    terminalUnmergedMinutes: row.terminalUnmergedMinutes,
    reviewRounds: row.reviewRounds,
    details: {
      prState: row.prState,
      reviewStatus: row.reviewStatus,
      latestVerdict: row.latestVerdict,
      baseBudgetMinutes: config.baseBudgetMinutes,
      perRoundBudgetMinutes: config.perRoundBudgetMinutes,
      terminalUnmergedThresholdMinutes: config.terminalUnmergedMinutes,
    },
  };
}

function evaluateTtmTimelines(rows, { observedAt, config }) {
  const flags = [];
  for (const row of rows) {
    if (row.prState !== 'open') continue;
    const budgetMinutes = computeTtmBudget(row.reviewRounds, config);
    if (row.elapsedMinutes !== null && row.elapsedMinutes > budgetMinutes) {
      flags.push(buildTtmFlag(row, 'round_budget_breach', observedAt, config));
    }
    if (
      row.terminalClean
      && row.terminalUnmergedMinutes !== null
      && row.terminalUnmergedMinutes > config.terminalUnmergedMinutes
    ) {
      flags.push(buildTtmFlag(row, 'terminal_but_unmerged', observedAt, config));
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
              review_status, posted_at
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
}

function syncTtmFlags(db, flags, { observedAt }) {
  ensureTtmTrackerSchema(db);
  const activeKeys = new Set(flags.map((flag) => flag.eventKey));
  let activated = 0;
  let refreshed = 0;
  let resolved = 0;

  const tx = db.transaction(() => {
    for (const flag of flags) {
      const existing = db.prepare(
        'SELECT state FROM ttm_flag_state WHERE event_key = ?'
      ).get(flag.eventKey);
      if (!existing || existing.state !== 'active') {
        insertTtmFlagEvent(db, flag, 'active', observedAt);
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
      insertTtmFlagEvent(db, flag, 'resolved', observedAt);
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
  return { activated, refreshed, resolved, active: flags.length };
}

function summarizeTtmRollupFromTimelines(rows, { observedAt, config, eventRows = [] }) {
  const observedMs = toMs(observedAt);
  const windowStartMs = observedMs - config.rollupWindowHours * 60 * 60 * 1000;
  const mergedDurations = rows
    .filter((row) => row.mergedAt && toMs(row.mergedAt) >= windowStartMs)
    .map((row) => minutesBetween(row.openedAt, row.mergedAt))
    .filter((value) => value !== null);
  const openBreaches = evaluateTtmTimelines(rows, { observedAt, config })
    .filter((flag) => flag.flagKind === 'round_budget_breach');
  const terminalUnmerged = evaluateTtmTimelines(rows, { observedAt, config })
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
    openPrsBreachingBudget: openBreaches.length,
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

function evaluateTtmFromDb(db, {
  now = () => new Date(),
  env = process.env,
  config: configOverrides = {},
} = {}) {
  const observedAt = typeof now === 'function' ? now().toISOString() : new Date(now).toISOString();
  const config = resolveTtmTrackerConfig(env, configOverrides);
  const timelines = readTtmTimelines(db, { nowIso: observedAt });
  const flags = evaluateTtmTimelines(timelines, { observedAt, config });
  const eventRows = readRecentTtmFlagEvents(db, { observedAt, config });
  return {
    observedAt,
    config,
    timelines,
    flags,
    rollup: summarizeTtmRollupFromTimelines(timelines, { observedAt, config, eventRows }),
  };
}

function runTtmTrackerTick(db, options = {}) {
  const result = evaluateTtmFromDb(db, options);
  const sync = syncTtmFlags(db, result.flags, { observedAt: result.observedAt });
  const eventRows = readRecentTtmFlagEvents(db, {
    observedAt: result.observedAt,
    config: result.config,
  });
  return {
    ...result,
    sync,
    rollup: summarizeTtmRollupFromTimelines(result.timelines, {
      observedAt: result.observedAt,
      config: result.config,
      eventRows,
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
        + `budget_breaches=${ttm.rollup.openPrsBreachingBudget}`
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
  DEFAULT_TTM_ROLLUP_WINDOW_HOURS,
  DEFAULT_TTM_TERMINAL_UNMERGED_MINUTES,
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
