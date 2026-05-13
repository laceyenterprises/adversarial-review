import { execFile } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CODE_PR_DOMAIN_ID, makeCodePrSubjectExternalId } from './identity-shapes.mjs';

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_LIVE_PR_LOOKUP_TIMEOUT_MS = 15_000;
const REVIEW_STATE_SCHEMA_VERSION = 3;
const execFileAsyncDefault = promisify(execFile);
const REVIEW_STATE_TABLE_NAMES = new Set(['reviewed_prs']);

const REVIEWED_PRS_HEAD_SHA_COLUMNS = Object.freeze([
  'head_sha',
  'headSha',
  'head_ref_oid',
  'headRefOid',
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
<<<<<<< HEAD
      repo              TEXT NOT NULL,
      pr_number         INTEGER NOT NULL,
=======
<<<<<<< HEAD
      repo              TEXT,
      pr_number         INTEGER,
=======
      repo              TEXT NOT NULL,
      pr_number         INTEGER NOT NULL,
>>>>>>> 300a5a9bfeca7a20c52f1f012bc469f95d3ba7c1
>>>>>>> c5a3ac535212096835e70aa72c2c8d0f137a577b
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
      reviewer_session_uuid TEXT,
      reviewer_pgid     INTEGER,
      reviewer_started_at TEXT,
      reviewer_head_sha TEXT,
      UNIQUE(repo, pr_number)
    )
  `);

<<<<<<< HEAD
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN pr_state TEXT NOT NULL DEFAULT 'open'`); } catch {}
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN merged_at TEXT`); } catch {}
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN closed_at TEXT`); } catch {}
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN linear_ticket TEXT`); } catch {}
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN review_status TEXT NOT NULL DEFAULT 'posted'`); } catch {}
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN review_attempts INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN last_attempted_at TEXT`); } catch {}
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN posted_at TEXT`); } catch {}
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN failed_at TEXT`); } catch {}
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN failure_message TEXT`); } catch {}
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN rereview_requested_at TEXT`); } catch {}
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN rereview_reason TEXT`); } catch {}
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN labels_json TEXT`); } catch {}
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN reviewer_session_uuid TEXT`); } catch {}
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN reviewer_pgid INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN reviewer_started_at TEXT`); } catch {}
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN reviewer_head_sha TEXT`); } catch {}
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN domain_id TEXT`); } catch {}
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN subject_external_id TEXT`); } catch {}
  try { db.exec(`ALTER TABLE reviewed_prs ADD COLUMN revision_ref TEXT`); } catch {}
=======
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
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN reviewer_session_uuid TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN reviewer_pgid INTEGER`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN reviewer_started_at TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN reviewer_head_sha TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN domain_id TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN subject_external_id TEXT`);
  addReviewedPRsColumnIfMissing(db, `ALTER TABLE reviewed_prs ADD COLUMN revision_ref TEXT`);
>>>>>>> 300a5a9bfeca7a20c52f1f012bc469f95d3ba7c1

  backfillReviewedPRSubjectIdentity(db);

  db.exec(`
<<<<<<< HEAD
    DROP INDEX IF EXISTS reviewed_prs_identity_round_kind_unique;
=======
<<<<<<< HEAD
    CREATE UNIQUE INDEX IF NOT EXISTS reviewed_prs_identity_round_kind_unique
      ON reviewed_prs(domain_id, subject_external_id, revision_ref, review_attempts, review_status)
      WHERE domain_id IS NOT NULL
        AND subject_external_id IS NOT NULL
        AND revision_ref IS NOT NULL;
=======
    DROP INDEX IF EXISTS reviewed_prs_identity_round_kind_unique;
>>>>>>> 300a5a9bfeca7a20c52f1f012bc469f95d3ba7c1
>>>>>>> c5a3ac535212096835e70aa72c2c8d0f137a577b

    CREATE INDEX IF NOT EXISTS reviewed_prs_identity_lookup_idx
      ON reviewed_prs(domain_id, subject_external_id, revision_ref);

    PRAGMA user_version = ${REVIEW_STATE_SCHEMA_VERSION};
  `);
}

function getReviewRow(db, { repo, prNumber }) {
  return db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(repo, prNumber) || null;
}

<<<<<<< HEAD
function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name);
=======
function addReviewedPRsColumnIfMissing(db, sql) {
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
>>>>>>> 300a5a9bfeca7a20c52f1f012bc469f95d3ba7c1
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
<<<<<<< HEAD
=======
  // Reserved for the LAC-491 typed-identity read migration. Current hot
  // paths still read by legacy repo/pr_number while writes backfill the new
  // identity columns; keep this helper available so the gate/follow-up readers
  // can switch call sites incrementally without changing the exported surface.
>>>>>>> 300a5a9bfeca7a20c52f1f012bc469f95d3ba7c1
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
//   - { source: 'live', prState, mergedAt, closedAt } on a successful
//     lookup (mergedAt/closedAt may be null if GitHub returns empty)
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
    const result = await execFileImpl(
      'gh',
      [
        'pr',
        'view',
        String(prNumber),
        '--repo',
        repo,
        '--json',
        'state,mergedAt,closedAt,labels',
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
}) {
  const db = openReviewStateDb(rootDir);

  try {
    ensureReviewStateSchema(db);

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
    const updateResult = db.prepare(
      `UPDATE reviewed_prs
         SET review_status = 'pending',
             posted_at = NULL,
             failed_at = NULL,
             failure_message = NULL,
             rereview_requested_at = ?,
             rereview_reason = ?
       WHERE repo = ?
         AND pr_number = ?
         AND pr_state = 'open'
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
    db.close();
  }
}

export {
  REVIEW_STATE_SCHEMA_VERSION,
  ensureReviewStateSchema,
  openReviewStateDb,
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
