-- Preserve assigned snapshots while retiring unassigned, non-dispatchable advice.
ALTER TABLE finding_batch_notes ADD COLUMN dropped_reason TEXT;
DROP INDEX finding_batch_notes_pending;
CREATE INDEX finding_batch_notes_pending ON finding_batch_notes(repo, pr_number)
  WHERE batch_id IS NULL AND dropped_reason IS NULL;

-- The original migration receipt is the enrollment cutoff, not the time of a
-- repair/backfill run. Missing merge timestamps fail closed until refreshed.
CREATE VIEW finding_batch_note_dispositions AS
  SELECT n.note_id, CASE
    WHEN r.pr_state='closed' THEN 'pr-closed-without-merge'
    WHEN r.pr_state='merged' AND julianday(r.merged_at) IS NULL THEN 'merge-time-unverified'
    WHEN r.pr_state='merged' AND julianday(r.merged_at) < julianday(
      (SELECT applied_at FROM schema_migrations WHERE id='20261024_simplicity_batch.sql'))
      THEN 'historical-merge'
    WHEN r.pr_state='merged' AND (n.pass_id IS NOT (
      SELECT p.pass_id FROM reviewer_passes p
      WHERE p.repo=n.repo AND p.pr_number=n.pr_number
        AND p.pass_kind IN ('first-pass','rereview') AND trim(p.body_md)<>''
        AND p.gh_comment_id IS NOT NULL AND trim(cast(p.gh_comment_id AS TEXT))<>''
        AND p.body_captured_at IS NOT NULL AND trim(p.body_captured_at)<>''
      ORDER BY p.body_captured_at DESC,p.ended_at DESC,p.started_at DESC,p.pass_id DESC LIMIT 1)
      OR EXISTS (SELECT 1 FROM finding_batch_notes owned WHERE owned.repo=n.repo
        AND owned.pr_number=n.pr_number AND owned.head_sha=n.head_sha AND owned.note=n.note
        AND owned.batch_id IS NOT NULL)) THEN 'superseded-final-review'
    END AS reason
  FROM finding_batch_notes n JOIN reviewed_prs r ON r.repo=n.repo AND r.pr_number=n.pr_number
  WHERE n.batch_id IS NULL;

UPDATE finding_batch_notes SET dropped_reason=(
  SELECT reason FROM finding_batch_note_dispositions d WHERE d.note_id=finding_batch_notes.note_id)
  WHERE batch_id IS NULL;

DROP VIEW finding_batch_note_candidates;
CREATE VIEW finding_batch_note_candidates AS
  SELECT n.*,
    coalesce((SELECT b.area FROM finding_backlog b WHERE b.repo=n.repo
      AND b.pr_number=n.pr_number AND b.head_sha=n.head_sha AND b.outcome IS NULL
      AND b.batch_id IS NULL ORDER BY b.area LIMIT 1), '_simplicity') AS area
  FROM finding_batch_notes n JOIN reviewed_prs r ON r.repo=n.repo AND r.pr_number=n.pr_number
  WHERE n.batch_id IS NULL AND n.dropped_reason IS NULL AND r.pr_state='merged'
    AND julianday(r.merged_at) >= julianday(
      (SELECT applied_at FROM schema_migrations WHERE id='20261024_simplicity_batch.sql'))
    AND NOT EXISTS (SELECT 1 FROM finding_batch_note_dispositions d
      WHERE d.note_id=n.note_id AND d.reason IS NOT NULL);

CREATE TRIGGER finding_batch_notes_lifecycle AFTER UPDATE OF pr_state,merged_at ON reviewed_prs
BEGIN
  UPDATE finding_batch_notes SET dropped_reason=(
    SELECT reason FROM finding_batch_note_dispositions d WHERE d.note_id=finding_batch_notes.note_id)
    WHERE batch_id IS NULL AND repo=NEW.repo AND pr_number=NEW.pr_number;
END;

CREATE TRIGGER finding_batch_notes_capture AFTER INSERT ON finding_batch_notes
BEGIN
  UPDATE finding_batch_notes SET dropped_reason=(
    SELECT reason FROM finding_batch_note_dispositions d WHERE d.note_id=finding_batch_notes.note_id)
    WHERE batch_id IS NULL AND repo=NEW.repo AND pr_number=NEW.pr_number;
END;

CREATE TRIGGER finding_batch_notes_assignment AFTER UPDATE OF batch_id ON finding_batch_notes
WHEN NEW.batch_id IS NOT NULL
BEGIN
  UPDATE finding_batch_notes SET dropped_reason=(
    SELECT reason FROM finding_batch_note_dispositions d WHERE d.note_id=finding_batch_notes.note_id)
    WHERE batch_id IS NULL AND repo=NEW.repo AND pr_number=NEW.pr_number;
END;

CREATE TRIGGER finding_batch_notes_receipt AFTER UPDATE OF gh_comment_id,body_captured_at ON reviewer_passes
BEGIN
  UPDATE finding_batch_notes SET dropped_reason=(
    SELECT reason FROM finding_batch_note_dispositions d WHERE d.note_id=finding_batch_notes.note_id)
    WHERE batch_id IS NULL AND repo=NEW.repo AND pr_number=NEW.pr_number;
END;
