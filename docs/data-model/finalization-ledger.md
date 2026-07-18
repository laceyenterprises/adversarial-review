# Data Model - Finalization Ledger

**Owner:** ARC-15 Merge Authority v2
**Store:** `data/reviews.db`
**Schema surface:** `migrations/20260717_finalization_ledger.sql`
**Runtime surface:** `src/finalization/ledger-store.mjs`

## Purpose

`finalization_ledger` is the append-only, per-subject event ledger for Merge
Authority v2. It records finalization facts for a subject: head revisions,
review verdicts, check-settlement observations, attestations, remediation
dispatch/conclusion events, budget exhaustion, operator overrides, and terminal
finalized/closed/escalated/halted marks.

Eligibility is not stored as mutable state. Consumers replay rows for one
subject in `seq` order through `src/finalization/ledger-fold.mjs`, then pass the
projected state to `src/finalization/eligibility.mjs`.

## Table

Table: `finalization_ledger`

| Column | Type | Null | Contract |
|---|---|---:|---|
| `seq` | `INTEGER PRIMARY KEY AUTOINCREMENT` | no | Global append order for replay. |
| `domain_id` | `TEXT` | no | Subject domain, such as a repo or integration domain. |
| `subject_external_id` | `TEXT` | no | External subject id inside the domain. |
| `event_type` | `TEXT` | no | Finalization event vocabulary name. Unknown future types are preserved for forward-compatible folds. |
| `revision_ref` | `TEXT` | yes | Revision-scoped event head/reference. Subject-scoped events leave this `NULL`. |
| `at` | `TEXT` | no | ISO-8601 event time. Time enters the fold only through this data. |
| `source_ref` | `TEXT` | yes | External provenance, such as a GitHub review commit id, check-run id, or ledger row id. |
| `idempotency_key` | `TEXT` | yes | Append idempotency key for dispatch-style replay. |
| `payload_json` | `TEXT` | no | JSON object carrying type-specific fields not promoted to columns. Defaults to `{}`. |
| `recorded_at` | `TEXT` | no | SQLite write timestamp, defaulting to `datetime('now')`. |

## Indexes

- `idx_finalization_ledger_subject` on `(domain_id, subject_external_id, seq)`
  supports full subject replay in append order.
- `finalization_ledger_idempotency_unique` is a partial unique index on
  `(domain_id, subject_external_id, event_type, idempotency_key)` when
  `idempotency_key IS NOT NULL`, so replaying a dispatch append cannot duplicate
  durable work while events without idempotency keys remain unconstrained.

## Event Mapping

`src/finalization/ledger-store.mjs` stores these event fields in dedicated
columns: `type`, `subjectKey`, `revisionRef`, `at`, `sourceRef`, and
`idempotencyKey`. All remaining event-specific fields are serialized into
`payload_json`.

Writes are strict: `append()` validates events through `makeFinalizationEvent`
before inserting. Reads preserve forward compatibility: known event types are
rehydrated through the strict constructor, while unknown future event types are
returned losslessly so older folds can ignore semantics they do not understand.

## Operational Contract

- Rows are append-only. No update or delete path is part of the Merge Authority
  v2 contract.
- A crashed executor resumes by reading and folding the subject ledger from the
  beginning.
- External facts must carry `source_ref` provenance whenever the producer has a
  durable external identifier.
- The canonical schema owner is this document plus
  `migrations/20260717_finalization_ledger.sql`; update both when the persistent
  shape changes.
