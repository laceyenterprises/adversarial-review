CREATE TABLE IF NOT EXISTS finalization_queue_gsr (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  token TEXT NOT NULL,
  at TEXT NOT NULL
);
