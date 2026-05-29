ALTER TABLE reviewer_passes ADD COLUMN verdict TEXT CHECK (
  verdict IS NULL OR verdict IN ('approved', 'comment-only', 'request-changes', 'dismissed')
);

ALTER TABLE reviewer_passes ADD COLUMN body_md TEXT;

ALTER TABLE reviewer_passes ADD COLUMN gh_comment_id TEXT;

ALTER TABLE reviewer_passes ADD COLUMN body_captured_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reviewer_passes_gh_comment_id
  ON reviewer_passes(gh_comment_id)
  WHERE gh_comment_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS reviewer_passes_verdict_insert_check
  BEFORE INSERT ON reviewer_passes
  WHEN NEW.verdict IS NOT NULL
   AND NEW.verdict NOT IN ('approved', 'comment-only', 'request-changes', 'dismissed')
BEGIN
  SELECT RAISE(ABORT, 'reviewer_passes verdict must be approved, comment-only, request-changes, or dismissed');
END;

CREATE TRIGGER IF NOT EXISTS reviewer_passes_verdict_update_check
  BEFORE UPDATE OF verdict ON reviewer_passes
  WHEN NEW.verdict IS NOT NULL
   AND NEW.verdict NOT IN ('approved', 'comment-only', 'request-changes', 'dismissed')
BEGIN
  SELECT RAISE(ABORT, 'reviewer_passes verdict must be approved, comment-only, request-changes, or dismissed');
END;

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
  CHECK (gh_artifact_refs IS NULL OR closeout_body_md IS NOT NULL),
  PRIMARY KEY (repo, pr_number)
);

CREATE INDEX IF NOT EXISTS idx_pr_merge_closeouts_scrape_pending
  ON pr_merge_closeouts(scrape_last_checked_at)
  WHERE empty_confirmed_at IS NULL AND closeout_posted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pr_merge_closeouts_merged_at
  ON pr_merge_closeouts(merged_at);
