-- Selected work remains operator-owned across releases and process restarts.
ALTER TABLE finding_backlog ADD COLUMN manifest_sha256 TEXT;
UPDATE finding_backlog SET manifest_sha256=coalesce(
  (SELECT a.manifest_sha256 FROM finding_batches a WHERE a.batch_id=finding_backlog.batch_id),
  (SELECT a.manifest_sha256 FROM finding_batch_releases r JOIN finding_batches a USING(batch_id)
    WHERE finding_backlog.batch_id IS NULL AND r.finding_id=finding_backlog.finding_id AND a.manifest_sha256 IS NOT NULL
    ORDER BY r.release_id DESC LIMIT 1))
WHERE manifest_sha256 IS NULL;
