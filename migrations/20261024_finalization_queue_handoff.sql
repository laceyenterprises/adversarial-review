-- MGQ-02: immutable validated closer receipt; committed with lane admission.
CREATE TABLE IF NOT EXISTS finalization_queue_handoff (
  handoff_id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL UNIQUE REFERENCES finalization_queue_entry(entry_id),
  repository TEXT NOT NULL,
  base TEXT NOT NULL,
  pr_number INTEGER NOT NULL CHECK(pr_number > 0),
  admission_head TEXT NOT NULL,
  admission_generation INTEGER NOT NULL CHECK(admission_generation > 0),
  payload_digest TEXT NOT NULL,
  handoff_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  ack_json TEXT NOT NULL,
  UNIQUE(repository, base, pr_number, admission_head, admission_generation)
);
