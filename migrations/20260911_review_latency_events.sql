CREATE TABLE IF NOT EXISTS review_latency_events (
  event_id             INTEGER PRIMARY KEY AUTOINCREMENT,
  repo                 TEXT,
  pr_number            INTEGER,
  domain_id            TEXT,
  subject_external_id  TEXT,
  revision_ref         TEXT,
  event_type           TEXT NOT NULL,
  stage                TEXT NOT NULL,
  at                   TEXT NOT NULL,
  source               TEXT NOT NULL DEFAULT 'unknown',
  source_ref           TEXT,
  idempotency_key      TEXT,
  reason               TEXT,
  payload_json         TEXT NOT NULL DEFAULT '{}',
  recorded_at          TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (json_valid(payload_json))
);

CREATE UNIQUE INDEX IF NOT EXISTS review_latency_events_idempotency_unique
  ON review_latency_events(event_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_review_latency_events_subject_at
  ON review_latency_events(repo, pr_number, at);

CREATE INDEX IF NOT EXISTS idx_review_latency_events_type_at
  ON review_latency_events(event_type, at);
