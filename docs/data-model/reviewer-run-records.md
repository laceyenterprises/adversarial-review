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

## Lease recovery contract (CCX-08)

The identity pool keeps leases in watcher memory. On each readiness pass it
also scans the active run records, and an identity named by
`agyIdentityLease` in a record whose process group is alive (or which is
`launching` without one) stays unleased until that review ends.

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
