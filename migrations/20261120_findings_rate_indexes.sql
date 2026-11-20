-- Match the last-hour summary predicates without changing timestamp semantics.
-- Partial expression indexes bound each rate read to recent automatic work,
-- including stores with historical timestamps using different ISO offsets.
CREATE INDEX IF NOT EXISTS finding_backlog_capture_rate
  ON finding_backlog(julianday(captured_at)) WHERE manifest_sha256 IS NULL;
CREATE INDEX IF NOT EXISTS finding_backlog_resolution_rate
  ON finding_backlog(julianday(resolved_at))
  WHERE manifest_sha256 IS NULL AND outcome IS NOT NULL;
CREATE INDEX IF NOT EXISTS finding_batches_completion_rate
  ON finding_batches(julianday(completed_at)) WHERE manifest_sha256 IS NULL;
