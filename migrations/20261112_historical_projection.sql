-- Historical evidence must never implicitly activate remediation consumers.
ALTER TABLE review_findings ADD COLUMN historical_projection INTEGER NOT NULL DEFAULT 0
  CHECK (historical_projection IN (0,1));
ALTER TABLE finding_batch_notes ADD COLUMN historical_projection INTEGER NOT NULL DEFAULT 0
  CHECK (historical_projection IN (0,1));
DROP VIEW finding_backlog_candidates;
CREATE VIEW finding_backlog_candidates AS
  SELECT f.finding_id, p.repo, p.pr_number, f.head_sha, f.content_sha256,
    coalesce(CASE WHEN json_valid(p.metadata_json) THEN nullif(json_extract(p.metadata_json, '$.reviewerAttribution.family'), '') END, p.reviewer_class) AS reviewer_family,
    CASE WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1)
      ELSE coalesce(nullif(path, ''), '_uncited') END AS area
  FROM (SELECT *, CASE WHEN substr(trim(file, '` '),1,2)='./'
    THEN substr(trim(file, '` '),3) ELSE trim(file, '` ') END AS path
    FROM review_findings) f JOIN reviewer_passes p USING(pass_id)
  WHERE f.historical_projection=0 AND f.blocking=0 AND f.current_body=1 AND f.head_sha IS NOT NULL AND f.head_sha<>''
    AND p.pass_id=(SELECT last.pass_id FROM reviewer_passes last
      WHERE last.repo=p.repo AND last.pr_number=p.pr_number
        AND last.pass_kind IN ('first-pass','rereview') AND last.body_md IS NOT NULL
        AND last.gh_comment_id IS NOT NULL AND trim(cast(last.gh_comment_id AS TEXT))<>''
        AND last.body_captured_at IS NOT NULL AND trim(last.body_captured_at)<>'' AND trim(last.body_md)<>''
      ORDER BY last.body_captured_at DESC, last.ended_at DESC, last.started_at DESC, last.pass_id DESC LIMIT 1);

DROP VIEW finding_batch_note_candidates;
CREATE VIEW finding_batch_note_candidates AS
  SELECT n.*,
    coalesce((SELECT b.area FROM finding_backlog b WHERE b.repo=n.repo
      AND b.pr_number=n.pr_number AND b.head_sha=n.head_sha AND b.outcome IS NULL
      AND b.batch_id IS NULL ORDER BY b.area LIMIT 1), '_simplicity') AS area
  FROM finding_batch_notes n JOIN reviewed_prs r ON r.repo=n.repo AND r.pr_number=n.pr_number
  WHERE n.historical_projection=0
    AND n.batch_id IS NULL AND n.dropped_reason IS NULL AND r.pr_state='merged'
    AND julianday(r.merged_at) >= julianday(
      (SELECT applied_at FROM schema_migrations WHERE id='20261024_simplicity_batch.sql'))
    AND NOT EXISTS (SELECT 1 FROM finding_batch_note_dispositions d
      WHERE d.note_id=n.note_id AND d.reason IS NOT NULL);

