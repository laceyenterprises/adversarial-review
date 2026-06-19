import { execFile } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CODE_PR_DOMAIN_ID, makeCodePrSubjectExternalId } from './identity-shapes.mjs';
import { awaitThrottleIfNeeded } from './rate-limit-throttle.mjs';
import { ensureReviewCycleCapSchema } from './review-cycle-cap.mjs';

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_LIVE_PR_LOOKUP_TIMEOUT_MS = 15_000;
const REVIEW_STATE_SCHEMA_VERSION = 9;
const REVIEW_STATE_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const execFileAsyncDefault = promisify(execFile);
const REVIEW_STATE_TABLE_NAMES = new Set([
  'reviewed_prs',
  'comment_deliveries',
  'reviewer_passes',
  'pr_merge_closeouts',
  'review_cycle_verdicts',
  'review_cycle_counters',
]);

const REVIEWED_PRS_HEAD_SHA_COLUMNS = Object.freeze([
  'head_sha',
  'headSha',
  'head_ref_oid',
  'headRefOid',
]);

function openReviewStateDb(rootDir, { busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS } = {}) {
  mkdirSync(join(rootDir, 'data'), { recursive: true });
  const db = new Database(join(rootDir, 'data', 'reviews.db'));
  db.pragma(`busy_timeout = ${Math.max(0, Number(busyTimeoutMs) || 0)}`);
  return db;
}

function ensureReviewStateSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviewed_prs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      repo              TEXT NOT NULL,
      pr_number         INTEGER NOT NULL,
      domain_id         TEXT,
      subject_external_id TEXT,
      revision_ref      TEXT,
      reviewed_at       TEXT NOT NULL,
      reviewer          TEXT NOT NULL,
      pr_state          TEXT NOT NULL DEFAULT 'open',
      merged_at         TEXT,
      closed_at         TEXT,
      linear_ticket     TEXT,
      review_status     TEXT NOT NULL DEFAULT 'posted',
      review_attempts   INTEGER NOT NULL DEFAULT 0,
      last_attempted_at TEXT,
      posted_at         TEXT,
      failed_at         TEXT,
      failure_message   TEXT,
      rereview_requested_at TEXT,
      rereview_reason   TEXT,
      labels_json       TEXT,
      fast_merge_audit_status TEXT,
      fast_merge_audit_payload_json TEXT,
      fast_merge_audit_error TEXT,
      reviewer_session_uuid TEXT,
      reviewer_pgid     INTEGER,
      reviewer_started_at TEXT,
      reviewer_head_sha TEXT,
      reviewer_timeout_ms INTEGER,
      reviewer_lease_expires_at TEXT,
      UNIQUE(repo, pr_number)
    )
  `);

  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN pr_state TEXT NOT NULL DEFAULT 'open'`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN merged_at TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN closed_at TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN linear_ticket TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN review_status TEXT NOT NULL DEFAULT 'posted'`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN review_attempts INTEGER NOT NULL DEFAULT 0`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN last_attempted_at TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN posted_at TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN failed_at TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN failure_message TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN rereview_requested_at TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN rereview_reason TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN labels_json TEXT`);
  // `fast_merge_authorized_head_sha` is intentionally migration-owned by
  // 20260520_fast_merge_authorization.sql. The audit retry columns stay here
  // because a PR-branch build briefly created live DBs before the audit
  // sentinel existed; idempotent schema convergence is the only safe common
  // path for those DBs and fresh checkouts.
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN fast_merge_audit_status TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN fast_merge_audit_payload_json TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN fast_merge_audit_error TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN reviewer_session_uuid TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN reviewer_pgid INTEGER`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN reviewer_started_at TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN reviewer_head_sha TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN reviewer_timeout_ms INTEGER`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN reviewer_lease_expires_at TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN domain_id TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN subject_external_id TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN revision_ref TEXT`);

  backfillReviewedPRSubjectIdentity(db);

  runReviewStateMigrations(db);
  ensureReviewCycleCapSchema(db);
  // Handles DBs that briefly saw the inline reviewer_passes schema before the
  // migration runner became the canonical path.
  addColumnIfMissing(db, `ALTER TABLE reviewer_passes ADD COLUMN reviewer_model TEXT`);
  addColumnIfMissing(db, `ALTER TABLE reviewer_passes ADD COLUMN token_total INTEGER`);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS reviewed_prs_identity_round_kind_unique
      ON reviewed_prs(domain_id, subject_external_id, revision_ref);

    CREATE INDEX IF NOT EXISTS reviewed_prs_identity_lookup_idx
      ON reviewed_prs(domain_id, subject_external_id, revision_ref);

    PRAGMA user_version = ${REVIEW_STATE_SCHEMA_VERSION};
  `);
}

function getReviewRow(db, { repo, prNumber }) {
  return db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(repo, prNumber) || null;
}

function readLatestCompletedReviewerPassEndedAt(db, { repo, prNumber }) {
  // status = 'completed' is load-bearing — failed / failed-orphan passes
  // with an ended_at must NOT shift the closeout lower bound forward,
  // because no actual reviewer output landed for those passes. Operator
  // commentary posted between a failed pass and the eventual successful
  // re-review must remain inside the closeout window.
  return db.prepare(
    `SELECT MAX(ended_at) AS ended_at
       FROM reviewer_passes
      WHERE repo = ?
        AND pr_number = ?
        AND pass_kind IN ('first-pass', 'rereview')
        AND status = 'completed'
        AND ended_at IS NOT NULL`
  ).get(repo, prNumber)?.ended_at || null;
}

function readReviewerPassLogins(db, { repo, prNumber, reviewerLoginResolver = () => null } = {}) {
  const rows = db.prepare(
    `SELECT reviewer_class, reviewer_model
       FROM reviewer_passes
      WHERE repo = ?
        AND pr_number = ?
        AND pass_kind IN ('first-pass', 'rereview')`
  ).all(repo, prNumber);
  const logins = [];
  const seen = new Set();
  for (const row of rows) {
    for (const candidate of [row?.reviewer_model, row?.reviewer_class]) {
      const login = reviewerLoginResolver(candidate, row);
      const normalized = String(login || '').trim().toLowerCase();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      logins.push(login);
    }
  }
  return logins;
}

// Settled-empty rows are re-scraped on a slower cadence (default 1 hour)
// so a late closeout that lands past the 10-minute settle window still
// has a path to be observed and upgrade the row. Without this, the
// terminal-empty decision is permanent the first time it fires.
const SETTLED_EMPTY_RESCRAPE_AFTER_MS = 60 * 60 * 1000;
// Stop re-scraping settled-empty rows once they are this old past merge.
// Matches the scraper's post-merge comment-window cap (24h) so the
// pending list does not grow unboundedly over the lifetime of the daemon
// and we don't keep paying for `gh api` calls against month-old PRs.
const SETTLED_EMPTY_RESCRAPE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function listPendingMergeCloseouts(db, {
  limit = Number.POSITIVE_INFINITY,
  settledEmptyRescrapeAfterMs = SETTLED_EMPTY_RESCRAPE_AFTER_MS,
  settledEmptyRescrapeMaxAgeMs = SETTLED_EMPTY_RESCRAPE_MAX_AGE_MS,
  now = new Date(),
} = {}) {
  const rescrapeBeforeIso = new Date(now.getTime() - settledEmptyRescrapeAfterMs).toISOString();
  const maxAgeCutoffIso = new Date(now.getTime() - settledEmptyRescrapeMaxAgeMs).toISOString();
  // Fresh-debt first (never scraped or scraped but not settled), then
  // settled-empty rows that have aged past the rescrape threshold.
  // Within fresh debt, lower attempt counts win so chronic failures do
  // not monopolize the per-tick batch. Newest-merged first as a final
  // tiebreaker to prioritize the just-merged tail after a watcher
  // outage or gh blip.
  const rows = db.prepare(
    `SELECT reviewed_prs.repo,
            reviewed_prs.pr_number,
            reviewed_prs.merged_at,
            COALESCE(pr_merge_closeouts.scrape_attempt_count, 0) AS scrape_attempt_count,
            pr_merge_closeouts.empty_confirmed_at AS empty_confirmed_at,
            pr_merge_closeouts.scrape_last_checked_at AS scrape_last_checked_at
       FROM reviewed_prs
       LEFT JOIN pr_merge_closeouts
         ON pr_merge_closeouts.repo = reviewed_prs.repo
        AND pr_merge_closeouts.pr_number = reviewed_prs.pr_number
      WHERE reviewed_prs.pr_state = 'merged'
        AND (pr_merge_closeouts.closeout_body_md IS NULL)
        AND (
          pr_merge_closeouts.repo IS NULL
          OR pr_merge_closeouts.empty_confirmed_at IS NULL
          OR (
            (
              pr_merge_closeouts.scrape_last_checked_at IS NULL
              OR pr_merge_closeouts.scrape_last_checked_at <= ?
            )
            AND (
              reviewed_prs.merged_at IS NULL
              OR reviewed_prs.merged_at >= ?
            )
          )
        )
      ORDER BY
        CASE WHEN pr_merge_closeouts.empty_confirmed_at IS NULL THEN 0 ELSE 1 END ASC,
        COALESCE(pr_merge_closeouts.scrape_attempt_count, 0) ASC,
        reviewed_prs.merged_at DESC,
        reviewed_prs.id DESC`
  ).all(rescrapeBeforeIso, maxAgeCutoffIso);
  if (!Number.isFinite(limit)) return rows;
  return rows.slice(0, Math.max(0, Number(limit) || 0));
}

function recordMergeCloseoutScrapeFailure(db, {
  repo,
  prNumber,
  mergedAt = null,
  scrapeLastCheckedAt = new Date().toISOString(),
  errorMessage = null,
} = {}) {
  const truncatedError = errorMessage
    ? String(errorMessage).slice(0, 2000)
    : null;
  // gh_artifact_refs left NULL on the failure path. The 20260529 CHECK
  // forbids non-NULL refs when closeout_body_md is NULL, and a failed
  // scrape has neither a body nor artifacts to attribute — NULL is the
  // correct value regardless of whether 20260530 has rebuilt the table
  // to drop that CHECK.
  db.prepare(
    `INSERT INTO pr_merge_closeouts (
       repo,
       pr_number,
       scrape_last_checked_at,
       merged_at,
       scrape_attempt_count,
       scrape_last_error
     ) VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(repo, pr_number) DO UPDATE SET
       scrape_last_checked_at = excluded.scrape_last_checked_at,
       merged_at = COALESCE(pr_merge_closeouts.merged_at, excluded.merged_at),
       scrape_attempt_count = COALESCE(pr_merge_closeouts.scrape_attempt_count, 0) + 1,
       scrape_last_error = excluded.scrape_last_error`
  ).run(
    repo,
    prNumber,
    scrapeLastCheckedAt,
    mergedAt || null,
    truncatedError
  );
  return db.prepare(
    'SELECT * FROM pr_merge_closeouts WHERE repo = ? AND pr_number = ?'
  ).get(repo, prNumber) || null;
}

function recordMergeCloseout(db, {
  repo,
  prNumber,
  mergedAt,
  scrapeLastCheckedAt = new Date().toISOString(),
  closeoutBodyMd = null,
  closeoutAuthors = null,
  closeoutPostedAt = null,
  bodyCapturedAt = null,
  emptyConfirmedAt = null,
  ghArtifactRefs = null,
} = {}) {
  const hasBody = typeof closeoutBodyMd === 'string' && closeoutBodyMd.length > 0;
  const authorsJson = hasBody && Array.isArray(closeoutAuthors)
    ? JSON.stringify(closeoutAuthors)
    : null;
  const artifactRefsJson = JSON.stringify(Array.isArray(ghArtifactRefs) ? ghArtifactRefs : []);

  db.prepare(
    `INSERT INTO pr_merge_closeouts (
       repo,
       pr_number,
       closeout_body_md,
       closeout_authors_json,
       closeout_posted_at,
       body_captured_at,
       scrape_last_checked_at,
       empty_confirmed_at,
       merged_at,
       gh_artifact_refs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo, pr_number) DO UPDATE SET
       scrape_last_checked_at = excluded.scrape_last_checked_at,
       merged_at = COALESCE(pr_merge_closeouts.merged_at, excluded.merged_at),
       closeout_body_md = CASE
         WHEN excluded.closeout_body_md IS NOT NULL THEN excluded.closeout_body_md
         ELSE pr_merge_closeouts.closeout_body_md
       END,
       closeout_authors_json = CASE
         WHEN excluded.closeout_body_md IS NOT NULL THEN excluded.closeout_authors_json
         ELSE pr_merge_closeouts.closeout_authors_json
       END,
       closeout_posted_at = CASE
         WHEN excluded.closeout_body_md IS NOT NULL THEN excluded.closeout_posted_at
         ELSE pr_merge_closeouts.closeout_posted_at
       END,
       body_captured_at = CASE
         WHEN excluded.closeout_body_md IS NOT NULL THEN excluded.body_captured_at
         ELSE pr_merge_closeouts.body_captured_at
       END,
       empty_confirmed_at = CASE
         WHEN excluded.closeout_body_md IS NOT NULL THEN NULL
         WHEN pr_merge_closeouts.closeout_body_md IS NOT NULL THEN NULL
         WHEN excluded.empty_confirmed_at IS NOT NULL THEN COALESCE(pr_merge_closeouts.empty_confirmed_at, excluded.empty_confirmed_at)
         ELSE pr_merge_closeouts.empty_confirmed_at
       END,
       gh_artifact_refs = CASE
         WHEN excluded.closeout_body_md IS NOT NULL THEN excluded.gh_artifact_refs
         WHEN pr_merge_closeouts.gh_artifact_refs IS NOT NULL THEN pr_merge_closeouts.gh_artifact_refs
         ELSE excluded.gh_artifact_refs
       END,
       scrape_attempt_count = CASE
         -- Reset on any terminal success path: body captured OR settled-empty
         -- confirmed. Otherwise a row that accumulated N failures then recovered
         -- to settled-empty would keep a stale scrape_attempt_count forever and
         -- trigger triage dashboards / alerts that page on chronic-failure rows
         -- that have already recovered.
         WHEN excluded.closeout_body_md IS NOT NULL THEN 0
         WHEN excluded.empty_confirmed_at IS NOT NULL
              AND pr_merge_closeouts.closeout_body_md IS NULL THEN 0
         ELSE pr_merge_closeouts.scrape_attempt_count
       END,
       scrape_last_error = CASE
         WHEN excluded.closeout_body_md IS NOT NULL THEN NULL
         WHEN excluded.empty_confirmed_at IS NOT NULL
              AND pr_merge_closeouts.closeout_body_md IS NULL THEN NULL
         ELSE pr_merge_closeouts.scrape_last_error
       END`
  ).run(
    repo,
    prNumber,
    hasBody ? closeoutBodyMd : null,
    authorsJson,
    hasBody ? closeoutPostedAt : null,
    hasBody ? (bodyCapturedAt || scrapeLastCheckedAt) : null,
    scrapeLastCheckedAt,
    hasBody ? null : emptyConfirmedAt,
    mergedAt || null,
    artifactRefsJson
  );

  return db.prepare(
    'SELECT * FROM pr_merge_closeouts WHERE repo = ? AND pr_number = ?'
  ).get(repo, prNumber) || null;
}

function runReviewStateMigrations(db, { migrationsDir = REVIEW_STATE_MIGRATIONS_DIR } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  let migrationNames;
  try {
    migrationNames = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort();
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  const hasMigration = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?');
  const recordMigration = db.prepare('INSERT OR IGNORE INTO schema_migrations(id) VALUES (?)');
  for (const name of migrationNames) {
    if (hasMigration.get(name)) continue;
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    const applyMigration = db.transaction(() => {
      execIdempotentMigrationSql(db, sql);
      recordMigration.run(name);
    });
    applyMigration();
  }
}

function execIdempotentMigrationSql(db, sql) {
  try {
    db.exec(sql);
    return;
  } catch (err) {
    if (!(err?.code === 'SQLITE_ERROR' && /duplicate column name/i.test(err.message || ''))) throw err;
  }
  for (const statement of splitSqlStatements(sql)) {
    try {
      db.exec(statement);
    } catch (err) {
      if (err?.code === 'SQLITE_ERROR' && /duplicate column name/i.test(err.message || '')) continue;
      throw err;
    }
  }
}

function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let quote = null;
  let inTrigger = false;
  for (const char of stripSqlComments(sql)) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char !== ';') {
      current += char;
      continue;
    }
    const statement = current.trim();
    if (!statement) {
      current = '';
      continue;
    }
    if (!inTrigger && /^CREATE\s+TRIGGER\b/i.test(statement) && !/\bEND\s*$/i.test(statement)) {
      inTrigger = true;
      current += char;
      continue;
    }
    if (inTrigger && !/\bEND\s*$/i.test(statement)) {
      current += char;
      continue;
    }
    statements.push(`${statement};`);
    current = '';
    inTrigger = false;
  }
  const trailing = current.trim();
  if (trailing) statements.push(trailing);
  return statements;
}

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '');
}

function addReviewedPRsColumnIfMissing(db, sql) {
  addColumnIfMissing(db, sql);
}

function addColumnIfMissing(db, sql) {
  try {
    db.exec(sql);
  } catch (err) {
    if (err?.code === 'SQLITE_ERROR' && /duplicate column name/i.test(err.message || '')) return;
    throw err;
  }
}

function assertKnownReviewStateTableName(tableName) {
  const value = String(tableName || '');
  if (!REVIEW_STATE_TABLE_NAMES.has(value)) {
    throw new TypeError(`Unknown review-state table name: ${tableName}`);
  }
  return value;
}

function tableColumns(db, tableName) {
  const safeTableName = assertKnownReviewStateTableName(tableName);
  return db.prepare(`PRAGMA table_info("${safeTableName}")`).all().map((column) => column.name);
}

function pickExistingColumn(db, tableName, candidates) {
  const columnSet = new Set(tableColumns(db, tableName));
  return candidates.find((candidate) => columnSet.has(candidate)) || null;
}

function backfillReviewedPRSubjectIdentity(db) {
  const headShaColumn = pickExistingColumn(db, 'reviewed_prs', REVIEWED_PRS_HEAD_SHA_COLUMNS);
  const revisionExpr = headShaColumn ? `"${headShaColumn}"` : 'NULL';

  db.prepare(
    `UPDATE reviewed_prs
        SET domain_id = ?,
            subject_external_id = repo || '#' || pr_number,
            revision_ref = ${revisionExpr}
      WHERE domain_id IS NULL
        AND repo IS NOT NULL
        AND pr_number IS NOT NULL`
  ).run(CODE_PR_DOMAIN_ID);
}

function normalizeSubjectIdentity({ domainId, domain_id, subjectExternalId, subject_external_id, revisionRef, revision_ref } = {}) {
  return {
    domainId: domainId ?? domain_id ?? null,
    subjectExternalId: subjectExternalId ?? subject_external_id ?? null,
    revisionRef: revisionRef ?? revision_ref ?? null,
  };
}

function getReviewRowBySubjectIdentity(db, identity) {
  const { domainId, subjectExternalId, revisionRef } = normalizeSubjectIdentity(identity);
  if (!domainId || !subjectExternalId || !revisionRef) return null;
  return db.prepare(
    `SELECT *
       FROM reviewed_prs
      WHERE domain_id = ?
        AND subject_external_id = ?
        AND revision_ref = ?
      ORDER BY id DESC
      LIMIT 1`
  ).get(domainId, subjectExternalId, revisionRef) || null;
}

function lookupReviewRowDualRead(db, {
  repo,
  prNumber,
  domainId,
  subjectExternalId,
  revisionRef,
  legacyRevisionProven = false,
} = {}) {
  // Reserved for the LAC-491 typed-identity read migration. Current hot
  // paths still read by legacy repo/pr_number while writes backfill the new
  // identity columns; keep this helper available so the gate/follow-up readers
  // can switch call sites incrementally without changing the exported surface.
  const normalizedSubjectExternalId = subjectExternalId || makeCodePrSubjectExternalId(repo, prNumber);
  const typedRow = getReviewRowBySubjectIdentity(db, {
    domainId: domainId || (normalizedSubjectExternalId ? CODE_PR_DOMAIN_ID : null),
    subjectExternalId: normalizedSubjectExternalId,
    revisionRef,
  });
  if (typedRow) {
    return { found: true, source: 'typed', row: typedRow };
  }

  const legacyRow = repo && prNumber ? getReviewRow(db, { repo, prNumber }) : null;
  if (!legacyRow) {
    return { found: false, source: null, row: null };
  }

  const legacyRevisionMatches = revisionRef
    && legacyRow.revision_ref
    && String(legacyRow.revision_ref) === String(revisionRef);
  if (legacyRevisionMatches || legacyRevisionProven) {
    return { found: true, source: 'legacy', row: legacyRow };
  }

  return {
    found: false,
    source: null,
    row: null,
    legacyRow,
    reason: 'legacy-row-unproven-revision',
  };
}

function hasReviewRowForSubject(db, options = {}) {
  return lookupReviewRowDualRead(db, options).found;
}

// Read just the PR-lifecycle columns the watcher's syncPRLifecycle
// keeps current. Used by the follow-up daemon to short-circuit work
// on PRs the operator has already merged or closed — no point
// spawning a remediation worker, posting a comment, or resetting
// the watcher row when the PR is no longer accepting changes.
//
// Returns null when no review row exists yet (e.g. a fresh repo or
// a job created before the watcher saw the PR). Callers should
// treat null as "proceed with existing behavior" — the merge gate
// is a positive opt-in, not a default-deny gate.
function readPRState(rootDir, { repo, prNumber }) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const row = db
      .prepare('SELECT pr_state, merged_at, closed_at, labels_json FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
      .get(repo, prNumber);
    if (!row) return null;
    let labels = [];
    try {
      const parsed = JSON.parse(row.labels_json || '[]');
      if (Array.isArray(parsed)) labels = parsed;
    } catch {
      labels = [];
    }
    return {
      prState: row.pr_state || 'open',
      mergedAt: row.merged_at || null,
      closedAt: row.closed_at || null,
      labels,
    };
  } finally {
    db.close();
  }
}

// GitHub returns PR state as `OPEN | CLOSED | MERGED`. Our mirror stores
// the lowercase form. Keep this map small and explicit so an unexpected
// value (future GitHub state, typo) surfaces as null instead of being
// silently coerced — callers fall back to the SQLite mirror in that case.
function normalizeGhPrState(rawState) {
  if (typeof rawState !== 'string') return null;
  const upper = rawState.toUpperCase();
  if (upper === 'OPEN') return 'open';
  if (upper === 'MERGED') return 'merged';
  if (upper === 'CLOSED') return 'closed';
  return null;
}

// Live GitHub PR-state lookup via `gh pr view`. Used by the follow-up
// daemon at the consume/reconcile decision points to close the race the
// SQLite mirror cannot: the watcher's syncPRLifecycle poll runs on its
// own cadence, so the mirror can lag GitHub by minutes. A merged or
// closed PR observed live here means the daemon should stop the job
// even if reviews.db still says `open`.
//
// Returns:
//   - { source: 'live', prState, mergedAt, closedAt, headSha } on a
//     successful lookup (mergedAt/closedAt/headSha may be null if
//     GitHub returns empty)
//   - null on any failure (gh missing, auth fail, network blip, weird
//     state value). Callers must treat null as "live lookup unavailable"
//     and fall back to the mirror — the gate degrades to its previous
//     behavior, never to "spawn anyway with no information".
async function fetchLivePRLifecycle({
  repo,
  prNumber,
  execFileImpl = execFileAsyncDefault,
  timeoutMs = DEFAULT_LIVE_PR_LOOKUP_TIMEOUT_MS,
} = {}) {
  if (!repo || !prNumber) return null;
  let stdout;
  try {
    await awaitThrottleIfNeeded();
    const result = await execFileImpl(
      'gh',
      [
        'pr',
        'view',
        String(prNumber),
        '--repo',
        repo,
        '--json',
        'state,mergedAt,closedAt,labels,headRefOid',
      ],
      {
        maxBuffer: 1 * 1024 * 1024,
        timeout: timeoutMs,
      }
    );
    stdout = result?.stdout;
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(String(stdout || '').trim() || '{}');
  } catch {
    return null;
  }

  const prState = normalizeGhPrState(parsed.state);
  if (!prState) return null;

  return {
    source: 'live',
    prState,
    mergedAt: parsed.mergedAt || null,
    closedAt: parsed.closedAt || null,
    labels: Array.isArray(parsed.labels) ? parsed.labels : [],
    headSha: parsed.headRefOid || null,
  };
}

// Persist a live lifecycle observation back to the SQLite mirror so the
// watcher's view of the PR matches what we just learned and other parts
// of the system (e.g. requestReviewRereview's pr_state guardrail) see a
// consistent picture. No-op when there's no review row yet — we don't
// fabricate one because the watcher owns row creation.
function persistPRStateToMirror(rootDir, { repo, prNumber, prState, mergedAt, closedAt, labels }) {
  if (prState !== 'merged' && prState !== 'closed' && prState !== 'open') return;
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const existing = db
      .prepare('SELECT id FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
      .get(repo, prNumber);
    if (!existing) return;

    if (prState === 'merged') {
      db.prepare(
        "UPDATE reviewed_prs SET pr_state = 'merged', merged_at = COALESCE(?, merged_at), labels_json = COALESCE(?, labels_json) WHERE repo = ? AND pr_number = ?"
      ).run(mergedAt || null, Array.isArray(labels) ? JSON.stringify(labels) : null, repo, prNumber);
    } else if (prState === 'closed') {
      db.prepare(
        "UPDATE reviewed_prs SET pr_state = 'closed', closed_at = COALESCE(?, closed_at), labels_json = COALESCE(?, labels_json) WHERE repo = ? AND pr_number = ?"
      ).run(closedAt || null, Array.isArray(labels) ? JSON.stringify(labels) : null, repo, prNumber);
    } else {
      db.prepare(
        "UPDATE reviewed_prs SET pr_state = 'open', labels_json = COALESCE(?, labels_json) WHERE repo = ? AND pr_number = ?"
      ).run(Array.isArray(labels) ? JSON.stringify(labels) : null, repo, prNumber);
    }
  } finally {
    db.close();
  }
}

// Authoritative resolver for "what is this PR's current lifecycle state?"
// at consume/reconcile boundaries. Live lookup first; on success, the
// mirror is updated so the next tick (and requestReviewRereview's open-
// state guardrail) agree. On any live-lookup failure, falls back to the
// mirror via readPRState — degrades to the prior behavior rather than
// punching through with "open" when we have no information.
//
// Returns:
//   - { source: 'live' | 'mirror', prState, mergedAt, closedAt, labels } when we
//     have a state we trust (live succeeded, or mirror had a row)
//   - null when neither source returns information; callers treat this
//     as "proceed with existing behavior" because the gate is positive
//     opt-in, not default-deny.
async function resolvePRLifecycle(rootDir, {
  repo,
  prNumber,
  execFileImpl = execFileAsyncDefault,
  liveLookupTimeoutMs = DEFAULT_LIVE_PR_LOOKUP_TIMEOUT_MS,
} = {}) {
  const live = await fetchLivePRLifecycle({
    repo,
    prNumber,
    execFileImpl,
    timeoutMs: liveLookupTimeoutMs,
  });
  if (live) {
    try {
      persistPRStateToMirror(rootDir, {
        repo,
        prNumber,
        prState: live.prState,
        mergedAt: live.mergedAt,
        closedAt: live.closedAt,
        labels: live.labels,
      });
    } catch {
      // Persisting back to the mirror is best-effort. If the DB is
      // momentarily locked or unwritable, the live result is still the
      // truth callers need to act on — the next tick will refresh the
      // mirror anyway.
    }
    return live;
  }

  let cached;
  try {
    cached = readPRState(rootDir, { repo, prNumber });
  } catch {
    cached = null;
  }
  if (!cached) return null;
  return { source: 'mirror', ...cached };
}

function buildBlockedRereviewResult(reason, reviewRow = null, extra = {}) {
  return {
    triggered: false,
    status: 'blocked',
    reason,
    reviewRow,
    ...extra,
  };
}

function requestReviewRereview({
  rootDir,
  repo,
  prNumber,
  requestedAt = new Date().toISOString(),
  reason,
  allowFastMergeSkipped = false,
  db: dbOverride = null,
}) {
  const db = dbOverride || openReviewStateDb(rootDir);

  try {
    if (!dbOverride) {
      ensureReviewStateSchema(db);
    }

    // Single compare-and-swap UPDATE with the eligibility predicate
    // baked in. The previous SELECT-then-UPDATE shape had a
    // cross-process race: between reading `review_status` and
    // performing the unconditional UPDATE, the watcher could claim
    // the row (flipping it to `'reviewing'`). The unconditional UPDATE
    // would then overwrite the live claim back to `'pending'`,
    // recreating the duplicate-spawn race the watcher's in-flight
    // claim was introduced to prevent.
    //
    // The CAS below refuses to reset:
    //   - `'reviewing'` — the watcher has an active reviewer subprocess.
    //     The recovery path is letting the watcher restart and run
    //     reconcileOrphanedReviewing, which reattaches, recovers a
    //     posted review, or moves the row to a retryable/sticky failure
    //     according to the durable reviewer handle.
    //   - `'malformed'` — terminal; not a runtime-recoverable state.
    //   - `'pending'` — already armed for review; no reset needed.
    //
    // Any non-matching row is then re-read to classify why the CAS
    // failed (so callers get the same blocked-reason taxonomy as
    // before). The classification read happens AFTER the UPDATE, so a
    // racing claim can no longer slip in between the check and the
    // mutation.
    const allowedPrStatePredicate = allowFastMergeSkipped
      ? "pr_state IN ('open', 'fast_merge_skipped')"
      : "pr_state = 'open'";
    const updateResult = db.prepare(
      `UPDATE reviewed_prs
         SET review_status = 'pending',
             pr_state = 'open',
             posted_at = NULL,
             failed_at = NULL,
             failure_message = NULL,
             infra_auto_recover_attempts = 0,
             rereview_requested_at = ?,
             rereview_reason = ?
       WHERE repo = ?
         AND pr_number = ?
         AND ${allowedPrStatePredicate}
         AND review_status NOT IN ('reviewing', 'malformed', 'pending')`
    ).run(
      requestedAt,
      reason || 'Re-review requested from remediation reply.',
      repo,
      prNumber
    );

    if (updateResult.changes === 1) {
      return {
        triggered: true,
        status: 'pending',
        reason: 'review-status-reset',
        reviewRow: getReviewRow(db, { repo, prNumber }),
      };
    }

    // CAS lost. Read the row and classify why so the caller gets a
    // useful blocked-reason instead of a generic failure. The order
    // of the checks below mirrors the pre-CAS implementation so
    // reasons stay backward-compatible with existing callers
    // (reconcile path, retrigger-review CLI, comment renderer).
    const reviewRow = getReviewRow(db, { repo, prNumber });
    if (!reviewRow) {
      return buildBlockedRereviewResult('review-row-missing');
    }
    if (reviewRow.review_status === 'malformed') {
      return buildBlockedRereviewResult('malformed-title-terminal', reviewRow);
    }
    if (reviewRow.review_status === 'reviewing') {
      return buildBlockedRereviewResult('review-in-flight', reviewRow);
    }
    if (reviewRow.pr_state !== 'open') {
      return buildBlockedRereviewResult('pr-not-open', reviewRow);
    }
    if (reviewRow.review_status === 'pending') {
      return {
        triggered: false,
        status: 'already-pending',
        reason: 'review-already-pending',
        reviewRow,
      };
    }
    // Defensive: this branch is unreachable today (every status the
    // CAS rejects is enumerated above), but if a future review_status
    // value is added without updating the CAS predicate, surface it
    // here instead of silently returning success.
    return buildBlockedRereviewResult('rereview-cas-no-match', reviewRow);
  } finally {
    if (!dbOverride) {
      db.close();
    }
  }
}

export {
  REVIEW_STATE_SCHEMA_VERSION,
  SETTLED_EMPTY_RESCRAPE_AFTER_MS,
  ensureReviewStateSchema,
  listPendingMergeCloseouts,
  openReviewStateDb,
  readLatestCompletedReviewerPassEndedAt,
  readReviewerPassLogins,
  recordMergeCloseout,
  recordMergeCloseoutScrapeFailure,
  getReviewRow,
  getReviewRowBySubjectIdentity,
  lookupReviewRowDualRead,
  hasReviewRowForSubject,
  readPRState,
  fetchLivePRLifecycle,
  persistPRStateToMirror,
  resolvePRLifecycle,
  requestReviewRereview,
};
