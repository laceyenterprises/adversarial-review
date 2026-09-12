# Data Model - Duplicate Families

**Owner:** duplicate-family advisory census
**Store:** `data/reviews.db`
**Source of truth:** `src/duplicate-family-state.mjs`
**Runtime surface:** `src/duplicate-family-state.mjs`, `src/review-state.mjs`, `src/watcher.mjs`

## Purpose

The duplicate-family census records advisory groups of open PRs that appear to
represent the same work identity in the same target repo and base branch. The
watcher updates this state during polling so operator surfaces can see likely
redundant PRs without blocking the normal adversarial-review state machine.

The census is advisory only. Rows do not merge, close, or reject PRs by
themselves; they preserve evidence and operator overrides for duplicate-stack
adjudication.

## Tables

### `duplicate_families`

One row per detected work-identity family.

| Column | Contract |
|---|---|
| `family_id` | Stable generated identifier for the family row. |
| `family_key` | Unique logical key: target repo, base branch, and normalized work identity. |
| `target_repo` | Repository the duplicate census observed. |
| `base_branch` | Base branch shared by the active duplicate candidates. |
| `normalized_work_identity` | Normalized ticket, explicit identity label, or dispatch identity used for grouping. |
| `status` | `advisory` while at least two live unsuppressed candidates remain; `inactive` after the census no longer sees a duplicate family. |
| `strongest_signal` | First common strong signal kind shared by active candidates. |
| `selected_survivor_pr_number` | Optional operator-selected PR number to keep as the survivor. |
| `report_path` | Optional path to an operator-facing duplicate report artifact. |
| `operator_override_json` | Operator override/disposition payload. A candidate head move marks matching overrides stale once for the observed head. |
| `transition_log_json` | JSON array of status transitions such as initial detection, reactivation, and deactivation. |
| `candidate_count` | Count of live open unsuppressed candidates in the current advisory family. |
| `first_detected_at` | First time the family was recorded. |
| `last_seen_at` | Last census time the family key was observed. |
| `updated_at` | Last time the family row was refreshed or changed. |

### `duplicate_family_candidates`

One row per PR candidate currently associated with a duplicate family. A PR can
belong to only one family at a time; reassignment updates the row's
`family_id`.

| Column | Contract |
|---|---|
| `family_id` | Parent `duplicate_families.family_id`. |
| `repo` | Candidate PR repository. |
| `pr_number` | Candidate PR number. |
| `title` | Candidate PR title at last census. |
| `pr_state` | Lowercase PR state observed at last census, including terminal states such as `merged` or `closed`. |
| `base_branch` | Candidate base branch. |
| `head_branch` | Candidate head branch. |
| `head_sha` | Candidate head SHA. |
| `base_sha` | Candidate base SHA or merge-base evidence when available. |
| `role` | Candidate role, currently `candidate`. |
| `work_identity_json` | Extracted identity payload and provenance resolution. |
| `signals_json` | Strong signal evidence used by the detector. |
| `suppressions_json` | Suppression evidence such as stack/follow-up labels or current-head exclusion labels. |
| `labels_json` | Candidate label names at last census. |
| `first_seen_at` | First time this PR was persisted for the family. |
| `last_seen_at` | Last census time this PR was observed for the family. |
| `updated_at` | Last time this candidate row was refreshed. |

The primary key is `(repo, pr_number)`. The watcher keeps candidate
rows current for every PR still mapped to an active family, including PRs that
became merged, closed, or suppressed after the family was first detected. This
prevents stale `open` candidate state from surviving while sibling PRs keep the
family advisory active. Existing databases created with the older
`(family_id, repo, pr_number)` key are migrated in place by
`ensureDuplicateFamilySchema(db)`.

## Operational Contract

- `ensureDuplicateFamilySchema(db)` creates both tables and the supporting
  candidate PR and family status indexes.
- Existing `duplicate_family_candidates` tables with the former
  `(family_id, repo, pr_number)` primary key are rebuilt to `(repo, pr_number)`
  inside a single SQLite transaction. If any rebuild step fails, the original
  table and rows remain in place so startup can retry instead of abandoning
  candidates in an orphaned legacy table.
- `detectDuplicateFamiliesForRepo()` requires at least two open unsuppressed
  candidates with at least two common strong signals before returning an
  advisory family.
- `upsertDuplicateFamilies()` persists all candidates in each returned family,
  while `candidate_count` tracks only the active open unsuppressed subset. If a
  PR is detected in a different family, its existing candidate row is reassigned
  to the new `family_id`.
- `deactivateMissing` marks active advisory families inactive only when the
  current census observed at least one persisted candidate from that family and
  no longer returns the family key. Families that are absent solely because all
  candidates fell outside a windowed polling slice remain advisory until a later
  observation proves they no longer have two live unsuppressed candidates.
- Operator overrides are not deleted automatically. If the override references
  a candidate whose head moved, the override is marked stale for that observed
  head without regenerating the stale timestamp on later identical polls.
- Missing or transiently unreadable dispatch provenance disables the duplicate
  census for the tick rather than deactivating existing active families.
- The tables contain no secrets; JSON payloads store PR metadata, labels,
  provenance resolution state, and operator disposition metadata only.
