export const DEFAULT_REVIEW_CYCLE_CAP = 5;
export const DEFAULT_REVIEW_CYCLE_WINDOW_HOURS = 24;
export const REVIEWER_CYCLE_CAP_REACHED_LABEL = 'reviewer-cycle-cap-reached';
export const PAUSED_FOR_REDESIGN_LABEL = 'paused-for-redesign';
export const REVIEW_CYCLE_OVERRIDE_LABELS = Object.freeze([
  'operator-approved',
  'merge-agent-requested',
  PAUSED_FOR_REDESIGN_LABEL,
]);

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isoMinute(value) {
  const parsed = parseDate(value) || new Date();
  return parsed.toISOString().replace(/:\d\d\.\d\d\dZ$/, 'Z');
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function resolveReviewCycleCapConfig({
  loadedConfig = null,
  loadConfigImpl = null,
  logger = console,
} = {}) {
  let cfg = loadedConfig;
  if (!cfg && typeof loadConfigImpl === 'function') {
    try {
      cfg = loadConfigImpl();
    } catch (err) {
      logger?.warn?.(
        `[review-cycle-cap] config load failed; using defaults: ${err?.message || err}`
      );
    }
  }
  const getter = typeof cfg?.get === 'function'
    ? (key, fallback) => cfg.get(key, fallback)
    : (_key, fallback) => fallback;
  return {
    cap: normalizePositiveInt(
      getter('review_cycle_cap', DEFAULT_REVIEW_CYCLE_CAP),
      DEFAULT_REVIEW_CYCLE_CAP,
    ),
    windowHours: normalizePositiveInt(
      getter('review_cycle_window_hours', DEFAULT_REVIEW_CYCLE_WINDOW_HOURS),
      DEFAULT_REVIEW_CYCLE_WINDOW_HOURS,
    ),
  };
}

export function reviewCyclePrUrl({ repo, prNumber } = {}) {
  const normalizedRepo = String(repo || '').trim();
  const normalizedPr = Number(prNumber);
  if (!normalizedRepo || !Number.isInteger(normalizedPr) || normalizedPr <= 0) {
    throw new TypeError(`Invalid PR identity for review cycle cap: ${repo}#${prNumber}`);
  }
  return `https://github.com/${normalizedRepo}/pull/${normalizedPr}`;
}

export function ensureReviewCycleCapSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_cycle_verdicts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_url          TEXT NOT NULL,
      head_sha        TEXT NOT NULL,
      verdict_count   INTEGER NOT NULL,
      verdict_at      TEXT NOT NULL,
      verdict_summary TEXT NOT NULL DEFAULT '',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(pr_url, head_sha, verdict_at)
    );

    CREATE INDEX IF NOT EXISTS idx_review_cycle_verdicts_pr_time
      ON review_cycle_verdicts(pr_url, verdict_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS review_cycle_counters (
      pr_url          TEXT NOT NULL,
      head_sha        TEXT NOT NULL,
      verdict_count   INTEGER NOT NULL,
      last_verdict_at TEXT NOT NULL,
      escalated_at    TEXT,
      PRIMARY KEY (pr_url, head_sha)
    );
  `);
}

function latestReviewCycleVerdict(db, prUrl) {
  return db.prepare(
    `SELECT *
       FROM review_cycle_verdicts
      WHERE pr_url = ?
      ORDER BY verdict_at DESC, id DESC
      LIMIT 1`
  ).get(prUrl) || null;
}

export function summarizeReviewCycleVerdict(body, limit = 180) {
  const text = String(body || '').trim();
  if (!text) return 'No verdict summary captured.';
  const summary = text.match(/(?:^|\n)##\s+Summary\s*\n([\s\S]*?)(?=\n##\s+|$)/i)?.[1]?.trim()
    || text.match(/(?:^|\n)##\s+Verdict\s*\n([\s\S]*?)(?=\n##\s+|$)/i)?.[1]?.trim()
    || text;
  return summary.replace(/\s+/g, ' ').slice(0, Math.max(20, limit));
}

function nextCountFromPrevious(previous, { headSha, verdictAt, windowHours }) {
  if (!previous) return 1;
  const lastAt = parseDate(previous.last_verdict_at || previous.verdict_at);
  const now = parseDate(verdictAt) || new Date();
  const windowMs = normalizePositiveInt(windowHours, DEFAULT_REVIEW_CYCLE_WINDOW_HOURS) * 60 * 60 * 1000;
  if (!lastAt || now.getTime() - lastAt.getTime() > windowMs) return 1;
  if (String(previous.head_sha || '') === String(headSha || '')) {
    return normalizePositiveInt(previous.verdict_count, 1);
  }
  return normalizePositiveInt(previous.verdict_count, 1) + 1;
}

export function previewReviewCycleCount(db, {
  repo,
  prNumber,
  headSha,
  now = new Date().toISOString(),
  windowHours = DEFAULT_REVIEW_CYCLE_WINDOW_HOURS,
} = {}) {
  if (!headSha) return { count: 1, previous: null, prUrl: reviewCyclePrUrl({ repo, prNumber }) };
  const prUrl = reviewCyclePrUrl({ repo, prNumber });
  const previous = latestReviewCycleVerdict(db, prUrl);
  return {
    prUrl,
    previous,
    count: nextCountFromPrevious(previous, {
      headSha,
      verdictAt: now,
      windowHours,
    }),
  };
}

export function recordReviewCycleVerdict(db, {
  repo,
  prNumber,
  headSha,
  verdictAt = new Date().toISOString(),
  verdictSummary = '',
  windowHours = DEFAULT_REVIEW_CYCLE_WINDOW_HOURS,
} = {}) {
  if (!headSha) return { recorded: false, reason: 'missing-head-sha' };
  const prUrl = reviewCyclePrUrl({ repo, prNumber });
  ensureReviewCycleCapSchema(db);
  const previous = latestReviewCycleVerdict(db, prUrl);
  const count = nextCountFromPrevious(previous, {
    headSha,
    verdictAt,
    windowHours,
  });
  db.prepare(
    `INSERT OR IGNORE INTO review_cycle_verdicts (
       pr_url, head_sha, verdict_count, verdict_at, verdict_summary
     ) VALUES (?, ?, ?, ?, ?)`
  ).run(prUrl, String(headSha), count, verdictAt, summarizeReviewCycleVerdict(verdictSummary));
  db.prepare(
    `INSERT INTO review_cycle_counters (
       pr_url, head_sha, verdict_count, last_verdict_at, escalated_at
     ) VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(pr_url, head_sha) DO UPDATE SET
       verdict_count = excluded.verdict_count,
       last_verdict_at = excluded.last_verdict_at`
  ).run(prUrl, String(headSha), count, verdictAt);
  return { recorded: true, prUrl, count };
}

export function recentReviewCycleVerdicts(db, {
  repo,
  prNumber,
  limit = DEFAULT_REVIEW_CYCLE_CAP,
} = {}) {
  const prUrl = reviewCyclePrUrl({ repo, prNumber });
  return db.prepare(
    `SELECT verdict_at, verdict_summary, head_sha, verdict_count
       FROM review_cycle_verdicts
      WHERE pr_url = ?
      ORDER BY verdict_at DESC, id DESC
      LIMIT ?`
  ).all(prUrl, Math.max(1, Number(limit) || DEFAULT_REVIEW_CYCLE_CAP)).reverse();
}

export function buildReviewCycleCapEscalationComment({
  cap = DEFAULT_REVIEW_CYCLE_CAP,
  recentVerdicts = [],
} = {}) {
  const normalizedCap = normalizePositiveInt(cap, DEFAULT_REVIEW_CYCLE_CAP);
  const recent = Array.isArray(recentVerdicts) ? recentVerdicts.slice(-normalizedCap) : [];
  const verdictLines = recent.length
    ? recent.map((row) => `- ${isoMinute(row.verdict_at)}: ${summarizeReviewCycleVerdict(row.verdict_summary)}`).join('\n')
    : '- No recent verdict summaries were captured.';
  return `**🚨 Review cycle cap reached — operator attention required**

This PR has gone through ${normalizedCap} successive review-then-remediate cycles without
converging to a clean verdict. To prevent the runaway pattern documented in
the 2026-06-03 codex TUI postmortem, automatic review is paused.

Recent verdicts:
${verdictLines}

Please choose one:
1. Approve as-is: add label \`operator-approved\`.
2. Force the merge-agent: add label \`merge-agent-requested\` (existing flow).
3. Pause for redesign: add label \`paused-for-redesign\`.

Once labeled, the watcher will respect the choice.`;
}

