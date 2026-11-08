-- Observational grades never participate in merge eligibility.
CREATE TABLE IF NOT EXISTS review_finding_grades (
  grade_id INTEGER PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  finding_id TEXT NOT NULL REFERENCES review_findings(finding_id),
  graded_head_sha TEXT,
  grader_kind TEXT NOT NULL CHECK (grader_kind IN ('batch-remediator','grader','judge','hammer','remediator','lifecycle','scar','operator')),
  grader_harness TEXT, grader_model TEXT, grader_effort TEXT, prompt_digest TEXT,
  label TEXT NOT NULL CHECK (label IN ('real','false','indeterminate')),
  taxonomy_code TEXT NOT NULL CHECK (taxonomy_code IN (
    'tp.valid','tp.already-fixed-elsewhere','tp.out-of-scope',
    'fp.misread-code','fp.hallucinated-symbol','fp.wrong-spec','fp.speculative','fp.duplicate','fp.unclassified',
    'ind.stale','ind.cannot-reproduce','life.pr-closed','life.superseded','sev.should-block','sev.should-not-block')),
  confidence REAL CHECK (confidence BETWEEN 0 AND 1),
  evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256)=64),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  cost_usd REAL CHECK (cost_usd >= 0),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  interested_party INTEGER NOT NULL DEFAULT 0 CHECK (interested_party IN (0,1)),
  lifecycle INTEGER NOT NULL DEFAULT 0 CHECK (lifecycle IN (0,1)),
  graded_at TEXT NOT NULL,
  CHECK ((taxonomy_code LIKE 'tp.%' AND label='real') OR
    (taxonomy_code LIKE 'fp.%' AND label='false') OR
    (taxonomy_code LIKE 'ind.%' AND label='indeterminate') OR
    (taxonomy_code LIKE 'life.%' AND label='indeterminate') OR taxonomy_code LIKE 'sev.%'),
  CHECK (lifecycle = (taxonomy_code LIKE 'life.%'))
);
CREATE INDEX IF NOT EXISTS review_finding_grades_finding ON review_finding_grades(finding_id,grade_id);
ALTER TABLE review_findings ADD COLUMN reviewer_harness TEXT;
ALTER TABLE review_findings ADD COLUMN prompt_set TEXT;
ALTER TABLE review_findings ADD COLUMN prompt_digest TEXT;
ALTER TABLE review_findings ADD COLUMN prompt_stage TEXT;
ALTER TABLE review_findings ADD COLUMN prompt_digests_json TEXT;
CREATE TRIGGER IF NOT EXISTS review_findings_prompt_attribution
AFTER UPDATE OF metadata_json ON reviewer_passes
WHEN json_valid(NEW.metadata_json)
BEGIN
  UPDATE review_findings SET
    reviewer_harness=json_extract(NEW.metadata_json,'$.reviewerExecution.harness'),
    prompt_set=json_extract(NEW.metadata_json,'$.reviewerExecution.promptSet'),
    prompt_digest=json_extract(NEW.metadata_json,'$.reviewerExecution.promptDigest'),
    prompt_stage=json_extract(NEW.metadata_json,'$.reviewerExecution.promptStage'),
    prompt_digests_json=json_extract(NEW.metadata_json,'$.reviewerExecution.promptDigests')
    WHERE pass_id=NEW.pass_id;
END;
UPDATE review_findings SET
  reviewer_harness=(SELECT json_extract(metadata_json,'$.reviewerExecution.harness') FROM reviewer_passes WHERE pass_id=review_findings.pass_id AND json_valid(metadata_json)),
  prompt_set=(SELECT json_extract(metadata_json,'$.reviewerExecution.promptSet') FROM reviewer_passes WHERE pass_id=review_findings.pass_id AND json_valid(metadata_json)),
  prompt_digest=(SELECT json_extract(metadata_json,'$.reviewerExecution.promptDigest') FROM reviewer_passes WHERE pass_id=review_findings.pass_id AND json_valid(metadata_json)),
  prompt_stage=(SELECT json_extract(metadata_json,'$.reviewerExecution.promptStage') FROM reviewer_passes WHERE pass_id=review_findings.pass_id AND json_valid(metadata_json)),
  prompt_digests_json=(SELECT json_extract(metadata_json,'$.reviewerExecution.promptDigests') FROM reviewer_passes WHERE pass_id=review_findings.pass_id AND json_valid(metadata_json));
