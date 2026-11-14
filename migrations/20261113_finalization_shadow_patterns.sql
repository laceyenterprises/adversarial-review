-- Pattern records are immutable except for a one-way audited revocation.
CREATE TABLE IF NOT EXISTS finalization_shadow_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('equivalent', 'v2-defect', 'policy')),
  principal TEXT NOT NULL,
  note TEXT NOT NULL,
  ticket_ref TEXT,
  evidence_sample_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revocation_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_finalization_shadow_patterns_active
  ON finalization_shadow_patterns(pattern_key) WHERE revocation_json IS NULL;