export function markReviewCycleEscalated(db, {
  repo,
  prNumber,
  headSha,
  escalatedAt = new Date().toISOString(),
} = {}) {
  if (!headSha) return { marked: false, reason: 'missing-head-sha' };
  const prUrl = reviewCyclePrUrl({ repo, prNumber });
  ensureReviewCycleCapSchema(db);
  const existing = db.prepare(
    'SELECT * FROM review_cycle_counters WHERE pr_url = ? ORDER BY escalated_at IS NULL, escalated_at DESC LIMIT 1'
  ).get(prUrl);
  if (!existing) {
    db.prepare(
      `INSERT INTO review_cycle_counters (
         pr_url, head_sha, verdict_count, last_verdict_at, escalated_at
       ) VALUES (?, ?, 0, ?, ?)`
    ).run(prUrl, String(headSha), escalatedAt, escalatedAt);
  } else {
    db.prepare(
      `UPDATE review_cycle_counters
          SET escalated_at = COALESCE(escalated_at, ?)
        WHERE pr_url = ?`
    ).run(escalatedAt, prUrl);
  }
  return { marked: true, prUrl };
}

export function hasReviewCycleEscalated(db, { repo, prNumber } = {}) {
  const prUrl = reviewCyclePrUrl({ repo, prNumber });
  const row = db.prepare(
    'SELECT escalated_at FROM review_cycle_counters WHERE pr_url = ? AND escalated_at IS NOT NULL LIMIT 1'
  ).get(prUrl);
  return Boolean(row?.escalated_at);
}

