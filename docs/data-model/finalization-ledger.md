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

## Durable closer handoff (MGQ-02)

`migrations/20261024_finalization_queue_handoff.sql` adds
`finalization_queue_handoff` in the same store. `openFinalizationQueueStore`
converges both additive queue migrations. No runtime route is installed.

| Column | Contract |
|---|---|
| `handoff_id` | Globally unique submitter id; conflicting reuse is refused. |
| `entry_id` | Unique reference to the acknowledged lane entry. |
| `repository`, `base`, `pr_number`, `admission_head`, `admission_generation` | Unique admission tuple. Repairs require a fresh generation. |
| `payload_digest` | SHA-256 of canonical handoff JSON, also retained in entry/event `handoffDigest`. Object-key order is irrelevant; arrays and signed fields are retained. |
| `handoff_json` | Immutable submitted identity, provenance and complete finding dispositions. |
| `evidence_json` | Immutable trusted observations, including original signed records and verification references. |
| `ack_json` | Immutable admission tuple, entry/handoff/ack ids, digest, original readiness sequence and acknowledgement time. |

`createQueueHandoffService({store, evidenceAdapter})` is a composition-only v2
port. `submit(handoff, {deadline})` returns the persisted ack;
`readAcknowledgement(admission)` and `readReceipt(admission)` read it back.
`resolveQueueHandoffStore` supplies the shared durable reader/writer. Read-back
checks the receipt digest and entry linkage, failing closed on inconsistencies.
An MGQ-01 storage-only acknowledgement has no validated handoff receipt and
cannot establish closer completion.

Handoff schema version 1 contains `lane`, `prNumber`, `head` (pushed head),
`admissionGeneration`, `handoffId`, `worker` and `closer` (each has worker id,
worker class and launch-request id), `sourceReview` (`id`, `commitId`), produced
and reviewed attestation references, primary-change intent/reference,
exact-head validation/publication references, and `dispositions`. Each
disposition retains review id/commit, finding id/severity, evidence head,
source reference and concrete fenced evidence. `fixed` also requires changed
paths; `withdrawn` requires an explanation and source path/line locations.
Acknowledgement and budget exhaustion are never finding dispositions.

Canonical handoff/evidence JSON accepts ordinary and null-prototype dictionaries
with JSON values; dictionary prototypes and object-key order do not affect the
digest. Arrays retain their order and non-JSON values remain invalid. Commit SHA
syntax accepts lowercase, uppercase and mixed-case 40-character hex. Original
SHA text, signed records and exact evidence/identity comparisons are preserved;
callers must use consistent SHA spelling across matching references.

The trusted adapter's `read({handoff, timeoutMs, signal})` is supplied by runtime
composition independently of the submitting closer. It must resolve sanctioned
live PR/review, identity, signature-verification, publication, primary-change
and validation reads; paginate the **complete applicable finding inventory**;
and honor the already-sized timeout and abort signal. Its observation fields are:

- `subject`: exact lane/PR, open state, pushed head and source reference.
- `review`: source id/commit/reviewer identity, `complete: true`, source reference and every
  applicable blocking/non-blocking finding, including other applicable reviews.
  Findings retain id, review id/commit, severity, source reference and currency.
- `currency`: independently proven review-to-pushed-head currency, using the
  existing review-currency vocabulary with a source reference.
- `identities`: successful independent worker/closer launch verification,
  matched identities and source reference.
- `attestations`: references, original signed records, verifier results and
  source references. Produced binds the closer launch/class to the pushed head;
  reviewed remains pinned to the original signed review commit. `valid` means
  cryptographic verification by the trusted surface, never a submitter flag or
  a signature-shape check.
- `primaryChange`, `localValidation`, `publication`: successful exact-head
  observations matching submitted intent/provenance references.

The validator compares inventory, complete coverage, currencies, identities,
signed subjects and provenance mechanically. It never calls a model or requests
another review of terminal adjudication. Missing/unreadable evidence refuses
acknowledgement. There is no default permissive identity fallback or production
evidence adapter in this slice; later composition must supply it before routing.

One immediate transaction stores entry, readiness/deadline, event, full handoff,
evidence and ack. Failure rolls everything back. Concurrent identical submissions
return the same entry/ack; conflicting reuse fails. After commit, lost-ack retries
need no remote read and retain the original infrastructure patience. Evidence-read
and DB-lock waits each scale a nominal 5-second budget once, cap at 30 seconds
and clip to the remaining submission deadline (default 30 seconds). The actual
read timer aborts and refuses late evidence. DB wait settings are restored.
Owner expiry remains independent of submission and entry patience.

