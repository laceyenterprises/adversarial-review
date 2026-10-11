// HOLDRELEASE-01: label snapshots and release intent commit together. A crash
// cannot lose the edge between discovery and the existing stage handlers.
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { OPERATOR_HOLD_LABELS, isOperatorHeld } from './operator-hold-labels.mjs';

function labels(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map(l => typeof l === 'string' ? l : l?.name).filter(Boolean) : null;
  } catch { return null; }
}

export function ensureHoldReleaseSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS operator_hold_releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL, head_sha TEXT NOT NULL, released_at TEXT NOT NULL,
    removed_json TEXT NOT NULL, stage TEXT, action TEXT,
    routed_at TEXT, cancelled_at TEXT
  ); CREATE INDEX IF NOT EXISTS idx_operator_hold_releases_pr
    ON operator_hold_releases(repo, pr_number, id DESC);`);
}

export function observeHoldRelease({ db, repo, prNumber, headSha, liveLabels, now = new Date().toISOString() }) {
  const live = labels(liveLabels);
  if (!live || !headSha) return null;
  ensureHoldReleaseSchema(db);
  return db.transaction(() => {
    const row = db.prepare('SELECT labels_json FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(repo, prNumber);
    if (!row) return null;
    const stored = labels(row.labels_json);
    if (isOperatorHeld(live)) {
      db.prepare('UPDATE operator_hold_releases SET cancelled_at = ? WHERE repo = ? AND pr_number = ? AND cancelled_at IS NULL').run(now, repo, prNumber);
    } else if (stored && isOperatorHeld(stored)) {
      db.prepare(`INSERT INTO operator_hold_releases (repo, pr_number, head_sha, released_at, removed_json)
        VALUES (?, ?, ?, ?, ?)`).run(repo, prNumber, headSha, now,
      JSON.stringify([...new Set(stored.filter(l => OPERATOR_HOLD_LABELS.includes(l)))].sort()));
    }
    db.prepare('UPDATE reviewed_prs SET labels_json = ? WHERE repo = ? AND pr_number = ?').run(JSON.stringify(live), repo, prNumber);
    return db.prepare(`SELECT * FROM operator_hold_releases WHERE repo = ? AND pr_number = ?
      AND routed_at IS NULL AND cancelled_at IS NULL ORDER BY id DESC LIMIT 1`).get(repo, prNumber) || null;
  }).immediate();
}

// Classification chooses existing routes; it grants no merge authority.
export function holdReleaseRoute({ row, headSha, settled = {}, candidate = {}, roundsLeft = false, cycleCapped = false }) {
  if (cycleCapped) return { stage: 'cycle-cap', action: 'hammer' };
  if (row?.review_status !== 'posted' || settled.reviewedHeadSha !== headSha || !settled.verdict) {
    return { stage: row?.reviewer_head_sha ? 'rereview' : 'first-review', action: 'review', unknown: row?.review_status === 'posted' };
  }
  if (candidate.mergeable === 'CONFLICTING' || candidate.mergeStateStatus === 'DIRTY'
    || candidate.mergeStateStatus === 'BEHIND' || candidate.checksConclusion === 'FAILURE') {
    return { stage: 'code-work', action: 'hammer' };
  }
  if (settled.blockingFindingState !== 'known' || !Number.isInteger(settled.blockingFindingCount)
    || !Number.isInteger(settled.nonBlockingFindingCount)) {
    return { stage: 'rereview', action: 'review', unknown: true };
  }
  if (settled.blockingFindingCount > 0 && roundsLeft) return { stage: 'blocking-findings', action: 'remediation' };
  if (settled.blockingFindingState === 'known' && settled.blockingFindingCount === 0
    && settled.nonBlockingFindingCount === 0 && candidate.checksConclusion === 'SUCCESS'
    && candidate.mergeable === 'MERGEABLE') return { stage: 'clean-review', action: 'daemon-clean-merge' };
  if (!candidate.mergeable || candidate.mergeable === 'UNKNOWN' || !candidate.checksConclusion) {
    return { stage: 'rereview', action: 'review', unknown: true };
  }
  return { stage: 'closeout', action: 'hammer' };
}

export function markHoldReleaseRouted({ db, release, route, now = new Date().toISOString(), logger = console }) {
  const changed = db.prepare(`UPDATE operator_hold_releases SET stage = ?, action = ?, routed_at = ?
    WHERE id = ? AND routed_at IS NULL AND cancelled_at IS NULL`).run(route.stage, route.action, now, release.id);
  if (changed.changes) logger.log(`[watcher] hold-released repo=${release.repo} pr=${release.pr_number} removed=${JSON.parse(release.removed_json).join(',')} stage=${route.stage} action=${route.action}${route.unknown ? ' reason=stage-unknown-rereview-current-head' : ''}`);
  return changed.changes === 1;
}

export function readLatestHoldRelease(rootDir, repo, prNumber, headSha) {
  let db;
  try {
    db = new Database(join(rootDir, 'data', 'reviews.db'), { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT labels_json FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(repo, prNumber);
    if (!labels(row?.labels_json) || isOperatorHeld(row.labels_json)) return null;
    return db.prepare(`SELECT * FROM operator_hold_releases WHERE repo = ? AND pr_number = ? AND head_sha = ?
      AND cancelled_at IS NULL ORDER BY id DESC LIMIT 1`).get(repo, prNumber, headSha) || null;
  } catch { return null; }
  finally { db?.close(); }
}
