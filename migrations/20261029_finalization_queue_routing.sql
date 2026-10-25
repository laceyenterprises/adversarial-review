-- Routing is durable ownership, not merge eligibility. No lane is enabled here.
CREATE TABLE IF NOT EXISTS finalization_queue_route (
  repository TEXT NOT NULL,
  base TEXT NOT NULL,
  executor TEXT NOT NULL CHECK(executor IN ('legacy','queue-v2')),
  config_generation TEXT NOT NULL,
  runtime_json TEXT,
  transition_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(repository,base)
);
CREATE TABLE IF NOT EXISTS finalization_queue_legacy_writer (
  writer_id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  base TEXT NOT NULL,
  route_generation INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('daemon','closer')),
  intent_json TEXT NOT NULL,
  result_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_finalization_queue_legacy_writer_lane
  ON finalization_queue_legacy_writer(repository,base);
CREATE TABLE IF NOT EXISTS finalization_queue_route_return (
  entry_id TEXT PRIMARY KEY,
  delivery_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  receipt_json TEXT
);
