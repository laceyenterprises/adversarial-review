-- Retain batch identities and references while removing both drain ceilings.
-- Defer FK checks for callers that enable foreign_keys; all parent IDs are
-- restored in this same migration transaction.
PRAGMA defer_foreign_keys = ON;
CREATE TEMP TABLE finding_batches_saved AS SELECT * FROM finding_batches;
DROP TABLE finding_batches;
CREATE TABLE finding_batches (
  batch_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  area TEXT NOT NULL,
  day TEXT NOT NULL,
  launch_id TEXT,
  completed_at TEXT,
  error TEXT,
  result_json TEXT
);
INSERT INTO finding_batches SELECT * FROM finding_batches_saved;
DROP TABLE finding_batches_saved;
CREATE INDEX finding_batches_pending ON finding_batches(completed_at);
UPDATE finding_batches SET completed_at=NULL,error='batch-zero-outcomes'
  WHERE completed_at IS NOT NULL AND json_valid(result_json)
    AND coalesce(json_array_length(result_json,'$.findings'),0)=0
    AND coalesce(json_array_length(result_json,'$.simplicityNotes'),0)=0;
ALTER TABLE finding_backlog ADD COLUMN resolved_at TEXT;
-- Historical findings have only a batch completion timestamp. Do not invent
-- resolution times for lifecycle-trigger drops that have no such receipt.
UPDATE finding_backlog SET resolved_at=(
  SELECT completed_at FROM finding_batches a WHERE a.batch_id=finding_backlog.batch_id)
  WHERE outcome IS NOT NULL;
CREATE TRIGGER finding_backlog_resolution AFTER UPDATE OF outcome ON finding_backlog
WHEN NEW.outcome IS NOT OLD.outcome
BEGIN
  UPDATE finding_backlog SET resolved_at=CASE WHEN NEW.outcome IS NULL THEN NULL
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END WHERE finding_id=NEW.finding_id;
END;

-- Lifecycle drops carry a fixed code and the evidence observed by the trigger.
DROP TRIGGER IF EXISTS finding_backlog_on_merge;
DROP TRIGGER IF EXISTS finding_backlog_on_close;
CREATE TRIGGER finding_backlog_on_merge AFTER UPDATE OF pr_state ON reviewed_prs
WHEN NEW.pr_state='merged' AND OLD.pr_state<>'merged'
BEGIN
  UPDATE finding_backlog SET outcome=NULL,reason=NULL
    WHERE repo=NEW.repo AND pr_number=NEW.pr_number AND reason IN ('pr-closed-without-merge','false-positive: Source PR closed without merge; reviewed changes did not land')
    AND EXISTS (SELECT 1 FROM finding_backlog_candidates c WHERE c.repo=finding_backlog.repo
      AND c.pr_number=finding_backlog.pr_number AND c.head_sha=finding_backlog.head_sha
      AND c.content_sha256=finding_backlog.content_sha256);
  UPDATE finding_backlog SET outcome='dropped',reason='stale-code-changed: Final posted review superseded this finding'
    WHERE repo=NEW.repo AND pr_number=NEW.pr_number AND outcome IS NULL AND batch_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM finding_backlog_candidates c WHERE c.repo=finding_backlog.repo
      AND c.pr_number=finding_backlog.pr_number AND c.head_sha=finding_backlog.head_sha
      AND c.content_sha256=finding_backlog.content_sha256);
  INSERT OR IGNORE INTO finding_backlog
    (finding_id,repo,pr_number,head_sha,content_sha256,reviewer_family,area)
    SELECT * FROM finding_backlog_candidates WHERE repo=NEW.repo AND pr_number=NEW.pr_number;
END;
CREATE TRIGGER finding_backlog_on_close AFTER UPDATE OF pr_state ON reviewed_prs
WHEN NEW.pr_state='closed' AND OLD.pr_state<>'closed'
BEGIN
  UPDATE finding_backlog SET outcome='dropped',reason='false-positive: Source PR closed without merge; reviewed changes did not land'
    WHERE repo=NEW.repo AND pr_number=NEW.pr_number AND outcome IS NULL AND batch_id IS NULL;
END;

UPDATE finding_backlog SET reason='false-positive: Source PR closed without merge; reviewed changes did not land' WHERE outcome='dropped' AND reason='pr-closed-without-merge';
UPDATE finding_backlog SET reason='stale-code-changed: Final posted review superseded this finding' WHERE outcome='dropped' AND reason='superseded-final-review';