export function resetReviewCycleCounter(db, { repo, prNumber, headSha = null } = {}) {
  const prUrl = reviewCyclePrUrl({ repo, prNumber });
  ensureReviewCycleCapSchema(db);
  if (headSha) {
    db.prepare('DELETE FROM review_cycle_counters WHERE pr_url = ? AND head_sha = ?')
      .run(prUrl, String(headSha));
    db.prepare('DELETE FROM review_cycle_verdicts WHERE pr_url = ? AND head_sha = ?')
      .run(prUrl, String(headSha));
  } else {
    db.prepare('DELETE FROM review_cycle_counters WHERE pr_url = ?').run(prUrl);
    db.prepare('DELETE FROM review_cycle_verdicts WHERE pr_url = ?').run(prUrl);
  }
  return { reset: true, prUrl };
}

export function shouldEscalateReviewCycle(db, {
  repo,
  prNumber,
  headSha,
  cap = DEFAULT_REVIEW_CYCLE_CAP,
  windowHours = DEFAULT_REVIEW_CYCLE_WINDOW_HOURS,
  now = new Date().toISOString(),
} = {}) {
  const preview = previewReviewCycleCount(db, {
    repo,
    prNumber,
    headSha,
    now,
    windowHours,
  });
  const normalizedCap = normalizePositiveInt(cap, DEFAULT_REVIEW_CYCLE_CAP);
  return {
    ...preview,
    cap: normalizedCap,
    escalate: preview.count > normalizedCap,
    alreadyEscalated: hasReviewCycleEscalated(db, { repo, prNumber, headSha }),
  };
}
