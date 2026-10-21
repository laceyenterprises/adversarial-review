# Reviewer run records

**Source of truth:** `src/adapters/reviewer-runtime/run-state.mjs`
(`writeReviewerRunRecord`, `readActiveReviewerRunRecords`,
`scanActiveReviewerRunRecords`), written by every reviewer-runtime adapter
under `src/adapters/reviewer-runtime/`. The CCX-08 lease field is set by
`src/reviewer-spawn-settle.mjs` and read by `src/agy-reviewer-identities.mjs`.

## Ownership

- Store: `data/reviewer-runs/<sessionUuid>.json`, plus `.stdout` / `.stderr`
  side channels with the same stem.
- Writers: the reviewer-runtime adapters (launch, heartbeat, settle).
- Readers: watcher startup recovery (adopt or settle a surviving reviewer),
  the agy identity pool (lease recovery), and the Gemini reservation reader
  for persisted spawn records (`reviewer-spawn-records.md`).

The run-state machine (`launching`, `heartbeating`, `spawned`, `completed`,
`failed`, `cancelled`) is described in `docs/STATE-MACHINE.md`.

## Shape

`sessionUuid`, `domain`, `runtime`, `state`, `pgid` (integer or null),
`spawnedAt`, `lastHeartbeatAt`, `reattachToken`, `adoptedAfterBounce`, and a
free-form `subjectContext`.

CCX-08 adds `subjectContext.agyIdentityLease: { user, reviewId }` to a Gemini
review that holds a lease on an agy reviewer identity (the HQ owner included).
It is absent on every other review.

ITP-12 adds `subjectContext.reviewerAccountReceipt` for declared Claude/Codex
reviewer pools. It contains canonical `identity`, opaque `tokenAccountId`,
`brokerProvider` (`provider` is its routing compatibility spelling), selection
`reason`, `evidenceGeneration`, the validated version-1 `selection`, and the
broker's secret-free `lease` (`account_id`, `lease_id`, numeric `generation`,
`request_id`, `identity`, `broker_provider`, `holder_user`, `expires_at`, `kind`,
`version`). `pooled: true` and `hold: false` distinguish an admitted binding.
No token bytes, credential paths or email addresses belong in this object.
Old records omit it; missing historical attribution stays unknown.

The session UUID is the execution request ID. Native auth preparation consumes
the receipt's provider; preference changes never rewrite it. Watcher renewal and
startup reconciliation use the original lease fence. An active record retains
occupancy even when a duplicate adapter invocation returns. Recovery releases
only after confirming process drain, and keeps the receipt in the terminal record.
Expiry cannot authorize a different account or release. A separate
`data/reviewer-token-leases/` journal survives missing/corrupt run records and
terminal delivery rows; reconciliation probes the recorded PGID and session UUID
before releasing. Unknown process evidence retains the journal for retry.
See [reviewer token leases](reviewer-token-leases.md).
This adds metadata to the existing states, without a new state or SQL migration.

## Lease recovery contract (CCX-08)

The identity pool keeps leases in watcher memory. On each readiness pass it
also scans the active run records, and an identity named by
`agyIdentityLease` in a record whose process group is alive (or which is
`launching` without one) stays unleased until that review ends.

The Gemini reservation reader for persisted spawn records reads the same field.
A surviving Gemini stage stops reserving its own seat only when its run record
carries `agyIdentityLease`, because the pool's adoption holds that seat. A
stage without the field, or one whose run record cannot be read, keeps its
seat reserved.

That scan is strict (`scanActiveReviewerRunRecords`): a record that exists but
cannot be read or parsed is reported, not skipped. While any active-state file
is unreadable, every identity this watcher does not already hold a lease on
stays out of the ready count, and its readiness reason names the unreadable
file(s). A damaged record could be the only evidence that a review from a
previous watcher still runs on an identity, and that review's child can be
between workspace extraction and starting agy, where the survivor process check
finds nothing. Repair or remove the named file to re-admit the identities; a
Gemini lane left with no ready identity pages the operator after the normal
alert interval. Startup recovery keeps using the lenient
`readActiveReviewerRunRecords`, which skips a corrupt record so one bad file
does not block recovery of the others.
