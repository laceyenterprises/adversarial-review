/**
 * Standalone store schema.
 *
 * When no live pipeline is present, ARF owns an equivalent SQLite file. It uses
 * the **same table and column names** as the pipeline's `reviews.db` for the
 * subset ARF reads, so one set of projection SQL serves both modes and a
 * standalone install cannot silently drift into a different read shape (SPEC §6
 * "standalone drift from the in-OS pipeline").
 *
 * This is deliberately a read-shape subset, not a fork of the pipeline schema:
 * ARF never writes review state in `in-os` mode, and standalone ARF only needs
 * the columns its projections read. Columns the live store has and this one
 * lacks are projected as NULL by the tolerant select list, in both directions.
 *
 * v2 (ARF-04) adds `review_cycle_counters`, the per-`(pr_url, head_sha)`
 * round-budget accounting Screen B burns down. Only the counter table is
 * mirrored, not `review_cycle_verdicts`: the counter carries the current count,
 * the head it belongs to, and the escalation stamp, which is everything the
 * burndown reads. An install predating this table degrades to an empty
 * burndown rather than an error, as every other projection here does.
 */

export const ARF_STORE_SCHEMA_VERSION = 2;

export const STANDALONE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS reviewed_prs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    repo              TEXT NOT NULL,
    pr_number         INTEGER NOT NULL,
    reviewed_at       TEXT,
    reviewer          TEXT,
    pr_state          TEXT NOT NULL DEFAULT 'open',
    merged_at         TEXT,
    closed_at         TEXT,
    linear_ticket     TEXT,
    review_status     TEXT NOT NULL DEFAULT 'posted',
    review_attempts   INTEGER NOT NULL DEFAULT 0,
    last_attempted_at TEXT,
    failure_message   TEXT,
    labels_json       TEXT,
    reviewer_head_sha TEXT,
    UNIQUE(repo, pr_number)
  );

  CREATE TABLE IF NOT EXISTS reviewer_passes (
    pass_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    repo              TEXT NOT NULL,
    pr_number         INTEGER NOT NULL,
    attempt_number    INTEGER NOT NULL,
    reviewer_class    TEXT,
    reviewer_model    TEXT,
    pass_kind         TEXT,
    verdict           TEXT,
    status            TEXT,
    head_sha          TEXT,
    gh_comment_id     TEXT,
    body_md           TEXT,
    body_captured_at  TEXT,
    started_at        TEXT,
    ended_at          TEXT,
    UNIQUE(repo, pr_number, attempt_number, pass_kind)
  );

  CREATE INDEX IF NOT EXISTS idx_reviewer_passes_pr ON reviewer_passes(repo, pr_number);

  CREATE TABLE IF NOT EXISTS review_cycle_counters (
    pr_url          TEXT NOT NULL,
    head_sha        TEXT NOT NULL,
    verdict_count   INTEGER NOT NULL,
    last_verdict_at TEXT NOT NULL,
    escalated_at    TEXT,
    PRIMARY KEY (pr_url, head_sha)
  );

  CREATE TABLE IF NOT EXISTS arf_store_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;
