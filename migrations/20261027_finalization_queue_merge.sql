-- MGQ-06: immutable merge receipts and stable-key post-merge delivery outbox.
CREATE TABLE IF NOT EXISTS finalization_queue_merge_receipt (
  entry_id TEXT PRIMARY KEY REFERENCES finalization_queue_entry(entry_id),
  repository TEXT NOT NULL,
  base TEXT NOT NULL,
  pr_number INTEGER NOT NULL CHECK(pr_number > 0),
  candidate TEXT NOT NULL,
  merge_sha TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  receipt_digest TEXT NOT NULL,
  receipt_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finalization_queue_delivery (
  delivery_key TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES finalization_queue_merge_receipt(entry_id),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  receipt_json TEXT,
  UNIQUE(entry_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_finalization_queue_delivery_pending
  ON finalization_queue_delivery(entry_id) WHERE receipt_json IS NULL;
