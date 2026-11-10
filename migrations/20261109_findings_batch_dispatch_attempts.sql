-- Failed initial dispatch submissions, distinct from the per-finding release
-- count. A release charges each finding once through the existing audit path.
ALTER TABLE finding_batches ADD COLUMN batch_attempts INTEGER NOT NULL DEFAULT 0;
