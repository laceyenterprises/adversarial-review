-- MGQ-01: additive, app-owned lane state. No route is enabled by migration.
CREATE TABLE IF NOT EXISTS finalization_queue_lane (
  repository TEXT NOT NULL,
  base TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  route_generation INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT,
  owner_state TEXT NOT NULL DEFAULT 'idle' CHECK(owner_state IN ('idle','active','parked')),
  acquired_at TEXT,
  heartbeat_at TEXT,
  expires_at TEXT,
  reason TEXT,
  readiness_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(repository, base)
);
CREATE TABLE IF NOT EXISTS finalization_queue_entry (
  entry_id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  base TEXT NOT NULL,
  pr_number INTEGER NOT NULL CHECK(pr_number > 0),
  admission_head TEXT NOT NULL,
  admission_generation INTEGER NOT NULL CHECK(admission_generation > 0),
  handoff_id TEXT NOT NULL,
  ack_id TEXT NOT NULL,
  readiness_seq INTEGER NOT NULL,
  phase TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(repository, base, pr_number, admission_head, admission_generation),
  UNIQUE(repository, base, handoff_id),
  UNIQUE(repository, base, ack_id),
  UNIQUE(repository, base, readiness_seq)
);
CREATE TABLE IF NOT EXISTS finalization_queue_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  repository TEXT NOT NULL,
  base TEXT NOT NULL,
  event_type TEXT NOT NULL,
  at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_finalization_queue_event_lane
  ON finalization_queue_event(repository, base, seq);
CREATE TABLE IF NOT EXISTS finalization_queue_operation (
  operation_id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  base TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  route_generation INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('push','merge')),
  intent_json TEXT NOT NULL,
  result_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_finalization_queue_operation_lane
  ON finalization_queue_operation(repository, base);
