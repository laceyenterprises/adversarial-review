# Data Model - Finalization Shadow Observations

**Owner:** ARC-16 Merge Authority v2 shadow mode
**Store:** `data/reviews.db`
**Source of truth:** `migrations/20260718_finalization_shadow.sql`
**Runtime surface:** `src/finalization/shadow-store.mjs`

## Purpose

`finalization_shadow` records the v1 action and proposed v2 finalization
decision observed at each shadow tick. It is telemetry only: shadow execution
does not act on the proposal. Reports compare the two paths, apply any human
triage override, and evaluate the promotion criteria described in
`docs/finalization-shadow-divergence-triage.md`.

## Table

Table: `finalization_shadow`

| Column | Type | Null | Contract |
|---|---|---:|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | no | Stable observation identifier and append order tie-breaker. |
| `domain_id` | `TEXT` | no | Subject domain identifier. |
| `subject_external_id` | `TEXT` | no | External subject identifier within the domain. |
| `revision_ref` | `TEXT` | yes | Revision observed for the tick, when available. |
| `observed_at` | `TEXT` | no | ISO-8601 tick time used for report windows. |
| `relation` | `TEXT` | no | Whether v1 and v2 agree or diverge. |
| `direction` | `TEXT` | no | Proposed attribution: v1 defect, v2 suspect, open, or benign. |
| `divergence_class` | `TEXT` | yes | Known divergence fingerprint, if classified. |
| `disposition` | `TEXT` | no | Classifier proposal: `resolved` or `open`. |
| `v1_action_kind` | `TEXT` | no | Frozen v1 action kind. |
| `v2_decision_kind` | `TEXT` | no | Pure v2 decision kind. |
| `fold_error` | `INTEGER` | no | Boolean marker that v2 folding failed. |
| `saw_head_move` | `INTEGER` | no | Boolean promotion-coverage evidence. |
| `saw_exhaustion` | `INTEGER` | no | Boolean promotion-coverage evidence. |
| `payload_json` | `TEXT` | no | Full v1 action, v2 decision, and classification payload. |
| `disposition_override_json` | `TEXT` | yes | Human override `{ disposition, note, principal, at }`. |
| `recorded_at` | `TEXT` | no | SQLite insertion timestamp. |

## Indexes

- `idx_finalization_shadow_observed_at` supports bounded report windows.
- `idx_finalization_shadow_subject` on
  `(domain_id, subject_external_id, id)` supports subject history reads.

## Operational Contract

- The daemon appends observations; the only update is an explicit human
  disposition override.
- Reports open the existing database read-only with SQLite `query_only = 1`.
- Overrides must run as the canonical daemon/data-directory owner. The writable
  store refuses cross-user opens before SQLite can create or modify WAL files.
- The schema source of truth is
  `migrations/20260718_finalization_shadow.sql`; keep this document and
  `docs/data-model/catalog.json` current with persistent-shape changes.
