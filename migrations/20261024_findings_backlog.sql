CREATE TABLE finding_batches (
  batch_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  area TEXT NOT NULL,
  day TEXT NOT NULL,
  launch_id TEXT,
  completed_at TEXT,
  error TEXT,
  UNIQUE(repo, area, day)
);
CREATE UNIQUE INDEX finding_batches_active ON finding_batches(repo, area) WHERE completed_at IS NULL;
CREATE TABLE finding_backlog (
  finding_id TEXT PRIMARY KEY REFERENCES review_findings(finding_id),
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  reviewer_family TEXT NOT NULL,
  area TEXT NOT NULL,
  captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  batch_id TEXT REFERENCES finding_batches(batch_id),
  outcome TEXT CHECK (outcome IN ('applied','dropped')),
  reason TEXT,
  result_pr INTEGER,
  UNIQUE(repo, pr_number, head_sha, content_sha256),
  CHECK (outcome IS NULL OR (reason IS NOT NULL AND length(trim(reason)) > 0
    AND (outcome <> 'applied' OR (result_pr IS NOT NULL AND result_pr > 0))))
);
CREATE INDEX finding_backlog_pending ON finding_backlog(repo, area, captured_at) WHERE outcome IS NULL;
-- Same ordering as the captured exact-head review resolver. The final posted
-- review replaces earlier passes, including earlier heads; capture grants no authority.
CREATE VIEW finding_backlog_candidates AS
  SELECT f.finding_id, p.repo, p.pr_number, f.head_sha, f.content_sha256,
    coalesce(CASE WHEN json_valid(p.metadata_json) THEN nullif(json_extract(p.metadata_json, '$.reviewerAttribution.family'), '') END, p.reviewer_class) AS reviewer_family,
    CASE WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1)
      ELSE coalesce(nullif(path, ''), '_uncited') END AS area
  FROM (SELECT *, CASE WHEN substr(trim(file, '` '),1,2)='./'
    THEN substr(trim(file, '` '),3) ELSE trim(file, '` ') END AS path
    FROM review_findings) f JOIN reviewer_passes p USING(pass_id)
  WHERE f.blocking=0 AND f.current_body=1 AND f.head_sha IS NOT NULL AND f.head_sha<>''
    AND p.pass_id=(SELECT last.pass_id FROM reviewer_passes last
      WHERE last.repo=p.repo AND last.pr_number=p.pr_number
        AND last.pass_kind IN ('first-pass','rereview') AND last.body_md IS NOT NULL
        AND last.gh_comment_id IS NOT NULL AND trim(cast(last.gh_comment_id AS TEXT))<>''
        AND last.body_captured_at IS NOT NULL AND trim(last.body_captured_at)<>'' AND trim(last.body_md)<>''
      ORDER BY last.body_captured_at DESC, last.ended_at DESC, last.started_at DESC, last.pass_id DESC LIMIT 1);
CREATE TRIGGER finding_backlog_on_merge AFTER UPDATE OF pr_state ON reviewed_prs
WHEN NEW.pr_state='merged' AND OLD.pr_state<>'merged'
BEGIN
  UPDATE finding_backlog SET outcome=NULL,reason=NULL
    WHERE repo=NEW.repo AND pr_number=NEW.pr_number AND reason='pr-closed-without-merge'
    AND EXISTS (SELECT 1 FROM finding_backlog_candidates c WHERE c.repo=finding_backlog.repo
      AND c.pr_number=finding_backlog.pr_number AND c.head_sha=finding_backlog.head_sha
      AND c.content_sha256=finding_backlog.content_sha256);
  UPDATE finding_backlog SET outcome='dropped',reason='superseded-final-review'
    WHERE repo=NEW.repo AND pr_number=NEW.pr_number AND outcome IS NULL AND batch_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM finding_backlog_candidates c WHERE c.repo=finding_backlog.repo
      AND c.pr_number=finding_backlog.pr_number AND c.head_sha=finding_backlog.head_sha
      AND c.content_sha256=finding_backlog.content_sha256);
  INSERT OR IGNORE INTO finding_backlog
    (finding_id,repo,pr_number,head_sha,content_sha256,reviewer_family,area)
    SELECT * FROM finding_backlog_candidates WHERE repo=NEW.repo AND pr_number=NEW.pr_number;
END;
-- Late body projection after a merge remains recoverable without a corpus scan.
CREATE TRIGGER finding_backlog_late_capture AFTER INSERT ON review_findings
WHEN EXISTS (SELECT 1 FROM reviewer_passes p JOIN reviewed_prs r
  ON r.repo=p.repo AND r.pr_number=p.pr_number
  WHERE p.pass_id=NEW.pass_id AND r.pr_state='merged')
BEGIN
  INSERT OR IGNORE INTO finding_backlog
    (finding_id,repo,pr_number,head_sha,content_sha256,reviewer_family,area)
    SELECT * FROM finding_backlog_candidates WHERE finding_id=NEW.finding_id;
END;

CREATE TRIGGER finding_backlog_late_receipt AFTER UPDATE OF gh_comment_id,body_captured_at ON reviewer_passes
WHEN EXISTS (SELECT 1 FROM reviewed_prs r WHERE r.repo=NEW.repo AND r.pr_number=NEW.pr_number AND r.pr_state='merged')
BEGIN
  INSERT OR IGNORE INTO finding_backlog
    (finding_id,repo,pr_number,head_sha,content_sha256,reviewer_family,area)
    SELECT * FROM finding_backlog_candidates WHERE repo=NEW.repo AND pr_number=NEW.pr_number;
END;

CREATE TRIGGER finding_backlog_on_close AFTER UPDATE OF pr_state ON reviewed_prs
WHEN NEW.pr_state='closed' AND OLD.pr_state<>'closed'
BEGIN
  UPDATE finding_backlog SET outcome='dropped',reason='pr-closed-without-merge'
    WHERE repo=NEW.repo AND pr_number=NEW.pr_number AND outcome IS NULL AND batch_id IS NULL;
END;
