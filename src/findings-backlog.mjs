import { createHash } from 'node:crypto';
import { openReviewStateDb } from './review-state.mjs';
import { persistReviewFindings } from './review-finding-records.mjs';

// Called at the merge command boundary. Missing/stale capture defers the merge,
// rather than spending a hammer or silently losing the findings.
export function captureReadyFindings({ rootDir, repo, prNumber, headSha, version, count }) {
  const db = openReviewStateDb(rootDir);
  try {
    return db.transaction(() => {
      const pass = db.prepare(`SELECT * FROM reviewer_passes WHERE repo=? AND pr_number=?
        AND pass_kind IN ('first-pass','rereview') AND gh_comment_id IS NOT NULL AND trim(cast(gh_comment_id AS TEXT))<>''
        AND body_captured_at IS NOT NULL AND trim(body_captured_at)<>'' AND trim(body_md)<>''
        ORDER BY body_captured_at DESC, ended_at DESC, started_at DESC, pass_id DESC LIMIT 1`).get(repo, prNumber);
      if (!pass || pass.head_sha !== headSha || !version
        || createHash('sha256').update(pass.body_md || '').digest('hex') !== version) {
        throw Error('findings-capture-not-current');
      }
      persistReviewFindings(db, pass.pass_id);
      const actual = db.prepare('SELECT count(*) n FROM review_findings WHERE pass_id=? AND current_body=1 AND blocking=0')
        .get(pass.pass_id).n;
      if (actual !== count) throw Error('findings-capture-count-mismatch');
      return db.prepare(`INSERT OR IGNORE INTO finding_backlog
        (finding_id,repo,pr_number,head_sha,content_sha256,reviewer_family,area)
        SELECT * FROM finding_backlog_candidates WHERE repo=? AND pr_number=? AND head_sha=?`).run(repo, prNumber, headSha).changes;
    }).immediate();
  } finally { db.close(); }
}

// Missing schema is unavailable evidence, never an empty/healthy backlog.
export function summarizeFindingBacklog(db, now = Date.now()) {
  if (!db) return { available: false, error: 'review-store-unavailable', areas: null };
  try {
    const areas = db.prepare(`WITH unresolved AS (
      SELECT b.repo,b.area,b.captured_at,b.batch_id,r.pr_state FROM finding_backlog b
      JOIN reviewed_prs r ON r.repo=b.repo AND r.pr_number=b.pr_number WHERE b.outcome IS NULL
      UNION ALL
      SELECT n.repo,coalesce(a.area,c.area,'_simplicity'),p.body_captured_at,n.batch_id,r.pr_state
      FROM finding_batch_notes n JOIN reviewer_passes p USING(pass_id)
      JOIN reviewed_prs r ON r.repo=n.repo AND r.pr_number=n.pr_number
      LEFT JOIN finding_batches a USING(batch_id)
      LEFT JOIN finding_batch_note_candidates c USING(note_id)
      WHERE n.dropped_reason IS NULL AND (n.batch_id IS NULL OR a.completed_at IS NULL)
    ) SELECT b.repo,b.area,count(*) AS size,min(b.captured_at) AS oldestAt,
      sum(b.batch_id IS NOT NULL) AS inBatch,sum(b.pr_state<>'merged') AS waitingForMerge,
      max(a.error) AS error FROM unresolved b LEFT JOIN finding_batches a USING(batch_id)
      GROUP BY b.repo,b.area ORDER BY b.repo,b.area`).all()
      .map(row => ({ ...row, oldestAgeMs: Math.max(0, now - Date.parse(row.oldestAt)) }));
    return { available: true, areas };
  } catch (error) { return { available: false, error: error.message, areas: null }; }
}
