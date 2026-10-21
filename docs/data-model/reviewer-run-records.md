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

ITP-11 adds `subjectContext.agyHolderLease` to leased Gemini reviews. It
contains the canonical `identity: gemini-reviewer`, `tokenAccountId`, holder
`user`, `hqOwner`, `reviewId`, unique lease `generation`, declaration
`evidenceGeneration`, `selectionReason` and `ownerPid`. The same receipt is mirrored into the
legacy `agyIdentityLease` field during rolling deployment. Historical
`agyIdentityLease: { user, reviewId }` records remain readable. The added-user
`agyIdentity` field remains a private runtime transport, never a GitHub or HCP
identity. Other review families do not receive these fields.

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

## Lease recovery contract (ITP-11)

The holder pool keeps a durable claim before spawn, described in
[agy execution holder leases](agy-holder-leases.md). Each readiness pass also
reads run records, preferring `agyHolderLease` and falling back to
`agyIdentityLease`. A live process group retains the holder even with an old
heartbeat or terminal run state. A launching record without a PGID is ambiguous
and holds too. Neither heartbeat expiry nor a terminal status proves exit.
Terminal records without a PGID do not hold admission. For terminal records
with a live PGID, the pool verifies the leader's start time against `spawnedAt`;
a proven mismatch releases that historical record's occupancy. Unknown start-time
evidence holds, including a missing leader while its process group remains alive.
The strict scanner's `includeTerminalAgyLeases` option includes these terminal
holder records; its default and the other runtime recovery readers retain
their existing active-state filtering.

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

## Follow-up subject fields (REMEDBRANCH-01)

The watcher supplies the PR head `branch` and original title-prefix `builderTag`
in `subjectContext` for every reviewer runtime. Agent-runtime records preserve
these alongside the runtime identity; watcher pass metadata retains both for
post recovery. The pass reaper forwards these fields into follow-up creation,
which holds and retries unresolved branches before any remediation worker starts.

## Common attribution projection (ITP-13)

New bound spawns also carry `subjectContext.reviewerAttribution`, the version-1
projection documented in [reviewer passes](reviewer-passes.md#review-execution-attribution-itp-13).
The CLI adapter passes only that allowlisted projection to the posting process;
full leases and private holder transport remain in the run record. Older
`agyIdentityLease` and `reviewerAccountReceipt` objects remain dual-readable.
Reattach projects their attribution into the matching pass without renaming a
historic subject, changing signed bytes, or rewriting this run record. Account
identity never determines the GitHub actor or HCP subject. The existing per-session
run paths, per-review holder scratch and per-PR reply paths remain unchanged.
