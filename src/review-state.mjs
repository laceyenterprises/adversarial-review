import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

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
      UNIQUE(repo, pr_number)
    )
  `);

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
}

function getReviewRow(db, { repo, prNumber }) {
  return db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(repo, prNumber) || null;
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

    const reviewRow = getReviewRow(db, { repo, prNumber });
    if (!reviewRow) {
      return buildBlockedRereviewResult('review-row-missing');
    }

    if (reviewRow.review_status === 'malformed') {
      return buildBlockedRereviewResult('malformed-title-terminal', reviewRow);
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

    db.prepare(
      "UPDATE reviewed_prs SET review_status = 'pending', posted_at = NULL, failed_at = NULL, failure_message = NULL, rereview_requested_at = ?, rereview_reason = ? WHERE repo = ? AND pr_number = ?"
    ).run(
      requestedAt,
      reason || 'Re-review requested from remediation reply.',
      repo,
      prNumber
    );

    return {
      triggered: true,
      status: 'pending',
      reason: 'review-status-reset',
      reviewRow: getReviewRow(db, { repo, prNumber }),
    };
  } finally {
    db.close();
  }
}

export {
  ensureReviewStateSchema,
  openReviewStateDb,
  getReviewRow,
  requestReviewRereview,
};
