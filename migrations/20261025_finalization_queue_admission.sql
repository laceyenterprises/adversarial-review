-- MGQ-03: immutable signed clean review receipt, sharing the lane readiness CAS.
CREATE TABLE IF NOT EXISTS finalization_queue_clean_review (
  entry_id TEXT PRIMARY KEY REFERENCES finalization_queue_entry(entry_id),
  input_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL
);
