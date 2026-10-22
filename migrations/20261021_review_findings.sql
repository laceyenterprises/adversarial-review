CREATE TABLE IF NOT EXISTS review_findings (
  finding_id TEXT PRIMARY KEY,
  pass_id INTEGER NOT NULL REFERENCES reviewer_passes(pass_id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  content_sha256 TEXT NOT NULL,
  current_body INTEGER NOT NULL DEFAULT 1 CHECK (current_body IN (0, 1)),
  blocking INTEGER NOT NULL CHECK (blocking IN (0, 1)),
  category TEXT,
  file TEXT,
  lines TEXT,
  title TEXT,
  finding_json TEXT NOT NULL CHECK (json_valid(finding_json)),
  reviewer_identity TEXT NOT NULL,
  reviewer_model TEXT,
  reasoning_effort TEXT,
  head_sha TEXT,
  hammer_identity TEXT NOT NULL,
  UNIQUE(pass_id, ordinal, content_sha256)
);
CREATE INDEX IF NOT EXISTS idx_review_findings_pass ON review_findings(pass_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_review_findings_hammer ON review_findings(hammer_identity, head_sha);

CREATE TABLE IF NOT EXISTS review_finding_replies (
  reply_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  reply_path TEXT,
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  start_head_sha TEXT,
  published_head_sha TEXT
);
CREATE TABLE IF NOT EXISTS review_finding_remediations (
  finding_id TEXT NOT NULL REFERENCES review_findings(finding_id),
  reply_id TEXT NOT NULL REFERENCES review_finding_replies(reply_id),
  reply_field TEXT,
  reply_ordinal INTEGER,
  commit_sha TEXT,
  reason TEXT NOT NULL,
  PRIMARY KEY(finding_id, reply_id)
);
CREATE TABLE IF NOT EXISTS review_finding_disputes (
  finding_id TEXT NOT NULL REFERENCES review_findings(finding_id),
  identity TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  resolution TEXT,
  evidence_sha256 TEXT,
  requests INTEGER NOT NULL,
  refusals INTEGER NOT NULL,
  PRIMARY KEY(finding_id, head_sha, comment_id)
);

CREATE TRIGGER IF NOT EXISTS review_findings_pass_attribution
AFTER UPDATE OF reviewer_class, reviewer_model, reasoning_effort, head_sha, metadata_json ON reviewer_passes
BEGIN
  UPDATE review_findings SET reviewer_identity=COALESCE(
      CASE WHEN json_valid(NEW.metadata_json) THEN json_extract(NEW.metadata_json, '$.reviewerAttribution.identity') END,
      NEW.reviewer_class),
    reviewer_model=NEW.reviewer_model, reasoning_effort=NEW.reasoning_effort, head_sha=NEW.head_sha
    WHERE pass_id=NEW.pass_id;
END;

CREATE TRIGGER IF NOT EXISTS review_findings_dispute_insert
AFTER INSERT ON ham_finding_disputes
WHEN NEW.comment_id IS NOT NULL AND NEW.finding_reviewed_head IS NOT NULL
  AND NEW.head_sha IS NOT NULL AND NEW.head_sha <> ''
BEGIN
  INSERT OR REPLACE INTO review_finding_disputes
    (finding_id, identity, head_sha, comment_id, resolution, evidence_sha256, requests, refusals)
    SELECT f.finding_id, NEW.identity, COALESCE(NEW.head_sha, ''), NEW.comment_id,
      NEW.resolution, NEW.evidence_sha256, NEW.requests, NEW.refusals
    FROM review_findings f JOIN reviewer_passes p ON p.pass_id=f.pass_id
    WHERE p.repo=NEW.repo AND p.pr_number=NEW.pr_number AND f.blocking=1
      AND f.hammer_identity=NEW.identity AND f.head_sha=NEW.finding_reviewed_head;
END;

CREATE TRIGGER IF NOT EXISTS review_findings_dispute_update
AFTER UPDATE ON ham_finding_disputes
WHEN NEW.comment_id IS NOT NULL AND NEW.finding_reviewed_head IS NOT NULL
  AND NEW.head_sha IS NOT NULL AND NEW.head_sha <> ''
BEGIN
  INSERT OR REPLACE INTO review_finding_disputes
    (finding_id, identity, head_sha, comment_id, resolution, evidence_sha256, requests, refusals)
    SELECT f.finding_id, NEW.identity, COALESCE(NEW.head_sha, ''), NEW.comment_id,
      NEW.resolution, NEW.evidence_sha256, NEW.requests, NEW.refusals
    FROM review_findings f JOIN reviewer_passes p ON p.pass_id=f.pass_id
    WHERE p.repo=NEW.repo AND p.pr_number=NEW.pr_number AND f.blocking=1
      AND f.hammer_identity=NEW.identity AND f.head_sha=NEW.finding_reviewed_head;
END;
