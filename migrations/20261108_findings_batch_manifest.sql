-- Frozen selection provenance; NULL preserves automatic backlog batches.
ALTER TABLE finding_batches ADD COLUMN manifest_sha256 TEXT;
