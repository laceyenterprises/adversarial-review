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

## Repository/base queue (MGQ-01)

`migrations/20261023_finalization_queue.sql` adds four tables in the same app
store. `openFinalizationQueueStore` (exported from `ledger-store.mjs`) converges
this additive schema. Existing subject events and leases retain their meaning.
No caller or lane is activated by this migration or by opening the store.

| Table | Identity and durable fields |
|---|---|
| `finalization_queue_lane` | Primary key `(repository, base)`; monotonically increasing `generation`, `route_generation`, `owner_id`, `owner_state` (`idle`, `active`, `parked`), acquisition/heartbeat/expiry timestamps, reason, atomic readiness counter. Rows survive release so fences cannot repeat. |
| `finalization_queue_entry` | `entry_id`; unique `(repository, base, pr_number, admission_head, admission_generation)`; unique handoff, ack and readiness sequence within the lane; phase and JSON projection. |
| `finalization_queue_event` | Global append `seq`, lane, event type, event time, JSON payload. Lane index orders replay. Events are append-only; projection writes and events commit in one immediate transaction. |
| `finalization_queue_operation` | Globally unique operation id; lane, entry, owner/route generation, push/merge kind, immutable intent JSON and nullable result JSON. Null result means ambiguous, including a crash before invocation. |

Repository names normalize to lowercase. Base refs are case sensitive short
branch refs; full `refs/*` aliases and malformed branch refs are rejected.
Independent repositories and bases have separate counters, owners and locks.

An acknowledgement atomically allocates readiness and stores the entry and event.
Duplicate admission/handoff/ack identities return the original entry; conflicting
content fails. The entry JSON retains admission head/generation, handoff and ack
ids, expected old head, candidate, exact base, proof, checks, decision, delivery,
reason, original acknowledgement time and patience. Signed evidence and handoff
coverage validation belong to the subsequent handoff adapter; a storage ack
alone grants no eligibility or remote mutation permission.

Patience records `startedAt`, `nominalMs=1800000`, `effectiveMs`,
`ceilingMs=3600000` and absolute `deadline`. Scaling occurs once at first ack.
Duplicate ack, readmission, phase changes, base movement and replay cannot replace
it. Per-call waits scale nominal inputs once, then clip to the remaining absolute
deadline, finite ceiling and Node timer ceiling. Expired waits return zero.
Owner expiry is caller-supplied policy time, never load-scaled patience.

Actionable phases are `acknowledged`, `ready`, `rebasing`, `publishing`,
`waiting-checks`, `finalizing`. Only their first entry by readiness sequence can
advance or issue a mutation. `merged`, `returned-to-closer`, `closed-observed`
are terminal for this admission. `parked-hold`, `parked-permission` and
`parked-infrastructure` are outside actionable order; readmission explicitly
allocates a new readiness sequence at the tail without replacing patience.
Repaired terminal admissions require a fresh admission generation.

`foldQueue` replays acknowledgements, progress, owner changes and operation
intents/results independently of the subject eligibility fold. It accepts a
snapshot for tail replay. Unknown event types do not change that projection.

### Mutation and takeover safety

`createQueueOwner` is exported from `executor-lease-store.mjs`. It resolves the
single-host `fs-ext` adapter against the actual canonical DB/root and directory
owner. Every claim, renewal, release and remote issuance uses the same per-lane
nonblocking kernel lock. Lock files under `data/finalization-queue-locks/` must
never be removed/replaced during operation. The DB and locks must share one
local filesystem/root; multi-host ownership is unsupported.

The lock spans durable intent, adapter invocation, completion/drain and result
append. A paused issuer keeps the lock: takeover returns
`owner-operation-in-flight` without transferring ownership. A process paused
outside issuance may lose its generation; on resuming it fails the DB fence
before invocation. Progress, renew and release check owner id, generation,
route generation, active state and unexpired owner time. Release never deletes
the generation counter and refuses unresolved intents. Operation ids deduplicate
before invocation, including retries in the same timestamp tick.

An adapter invocation must include all associated requests and subprocesses in
its lifetime and must not resolve before they drain. An exception or unproven
result retains the intent. After a crash, acquiring a lock does not prove that
remote work or orphaned subprocesses stopped. Before transferring ownership,
an injected recovery adapter must stop/drain the previous execution tree and
return authoritative outcomes for **every** unresolved operation, plus source
references for both drain and outcomes. The core has no default remote recovery
adapter. Missing, partial or unreadable proof parks the lane with
`prior-operation-quiescence-unproven`; elapsed expiry never manufactures proof.
A later recovery attempt can reconcile these intents under the lock.

After drain and intent reconciliation, publication recovery consumes a live
observation with provenance: candidate head plus unchanged base resumes checks;
expected old head resumes publication with a **new** operation id after proven
non-application; an unrelated head returns to the closer. Outside base movement
returns to rebasing and clears checks under the original deadline. Unknown or
merged lifecycle observations park for the later authoritative merge receipt
reconciler. These primitives do not replace final eligibility, holds, expected
head push/merge protection, credentials or the emergency execution brake; later
executor slices compose those adapters before any live route exists.
