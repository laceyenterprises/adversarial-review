-- LAC-1559: record the head SHA a reviewer pass reviewed so the completed-
-- rereview budget counter can key per (repo, pr, head). Without this, a
-- rereview pass carries no head, so the per-PR rereview count stayed spent
-- across a head move — a genuinely new head could not earn a fresh review and
-- the PR stalled `posted` on a stale head (close refused `stale-review-head`).
ALTER TABLE reviewer_passes ADD COLUMN head_sha TEXT;

CREATE INDEX IF NOT EXISTS idx_reviewer_passes_head
  ON reviewer_passes(repo, pr_number, pass_kind, head_sha);