`createCloserQueueHandoffBoundary` in `src/ama/closer-queue-handoff.mjs` submits
and confirms the same durable ack before invoking an idempotent resource-release
callback. Failed publication, unconfirmed replies or store errors cannot claim
completion or release resources. A retry can confirm/release after a lost reply.
Its `dispatch()` suppresses duplicate closer launch only for a validated receipt
at that exact admission tuple; unknown reads fail closed. Later lane routing must
compose both methods. Legacy dispatch and `bin/hammer-review-handoff.mjs` remain
unchanged; the compatibility helper still marks retry and is not a queue ack.

Bot derivations attach to the entry candidate/proof and original `handoffDigest`.
They never rewrite dispositions, signed heads, subjects or signatures. The focused
fixture advances a candidate and replays events while asserting the complete
original receipt is unchanged. Rebase preservation and final eligibility belong
to their later slices; handoff storage alone grants no merge permission.

## FIFO admission and clean reviews (MGQ-03)

`migrations/20261025_finalization_queue_admission.sql` adds the app-owned
`finalization_queue_clean_review` table: `entry_id` is the primary/reference key,
`input_json` retains the immutable direct-admission request, and `evidence_json`
retains trusted signature, identity, review, publication and validation reads.
Opening the writable queue store converges all three queue migrations.

`createCleanReviewService` accepts the same provenance envelope as a handoff,
without `closer` or `dispositions`. The worker is the produced-attestation
principal. The source review must be signed at the exact admission head, have a
complete empty finding inventory and a settled-success verdict. Shared handoff
validation checks original signed subjects, producer identity, primary-change,
publication and validation evidence. No closer is dispatched or fabricated.
Missing signatures, findings or stale evidence refuse admission atomically.
The trusted reader has the same verification responsibilities as MGQ-02.

Clean and remediated entry acknowledgements allocate readiness in the same
immediate transaction/counter. No timestamp, source class or priority changes
order. Deterministic ordering uses `(readiness_seq, entry_id)`. Duplicate clean
submissions return the existing entry, including its original acknowledgement
and patience; conflicting input is refused. The immutable receipt and initial
acknowledgement event retain the original evidence and readiness position.

`createQueueAdmissionService({store,liveAdapter})` consumes validated receipts
and exposes `reconcile({fence,entryId,deadline})` and `order(lane)`. A trusted live
reader supplies fresh exact lane/PR/head/base SHA/state/complete labels, identity,
branch push rights, repository rules and existing structural eligibility inputs,
all with source references. Normal clean admission also requires the final live
current-head review read; the complete terminal-remediation receipt uses the
existing exception without another review or model judgement. An empty handoff
inventory still requires the normal final current-head review read.

The shared `evaluateMergeEligibility` evaluates structural inputs and mandatory
primary-change evidence. Admission defers CI greenness and a mergeable BEHIND
branch to their execution phases, retaining the classifier result. It does not
set checks green or authorize merge. Unknown mergeability, rules or identity
park infrastructure; denied/unknown write rights park permission. Existing
operator hold labels and unreadable/malformed labels park hold. Closed/merged
observations become `closed-observed` with their live-state reason, without a
closer or an assertion that this queue merged the PR. A foreign head returns for
fresh adjudication. Execution phases remain owned by later executor recovery.

Every progress event increments retained `progressVersion` (older entries begin
at zero), fencing even identical observations within the same timestamp.
Entry JSON gains `admission`: kind, observation timestamp, live subject,
structural reference/classifier result, current review where applicable,
identity and permission observations. Progress events retain this history.
The writer compares the complete pre-read entry snapshot after each await;
superseded reads cannot overwrite newer holds/recovery even after a phase cycle.
The owner fence and original deadline are checked again inside the transaction.
Held/unreadable entries leave actionable order. Recovery requires fresh reads
and allocates readiness at the tail on the same entry; patience and history
survive. Repairs of terminal work require fresh evidence and a new admission
generation/entry. Duplicate wakes allocate neither another position nor patience.

Live reads and SQLite writer waits use nominal 5-second budgets scaled once,
clipped to the original entry/submission deadline with a 30-second finite ceiling
and Node timer cap. Clean submission defaults to a 30-second absolute bound;
entry patience remains nominal 30 minutes with a 60-minute ceiling. Read timers
abort and reject late evidence; SQLite busy settings are restored. An expired
entry parks rather than renewing its deadline. Owner expiry is not patience.

`resolveQueueAdmissionAdapters` and `resolveCleanReviewStore` also serve the
read-only deployed probe. It compares the real clean-review schema, resolves
actual receipt statements and reports counts by source/disposition plus a
bounded sample of at most 100 recent receipts. Availability establishes installed
storage/adapter capability, not live-reader composition, running watcher version,
execution routing or authority. Organic admission evidence can remain pending.
