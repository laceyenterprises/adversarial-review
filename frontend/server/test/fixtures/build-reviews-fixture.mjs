#!/usr/bin/env node
/**
 * Regenerate `test/fixtures/reviews.db` — the committed fixture the store
 * adapter tests read.
 *
 * The fixture is built against the **live pipeline schema** (the real
 * `reviewed_prs` / `reviewer_passes` DDL from the pipeline,
 * transcribed here — ARF imports nothing from the pipeline), not against ARF's
 * standalone subset. That is the point: it proves the adapter reads a real
 * reviews.db shape, including columns ARF's own schema does not carry.
 *
 * Run:  npm run fixture:build   (from frontend/server)
 *
 * The generated file is committed. Regenerate and commit it in the same change
 * whenever the fixture rows here change.
 */

import { unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { databaseSync } from '../../src/store/sqlite.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = join(HERE, 'reviews.db');

// Transcribed from the live pipeline schema so the fixture exercises columns
// ARF's standalone subset omits (worker_run_id, token_*, metadata_json, ...).
const LIVE_SCHEMA_SQL = `
  CREATE TABLE reviewed_prs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    repo              TEXT NOT NULL,
    pr_number         INTEGER NOT NULL,
    domain_id         TEXT,
    subject_external_id TEXT,
    revision_ref      TEXT,
    reviewed_at       TEXT NOT NULL,
    reviewer          TEXT NOT NULL,
    pr_state          TEXT NOT NULL DEFAULT 'open',
    merged_at         TEXT,
    closed_at         TEXT,
    linear_ticket     TEXT,
    review_status     TEXT NOT NULL DEFAULT 'posted',
    review_attempts   INTEGER NOT NULL DEFAULT 0,
    last_attempted_at TEXT,
    posted_at         TEXT,
    failed_at         TEXT,
    failure_message   TEXT,
    labels_json       TEXT,
    reviewer_head_sha TEXT,
    UNIQUE(repo, pr_number)
  );

  CREATE TABLE reviewer_passes (
    pass_id              INTEGER PRIMARY KEY AUTOINCREMENT,
    repo                 TEXT NOT NULL,
    pr_number            INTEGER NOT NULL,
    attempt_number       INTEGER NOT NULL,
    reviewer_class       TEXT NOT NULL,
    reviewer_model       TEXT,
    pass_kind            TEXT NOT NULL,
    worker_run_id        TEXT,
    workspace_path       TEXT,
    started_at           TEXT NOT NULL,
    ended_at             TEXT,
    status               TEXT NOT NULL,
    token_input          INTEGER,
    token_output         INTEGER,
    token_total          INTEGER,
    metadata_json        TEXT NOT NULL DEFAULT '{}',
    verdict              TEXT,
    body_md              TEXT,
    gh_comment_id        TEXT,
    body_captured_at     TEXT,
    head_sha             TEXT,
    UNIQUE(repo, pr_number, attempt_number, pass_kind)
  );
`;

const REPO = 'laceyenterprises/agent-os';

const REQUEST_CHANGES_BODY = `## Verdict

Request changes.

## Blocking issues

- **Store adapter opens a writable handle in in-os mode**
  - **Category:** correctness
  - **File:** frontend/server/src/store/sqlite.mjs
  - **Lines:** 40-52
  - **Problem:** A writable handle against a single-writer reviews.db can
    corrupt pipeline state.
  - **Why it matters:** reviews.db is watcher-owned.
  - **Recommended fix:** Derive readOnly from the mode.

- **Absent store raises instead of degrading**
  - **Category:** reliability
  - **File:** frontend/server/src/store/review-store.mjs
  - **Problem:** A fork without the pipeline gets a 500 rather than an empty list.
  - **Recommended fix:** Return a valid empty projection.

## Non-blocking issues

- **Comment says mode=ro but the code uses immutable=1**
  - **Category:** docs
  - **File:** frontend/server/src/store/sqlite.mjs
`;

const COMMENT_ONLY_BODY = `## Verdict

Comment only.

## Blocking issues

- None.

## Non-blocking issues

- **Findings parser duplicates the pipeline grammar**
  - **Category:** maintainability
  - **File:** frontend/server/src/store/findings.mjs
  - **Why it matters:** The template can drift.
`;

const APPROVED_BODY = `## Verdict

Approved.

## Blocking issues

- None.

## Non-blocking issues

- None.
`;

// An off-template body: neither section is present. The projection must report
// unknown (null) counts for it, not zero.
const OFF_TEMPLATE_BODY = `Looks fine to me. Shipping.`;

const PRS = [
  {
    repo: REPO,
    pr_number: 5543,
    reviewed_at: '2026-08-16T10:00:00Z',
    reviewer: 'claude-code',
    pr_state: 'open',
    merged_at: null,
    closed_at: null,
    linear_ticket: 'ARF-01',
    review_status: 'posted',
    review_attempts: 2,
    last_attempted_at: '2026-08-16T12:00:00Z',
    failure_message: null,
    labels_json: '["adversarial-review", "agent-built"]',
    reviewer_head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  {
    repo: REPO,
    pr_number: 5541,
    reviewed_at: '2026-08-15T09:00:00Z',
    reviewer: 'codex',
    pr_state: 'closed',
    merged_at: '2026-08-15T11:30:00Z',
    closed_at: null,
    linear_ticket: 'ROS-02',
    review_status: 'merged',
    review_attempts: 1,
    last_attempted_at: '2026-08-15T10:00:00Z',
    failure_message: null,
    labels_json: null,
    reviewer_head_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  },
  {
    // No passes at all: a PR claimed for review that never produced one. The
    // detail projection must still return a PR with empty rounds/passes/findings.
    repo: REPO,
    pr_number: 5539,
    reviewed_at: '2026-08-14T08:00:00Z',
    reviewer: 'claude-code',
    pr_state: 'open',
    merged_at: null,
    closed_at: null,
    linear_ticket: null,
    review_status: 'failed',
    review_attempts: 0,
    last_attempted_at: '2026-08-14T08:05:00Z',
    failure_message: 'reviewer spawn refused: drain in effect',
    labels_json: '[]',
    reviewer_head_sha: null,
  },
];

const PASSES = [
  {
    repo: REPO,
    pr_number: 5543,
    attempt_number: 1,
    reviewer_class: 'codex',
    reviewer_model: 'gpt-5-codex',
    pass_kind: 'review',
    started_at: '2026-08-16T10:05:00Z',
    ended_at: '2026-08-16T10:20:00Z',
    status: 'completed',
    verdict: 'request-changes',
    body_md: REQUEST_CHANGES_BODY,
    gh_comment_id: '900001',
    body_captured_at: '2026-08-16T10:20:05Z',
    head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  {
    // Same round as the pass above — a round can hold several passes, and the
    // round verdict is the last one, not the first.
    repo: REPO,
    pr_number: 5543,
    attempt_number: 1,
    reviewer_class: 'codex',
    reviewer_model: 'gpt-5-codex',
    pass_kind: 'rereview',
    started_at: '2026-08-16T11:00:00Z',
    ended_at: '2026-08-16T11:10:00Z',
    status: 'completed',
    verdict: 'comment-only',
    body_md: COMMENT_ONLY_BODY,
    gh_comment_id: '900002',
    body_captured_at: '2026-08-16T11:10:05Z',
    head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  {
    repo: REPO,
    pr_number: 5543,
    attempt_number: 2,
    reviewer_class: 'claude-code',
    reviewer_model: 'claude-opus-5',
    pass_kind: 'review',
    started_at: '2026-08-16T12:00:00Z',
    ended_at: null,
    // The pipeline's `status` vocabulary is running|completed|failed|cancelled;
    // a fixture that claims to be live-shaped has to use the live words.
    status: 'running',
    verdict: null,
    body_md: null,
    gh_comment_id: null,
    body_captured_at: null,
    head_sha: 'cccccccccccccccccccccccccccccccccccccccc',
  },
  {
    repo: REPO,
    pr_number: 5541,
    attempt_number: 1,
    reviewer_class: 'claude-code',
    reviewer_model: 'claude-opus-5',
    pass_kind: 'review',
    started_at: '2026-08-15T09:30:00Z',
    ended_at: '2026-08-15T09:50:00Z',
    status: 'completed',
    verdict: 'approved',
    body_md: APPROVED_BODY,
    gh_comment_id: '900003',
    body_captured_at: '2026-08-15T09:50:05Z',
    head_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  },
  {
    repo: REPO,
    pr_number: 5541,
    attempt_number: 1,
    reviewer_class: 'claude-code',
    reviewer_model: 'claude-opus-5',
    pass_kind: 'closeout',
    started_at: '2026-08-15T10:00:00Z',
    ended_at: '2026-08-15T10:02:00Z',
    status: 'completed',
    verdict: null,
    body_md: OFF_TEMPLATE_BODY,
    gh_comment_id: '900004',
    body_captured_at: '2026-08-15T10:02:05Z',
    head_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  },
];

function insertAll(db, table, rows) {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const stmt = db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  );
  for (const row of rows) stmt.run(...columns.map((column) => row[column]));
}

export function buildFixture(path = FIXTURE_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    unlinkSync(path);
  } catch {
    // Nothing to remove on a first build.
  }
  const DatabaseSync = databaseSync();
  const db = new DatabaseSync(path);
  try {
    db.exec(LIVE_SCHEMA_SQL);
    insertAll(db, 'reviewed_prs', PRS);
    insertAll(db, 'reviewer_passes', PASSES);
  } finally {
    db.close();
  }
  return path;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`wrote ${buildFixture()}\n`);
}
