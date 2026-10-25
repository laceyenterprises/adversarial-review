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
