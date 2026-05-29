ALTER TABLE reviewer_passes ADD COLUMN verdict TEXT;
ALTER TABLE reviewer_passes ADD COLUMN body_md TEXT;
ALTER TABLE reviewer_passes ADD COLUMN gh_comment_id TEXT;
ALTER TABLE reviewer_passes ADD COLUMN body_captured_at TEXT;

CREATE TABLE IF NOT EXISTS pr_merge_closeouts (
  repo                  TEXT NOT NULL,
  pr_number             INTEGER NOT NULL,
  closeout_body_md      TEXT,
  closeout_authors_json TEXT,
  closeout_posted_at    TEXT,
  body_captured_at      TEXT,
  scrape_last_checked_at TEXT,
  empty_confirmed_at    TEXT,
  merged_at             TEXT,
  gh_artifact_refs      TEXT,
  PRIMARY KEY (repo, pr_number)
);
