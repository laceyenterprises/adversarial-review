-- FINDINGSREQUEUE-01: a batch whose launch ended without settling releases its
-- open findings back to the queue. Each finding counts its failed batch
-- attempts; the cap drops it with an explicit reason instead of stranding it.
-- Re-running this migration is safe: duplicate columns are skipped by the
-- runner and every other object uses IF NOT EXISTS.
ALTER TABLE finding_backlog ADD COLUMN batch_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE finding_batches ADD COLUMN launched_at TEXT;
ALTER TABLE finding_batches ADD COLUMN released_at TEXT;
ALTER TABLE finding_batches ADD COLUMN release_reason TEXT;
CREATE TABLE IF NOT EXISTS finding_batch_releases (
  release_id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id TEXT NOT NULL REFERENCES finding_backlog(finding_id),
  batch_id TEXT NOT NULL REFERENCES finding_batches(batch_id),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  disposition TEXT NOT NULL CHECK (disposition IN ('requeued','exhausted')),
  released_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS finding_batch_releases_batch ON finding_batch_releases(batch_id);
CREATE INDEX IF NOT EXISTS finding_batch_releases_finding ON finding_batch_releases(finding_id);
