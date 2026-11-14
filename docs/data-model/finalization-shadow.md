# Data Model - Finalization Shadow Observations

**Owner:** ARC-16 Merge Authority v2 shadow mode
**Store:** `data/reviews.db`
**Source of truth:** `migrations/20260718_finalization_shadow.sql` and additive shadow migrations
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

- The daemon appends observations. Human triage writes individual overrides or
  pattern records and audited revocations; existing observations are not backfilled.
- Reports open the existing database read-only with SQLite `query_only = 1`.
- Overrides must run as the canonical daemon/data-directory owner. The writable
  store refuses cross-user opens before SQLite can create or modify WAL files.
- The schema source of truth is
  `migrations/20260718_finalization_shadow.sql`; keep this document and
  `docs/data-model/catalog.json` current with persistent-shape changes.

## Queue observations (MGQ-07)

The additive `migrations/20261028_finalization_queue_shadow.sql` adds
`idx_finalization_shadow_dedupe`, a unique expression index on the optional
`payload_json.dedupeKey`. Existing rows retain their schema and append behavior.
Writable store convergence applies the index; reports and probes never migrate.
A queue observation requires a key. Atomic insert-on-conflict returns the
original row and its operator disposition, including after restart.

The payload also carries `queue`: observation mode, organic/synthetic source,
consumer identity/build, canonical lane and entry, admission kind, current and
candidate head/base, readiness order/position, proposed rebase/check/final
eligibility, provenance references and durable lane lifecycle events. The key
hashes the source snapshot, ledger, v1 action and policy plus proposed outcome;
it excludes consumer process/build and delivery time. Head/base moves, changed
order/evidence and deadline-expiry outcomes remain distinct pairs. Repeated
identical observations retain the original timestamp; this is the latest unique
pair time, not a consumer heartbeat.

Queue differences start open. Queue annotations require `direction`
(`v1-defect`, `v2-suspect`, `benign`, or `open`), `principal`, `note` and `at`, in
addition to `disposition`. Reports retain this decision evidence alongside both
proposals. Store/fold/read failures produce unknown/escalation with open triage;
an unavailable write returns `persisted: false` and the unknown observation to
the caller for the existing escalation route. It cannot persist evidence into an
unavailable database. No pager is called by shadow.

Queue metrics reconstruct unique admissions and transitions from lifecycle
history, including history before the report window. Rates use the requested
window's hours; service samples are merged entries with a recorded first
`rebasing` transition. Total/mean service spans first rebase through authoritative
`merge.mergedAt` (or the recorded terminal transition in replay fixtures),
including waits/parking. Check waits, infrastructure parking and hold/permission
intervals are separately clipped to the window. Returns count transitions to
`returned-to-closer`; remediation execution time outside the queue is unmeasured.
Readiness age uses acknowledgement or the latest tail-readmission sequence,
never poll time. Reports disclose valid/unknown pair counts, unique entry counts,
completed service denominator and window; they separate organic and synthetic
cohorts. Synthetic evidence cannot supply organic promotion coverage.

## Live snapshot pairs (MLR-07)

The next-action observer supplies sourced legacy-lane facts through the same
ledger and shadow stores. Optional `payload_json.live` holds `source: organic`,
the repository/base lane, v1 source reference, observed terminal outcome and
proposed divergence classification. The existing `dedupeKey` index also
deduplicates these pairs. Live disagreements start open; their annotations
require the same direction/principal/evidence note as queue disagreements.
Ingestion and comparison append share a transaction; no execution adapter is
available. Translation/read/fold failure persists an escalate pair. An unavailable
store produces a local diagnostic rather than fabricated durable evidence.
Lightweight snapshots may omit observation domains without producing fold errors;
explicit failed or unreadable refreshes of settled facts still escalate. Repeated
polls append comparison telemetry, but unchanged facts do not grow the ledger.
Live ingestion reuses a bounded single-root database handle and schema setup.
Both SQL coverage readers and report fallback exclude any row carrying non-organic
live or queue provenance from elapsed coverage, head moves and exhaustion counts.

