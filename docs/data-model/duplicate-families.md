# Data Model - Duplicate Families

**Owner:** duplicate-family merge gate
**Store:** `data/reviews.db`
**Source of truth:** `src/duplicate-family-state.mjs`
**Runtime surface:** `src/duplicate-family-state.mjs`, `src/review-state.mjs`, `src/watcher.mjs`

## Purpose

The duplicate-family census records groups of open PRs that appear to represent
the same work identity in the same target repo and base branch. The watcher
updates this state during polling so operator surfaces can see likely redundant
PRs and so unresolved duplicate families can block autonomous merge lanes until
the family is resolved or suppressed.

For an active unresolved family, `reconcileDuplicateFamilyLabels()` projects the
store into GitHub by applying `duplicate-family` and
`duplicate-family-hold`; the hold label is the merge-blocking contract consumed
by AMA, hammer routing, merge-agent dispatch, and fast-merge. After an operator
selects a survivor and that survivor is observed merged, the watcher may close
non-suppressed, non-ignored loser PRs from these rows only when merge authority
is armed (`enabled: true`) and the runtime autonomous merge kill switch remains
on (`autonomous_merge_execution_enabled: true`). Suppressed candidates remain
advisory members only and are never closed by duplicate-family closeout.

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
| `status` | Family lifecycle status: `advisory` while at least two live unsuppressed candidates remain; `inactive` after the census no longer sees a duplicate family; `survivor-selected` after an operator selects a survivor and verified report; `survivor-merged` after the selected survivor is confirmed merged and loser closeout is still in progress; `resolved` after all closable losers are closed; `abandoned` after an operator records no safe survivor. A later duplicate census reactivates only `inactive` and `resolved` rows to `advisory` and clears stale survivor-selection fields. |
| `strongest_signal` | First common strong signal kind shared by active candidates. |
| `selected_survivor_pr_number` | Optional operator-selected PR number to keep as the survivor. |
| `report_path` | Optional path to an operator-facing duplicate report artifact. |
| `operator_override_json` | Audited survivor selection and per-candidate `ignored-not-duplicate` dispositions. Every release carries the candidate PR and exact head; head movement marks the matching disposition stale. Survivor selection also records the committed report path, report-verified head, choice, salvage, validation, and `auditPending` until its GitHub audit comment is posted. |
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
| `role` | `candidate` before adjudication, then exactly one unsuppressed `survivor`; non-suppressed remaining members become `loser`, while suppressed members and exact-head `ignored-not-duplicate` overrides stay `candidate`. |
| `work_identity_json` | Extracted identity payload and provenance resolution. |
| `signals_json` | Strong signal evidence used by the detector. |
| `suppressions_json` | Suppression evidence such as stack/follow-up labels or the PR-wide exclusion label. |
| `labels_json` | Candidate label names at last census. |
| `first_seen_at` | First time this PR was persisted for the family. |
| `last_seen_at` | Last census time this PR was observed for the family. |
| `updated_at` | Last time this candidate row was refreshed. |

The primary key is `(repo, pr_number)`. The watcher keeps candidate
rows current for every PR still mapped to an active family. For candidates that
leave the open-PR discovery slice, the census joins the authoritative
`reviewed_prs.pr_state`; a sibling recorded there as merged or closed is
re-injected with that terminal state and no longer keeps the family active.
Slice absence by itself is not treated as closure. Existing databases created with the older
`(family_id, repo, pr_number)` key are migrated in place by
`ensureDuplicateFamilySchema(db)`.

## Operational Contract

- `ensureDuplicateFamilySchema(db)` creates both tables and the supporting
  candidate PR, candidate `family_id`, and family status indexes.
- Existing `duplicate_family_candidates` tables with the former
  `(family_id, repo, pr_number)` primary key are rebuilt to `(repo, pr_number)`
  inside a single SQLite transaction. If any rebuild step fails, the original
  table and rows remain in place so startup can retry instead of abandoning
  candidates in an orphaned legacy table.
- `detectDuplicateFamiliesForRepo()` requires at least two open unsuppressed
  candidates with at least two common strong signals before returning an
  advisory family. Candidates carrying suppression evidence, such as
  `not-a-duplicate-stack`, stack/follow-up labels, or sibling stack-base
  evidence, are persisted for operator context but are not held.
- `upsertDuplicateFamilies()` persists all candidates in each returned family,
  while `candidate_count` tracks only the active open unsuppressed subset. If a
  PR is detected in a different family, its existing candidate row is reassigned
  to the new `family_id`. A census that sees a duplicate family again
  reactivates only `inactive` and `resolved` rows and clears the prior
  `selected_survivor_pr_number`, `report_path`, and `operator_override_json` so
  stale selections cannot release a new head. `survivor-merged` rows are not
  reactivated by a repeated duplicate census because loser closeout may still be
  in progress for the already-merged survivor.
- `deactivateMissing` marks active advisory or adjudication families inactive only when the
  current census observed at least one persisted candidate from that family and
  no longer returns the family key. Families that are absent solely because all
  candidates fell outside a windowed polling slice remain advisory until a later
  observation proves they no longer have two live unsuppressed candidates.
  `survivor-merged` families remain active until
  `reconcileDuplicateFamilyCloseouts()` resolves them, even if the census no
  longer returns the family key while loser closeout is in progress.
  Absence from the watcher slice is never written back as `pr_state='closed'`;
  only an observed subject state may change the cached PR state.
- `reconcileDuplicateFamilyLabels()` writes the GitHub labels after each census:
  active unresolved unsuppressed candidates receive `duplicate-family` and
  `duplicate-family-hold`; suppressed candidates receive only
  `duplicate-family`; operator-selected survivors receive
  `duplicate-family-survivor`; non-suppressed losers receive
  `duplicate-family-loser`; inactive and resolved families have watcher-owned
  duplicate-family labels removed, while individually released candidates have
  `duplicate-family-hold` removed. Removal is attempted from the evaluated
  family state rather than from the cached `labels_json`, and successful label
  writes update `labels_json` so later ticks do not repeat the same GitHub
  mutation. The hold releases after the census no longer sees two live
  unsuppressed candidates, after an operator suppression label is observed for
  that candidate, after an exact-head `ignored-not-duplicate` override, for the
  exact selected survivor head, or after the family reaches `resolved`.
- `reconcileDuplicateFamilyCloseouts()` runs after label reconciliation only
  when the census for the tick is verified and merge authority is armed. It
  re-reads the selected survivor and each loser from GitHub before mutating,
  confirms the survivor is merged at the selected head, skips selections whose
  audit comment remains pending, skips suppressed
  candidates and ignored candidates even when an ignore is stale, comments with
  the survivor/report audit trail, closes only open non-suppressed losers, and
  marks the family `resolved` only after no stale ignored, unadjudicated, or
  moved-head candidate still needs operator re-adjudication. Comment dedupe
  reads every page of loser comments. A failed selection audit comment leaves
  the selection pending for an exact-head CLI retry and never restores an old
  database snapshot over concurrent watcher updates.
- Operator overrides are not deleted automatically. If the override references
  a candidate whose head moved, the override is marked stale for that observed
  head without regenerating the stale timestamp on later identical polls.
- Missing or transiently unreadable dispatch provenance disables the duplicate
  census for the tick rather than deactivating existing active families. When a
  census tick fails, label reconciliation refuses to add or re-add
  watcher-owned duplicate-family labels from unverified persisted state; a later
  successful census is required before new hold projection resumes.
- The tables contain no secrets; JSON payloads store PR metadata, labels,
  provenance resolution state, and operator disposition metadata only.
