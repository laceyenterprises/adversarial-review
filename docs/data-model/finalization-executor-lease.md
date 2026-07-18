# Data Model - Finalization Executor Lease

**Owner:** ARC-17 Merge Authority v2 leased executor
**Store:** `data/reviews.db`
**Source of truth:** `migrations/20260719_finalization_executor_lease.sql`
**Runtime surface:** `src/finalization/executor-lease-store.mjs`

## Purpose

`finalization_executor_lease` serializes MA-v2 finalization execution to exactly
one writer per subject (`docs/SPEC-merge-authority-v2.md` §4). The lease lives in
the app store — **never** in GitHub labels — so a restarted executor folds the
ledger and re-acquires without trusting in-memory progress (the HCM-01
crash-resume class). Exactly one row exists per subject (the primary key).

## Table

Table: `finalization_executor_lease`

| Column | Type | Null | Contract |
|---|---|---:|---|
| `domain_id` | `TEXT` | no | Subject domain identifier (part of the primary key). |
| `subject_external_id` | `TEXT` | no | External subject identifier (part of the primary key). |
| `lease_id` | `TEXT` | no | Opaque per-acquisition fence token. Release/renew present it exactly; a mismatch is a stale holder and is refused. |
| `holder` | `TEXT` | no | Opaque holder identity (e.g. `pid@host` or a worker id) for diagnostics. |
| `revision_ref` | `TEXT` | yes | Revision the holder acquired the lease to act on. |
| `acquired_at` | `TEXT` | no | ISO-8601 caller-supplied acquisition time. |
| `deadline` | `TEXT` | no | ISO-8601 caller-supplied expiry; after it a contender may steal the lease. |
| `updated_at` | `TEXT` | no | ISO-8601 last renew/acquire time. |
| `recorded_at` | `TEXT` | no | SQLite insertion timestamp. |

Primary key: `(domain_id, subject_external_id)` — one lease row per subject.

## Operational Contract

- **Acquisition** is an atomic `INSERT ... ON CONFLICT DO NOTHING`; an expired
  lease is stolen by a compare-and-set `UPDATE` fenced on the observed
  `lease_id` and parsed `deadline <= now`, so mixed ISO timestamp precision
  cannot delay an exact-boundary steal and two concurrent stealers cannot both
  win.
- **Release and renewal are fenced on `lease_id`.** A stale holder can never
  delete or extend a newer holder's lease. Renewal preserves the existing
  `revision_ref` unless the caller explicitly supplies a replacement.
- **Time enters only as caller-supplied data** (`now`, `deadline`); the store
  reads no clock, so lease outcomes are deterministic and testable in-memory.
- Writable opens must run as the canonical data-directory owner; the store
  refuses cross-user opens before SQLite can create WAL files (mirrors the
  finalization ledger and shadow stores).
- The schema source of truth is
  `migrations/20260719_finalization_executor_lease.sql`; keep this document and
  `docs/data-model/catalog.json` current with persistent-shape changes.
