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
        AND pass_kind IN ('first-pass','rereview') AND gh_comment_id IS NOT NULL AND body_captured_at IS NOT NULL
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
