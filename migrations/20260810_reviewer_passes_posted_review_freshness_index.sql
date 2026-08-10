ALTER TABLE reviewer_passes ADD COLUMN ended_at TEXT;

CREATE INDEX IF NOT EXISTS idx_reviewer_passes_posted_review_freshness
  ON reviewer_passes(
    strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      CASE
        WHEN REPLACE(COALESCE(body_captured_at, ended_at), ' ', 'T') GLOB '*Z'
          OR REPLACE(COALESCE(body_captured_at, ended_at), ' ', 'T') GLOB '*+??:??'
          OR REPLACE(COALESCE(body_captured_at, ended_at), ' ', 'T') GLOB '*-??:??'
          THEN REPLACE(COALESCE(body_captured_at, ended_at), ' ', 'T')
        ELSE REPLACE(COALESCE(body_captured_at, ended_at), ' ', 'T') || 'Z'
      END
    )
  )
  WHERE gh_comment_id IS NOT NULL
    AND gh_comment_id <> ''
    AND COALESCE(body_captured_at, ended_at) IS NOT NULL
    AND REPLACE(COALESCE(body_captured_at, ended_at), ' ', 'T') GLOB '????-??-??T??:??:??*';
