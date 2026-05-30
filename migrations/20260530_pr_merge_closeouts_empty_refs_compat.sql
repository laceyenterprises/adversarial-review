ALTER TABLE pr_merge_closeouts RENAME TO pr_merge_closeouts__old;

CREATE TABLE IF NOT EXISTS pr_merge_closeouts (
  repo                  TEXT NOT NULL,
  pr_number             INTEGER NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  closeout_body_md      TEXT,
  closeout_authors_json TEXT CHECK (
    closeout_authors_json IS NULL
    OR (json_valid(closeout_authors_json) AND json_type(closeout_authors_json) = 'array')
  ),
  closeout_posted_at    TEXT,
  body_captured_at      TEXT,
  scrape_last_checked_at TEXT,
  empty_confirmed_at    TEXT,
  merged_at             TEXT,
  gh_artifact_refs      TEXT CHECK (
    gh_artifact_refs IS NULL
    OR (json_valid(gh_artifact_refs) AND json_type(gh_artifact_refs) = 'array')
  ),
  CHECK (closeout_posted_at IS NULL OR closeout_body_md IS NOT NULL),
  CHECK (empty_confirmed_at IS NULL OR closeout_body_md IS NULL),
  CHECK (closeout_authors_json IS NULL OR closeout_body_md IS NOT NULL),
  PRIMARY KEY (repo, pr_number)
);

INSERT INTO pr_merge_closeouts (
  repo,
  pr_number,
  created_at,
  closeout_body_md,
  closeout_authors_json,
  closeout_posted_at,
  body_captured_at,
  scrape_last_checked_at,
  empty_confirmed_at,
  merged_at,
  gh_artifact_refs
)
SELECT
  repo,
  pr_number,
  created_at,
  closeout_body_md,
  closeout_authors_json,
  closeout_posted_at,
  body_captured_at,
  scrape_last_checked_at,
  empty_confirmed_at,
  merged_at,
  gh_artifact_refs
FROM pr_merge_closeouts__old;

DROP TABLE pr_merge_closeouts__old;

CREATE INDEX IF NOT EXISTS idx_pr_merge_closeouts_scrape_pending
  ON pr_merge_closeouts(scrape_last_checked_at)
  WHERE empty_confirmed_at IS NULL AND closeout_posted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pr_merge_closeouts_merged_at
  ON pr_merge_closeouts(merged_at);
