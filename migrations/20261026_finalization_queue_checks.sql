-- MGQ-05: durable infrastructure page enqueue receipts. No new delivery bus.
CREATE TABLE IF NOT EXISTS finalization_queue_check_page (
  cause_key TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  receipt_json TEXT
);
