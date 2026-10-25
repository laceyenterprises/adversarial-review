-- Advisory observations remain separate from findings and all merge gates.
ALTER TABLE finding_batches ADD COLUMN result_json TEXT;
CREATE TABLE finding_batch_notes (
  note_id TEXT PRIMARY KEY,
  pass_id INTEGER NOT NULL REFERENCES reviewer_passes(pass_id),
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  note TEXT NOT NULL,
  batch_id TEXT REFERENCES finding_batches(batch_id)
);
CREATE INDEX finding_batch_notes_pending ON finding_batch_notes(repo, pr_number) WHERE batch_id IS NULL;
CREATE INDEX finding_batch_notes_source ON finding_batch_notes(repo, pr_number, head_sha);
-- Select the same final posted review ordering as finding_backlog_candidates.
-- The referenced pass is captured before its posting receipt may arrive.
CREATE VIEW finding_batch_note_candidates AS
  SELECT n.*,
    coalesce((SELECT b.area FROM finding_backlog b WHERE b.repo=n.repo
      AND b.pr_number=n.pr_number AND b.head_sha=n.head_sha AND b.outcome IS NULL
      AND b.batch_id IS NULL ORDER BY b.area LIMIT 1), '_simplicity') AS area
  FROM finding_batch_notes n JOIN reviewed_prs r ON r.repo=n.repo AND r.pr_number=n.pr_number
  WHERE n.batch_id IS NULL AND r.pr_state='merged'
    AND NOT EXISTS (SELECT 1 FROM finding_batch_notes owned WHERE owned.repo=n.repo
      AND owned.pr_number=n.pr_number AND owned.head_sha=n.head_sha AND owned.note=n.note
      AND owned.batch_id IS NOT NULL)
    AND n.pass_id=(SELECT p.pass_id FROM reviewer_passes p
      WHERE p.repo=n.repo AND p.pr_number=n.pr_number
        AND p.pass_kind IN ('first-pass','rereview') AND trim(p.body_md)<>''
        AND p.gh_comment_id IS NOT NULL AND trim(cast(p.gh_comment_id AS TEXT))<>''
        AND p.body_captured_at IS NOT NULL AND trim(p.body_captured_at)<>''
      ORDER BY p.body_captured_at DESC,p.ended_at DESC,p.started_at DESC,p.pass_id DESC LIMIT 1);
