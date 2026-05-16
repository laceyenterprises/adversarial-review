CREATE TABLE IF NOT EXISTS reviewer_passes (
  pass_id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo                 TEXT NOT NULL,
  pr_number            INTEGER NOT NULL,
  attempt_number       INTEGER NOT NULL,
  reviewer_class       TEXT NOT NULL,
  pass_kind            TEXT NOT NULL,
  worker_run_id        TEXT,
  workspace_path       TEXT,
  started_at           TEXT NOT NULL,
  ended_at             TEXT,
  status               TEXT NOT NULL,
  token_input          INTEGER,
  token_output         INTEGER,
  token_cache_read     INTEGER,
  token_cache_write    INTEGER,
  token_cost_usd       REAL,
  token_source         TEXT,
  metadata_json        TEXT NOT NULL DEFAULT '{}',
  UNIQUE(repo, pr_number, attempt_number, pass_kind)
);

CREATE INDEX IF NOT EXISTS idx_reviewer_passes_pr
  ON reviewer_passes(repo, pr_number);

CREATE INDEX IF NOT EXISTS idx_reviewer_passes_started
  ON reviewer_passes(started_at);