The report's `promotionGate` counts at least 50 distinct organic terminal subjects,
including terminal head-move/exhaustion examples, all historical divergence
dispositions and unresolved fold errors. Polls, dispatches, synthetic samples
and older unprovenanceable rows add no exercised volume. `mgqPromotable`
retains the existing coverage condition. `shadow` supplies row/subject/error
counts for the SRE-owned natural-traffic growth assertion. Reports remain
read-only and do not select routes or authorize promotion.

`live.ownerState` records the canonical next-action owner projection used by v2:
`live`, `actor`, `head`, `deadline`, `reason`, `decisionKey` and `evidenceRefs`.
Live-owner waits also retain this projection as `v2Decision.liveOwner`.
Terminal/refused, absent and expired owners remain distinguishable from an
unexpired owner. No SQL column or migration is added; older payloads can omit
these optional fields. This evidence does not change triage dispositions.

## Exact pattern dispositions (MLRDISPO-01)

`migrations/20261113_finalization_shadow_patterns.sql` adds
`finalization_shadow_patterns`. The versioned key is the JSON array
`["shadow-pattern-v1", v1Action.kind, v1DetailClass, v2Decision.kind, v2ReasonClass]`.
Classes are exact strings in `src/finalization/shadow-pattern.mjs`: recognized
static detail/reason text is preserved verbatim, and absent v1 detail is `null`.
No subject, head, source reference, timestamp, round, stage or deadline enters
the key. There is no trimming, substring matching, regex family or wildcard.
Unrecognized/dynamic text (including fold error messages and principal lists)
is unkeyable and cannot receive a pattern disposition. Adding classes requires
an explicit code change; unknown text never shares an auto-applicable fallback.
The report groups such rows under an explicitly unkeyable bucket.

| Column | Type | Contract |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Stable pattern record reference. |
| `pattern_key` | TEXT NOT NULL | Exact versioned key above. |
| `kind` | TEXT NOT NULL | `equivalent`, `v2-defect`, or `policy`. |
| `principal` | TEXT NOT NULL | Required nonblank principal, recorded verbatim. |
| `note` | TEXT NOT NULL | Required nonblank evidence rationale. |
| `ticket_ref` | TEXT nullable | Required for `v2-defect`: ticket ID or HTTPS reference. |
| `evidence_sample_ids_json` | TEXT NOT NULL | Nonempty observation ID array; each must be a matching, non-error divergence no later than creation. |
| `created_at` | TEXT NOT NULL | Explicit creation timestamp. |
| `expires_at` | TEXT nullable | Exclusive expiry, strictly after creation. |
| `revocation_json` | TEXT nullable | One-way `{ principal, note, at }` revocation; never deletes history. |

A partial unique index permits only one unrevoked record per exact key.
Revoke an expired record before adding its replacement. Revocation requires its
own principal/note/time, cannot predate creation, and cannot be overwritten.

Append and active-record lookup share a transaction. A non-error divergence
with a matching record, created no later than its observation time and not yet
expired or revoked, captures `payload_json.patternDisposition`: the pattern ID
and audit snapshot. `payload_json.patternKey` stores the key (or `null`). Caller
supplied pattern references are discarded. No record means no pattern override.
Expiry uses supplied observation time; revocation is effective immediately for
all future appends, including delayed observations. Duplicate keys return the
original observation and original disposition. Revocation/expiry never changes
past captured decisions. Evidence samples themselves remain unchanged.

Individual overrides take precedence, including an explicit `open` override.
Otherwise a captured pattern resolves the divergence, while preserving the
original classifier proposal and the pattern kind/ticket. Fold errors cannot be
auto-dispositioned; their separate promotion blocker still requires an individual
override. Pattern disposition acknowledges triage; it does not repair a defect
or authorize execution or promotion. Reports add `patterns` counts for each key:
`byPattern`, `byIndividualOverride`, `open`, `byClassifier`, and `total` within
the display window. Historical promotion checks use the same effective decision.
Reporting and pattern listing are read-only; listing an older schema returns an
empty pattern history without migration.
