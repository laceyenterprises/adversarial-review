# Data Model - AMA Closer Leases

**Owner:** AMA closer ownership and terminal settlement
**Store:** `data/ama-closer-leases/`
**Source of truth:** `src/ama/closer-lease.mjs`
**Runtime surface:** `src/ama/dispatch-closer.mjs`, `src/ama/closer-terminal-cancel.mjs`

## Unreceipted intents (LAC-2081)

A `dispatching` intent now prevents the stale-lease reaper from releasing its
lease or refunding a presumed phantom attempt. The keyed native reconciler may
promote a matching dead-owner pending lease after receipt proof, or terminalize
it as `deferred` after proof that submission never began. Lease updates serialize on the existing reclaim flock; native repair
compares the complete expected owner under that fence before transition. Busy
or changed mutation ownership defers the repair. Live, foreign-host,
replaced and unrelated receipted leases remain unchanged. Missing lease evidence
alone never proves absence of a launch. See
[the intent contract](ama-closer-dispatches.md#interrupted-dispatch-intents-lac-2081).

## Purpose

One file per `(repo, prNumber, headSha)` protects a closer launch against
duplicate watcher ticks. `status` moves from `pending` to `dispatched` to
`terminal`; a pending lease may become terminal when no launch occurred.
HAMCLOSE-01 also permits `dispatched → handed-to-review`. The canonical daemon
owner runs `bin/hammer-review-handoff.mjs`, which rekeys a moved head and completes
the bounded local exact-head review request before recording the transfer.
Thrown requests leave the lease dispatched for failure settlement and retry.
A handed lease no longer blocks review or daemon merge; later worker failure,
deferral or supersession cannot demote it to a terminal failure. Findings from
that review may acquire a fresh hammer lease through `fromReviewHandoff` under
the sibling `.handoff.lock` exclusive flock and atomic single-claim acquisition.
Clean reviews use daemon merge. Existing hammer retry and lifetime caps remain.
`acquiredAt`, `updatedAt`, `watcherPid`, `host`, and `dispatchTimeoutMs`
identify the launch window. LOADAR-01 records the load-aware effective
subprocess budget in `dispatchTimeoutMs`; pending-lease expiry consumes that
value once, including the existing retry and token-poll overhead. Nominal
pending fallback and dispatched/unknown reclaim ages use the shared load-aware
helper. Confirmed live launches still retain ownership at any age; no store
fields or lifecycle states change. A dispatched lease carries `lrqId`. Rekeys retain
`rekeyedFromHeadSha` and `supersededHeads` so the current lease can identify
the original dispatch record after the PR head changes.

The terminal `terminalOutcome` is one of `succeeded`,
`failed-without-merge`, `deferred`, `superseded`, `pr-merged-externally`,
`pr-closed-externally`, `no-merge:concurrent-writer`, or
`no-merge:pr-merged-externally`. Terminal leases are never demoted in place. TERMLEASE-01 removes a terminal
`superseded`, `failed-without-merge` or `deferred` lease immediately when its
launch is terminal in the ledger or a matching dispatch record, or the ledger
confirms the launch is absent. Positive live launch/retry evidence and unreadable
retry chains retain ownership. Unknown evidence without a terminal dispatch
record retains the lease. Reclamation uses a nonblocking sibling `.reclaim.lock`,
revalidates the observed lease after evidence reads, then removes it and uses the
existing exclusive acquisition CAS on the same pass. It emits
`ama_closer.terminal_lease_reclaimed`; retry and lifetime caps still apply.
`succeeded` remains sticky. A superseded dispatch records its outcome on the
dispatch record and releases its matching rekeyed lease, preserving any successor
lease and completed review handoff. No store fields or status values change. The
pending reclaim age includes the configured dispatch timeout and retry and
token-poll windows; dispatched leases use their separate stale boundary. A
launch-only dispatch record remains active for that full pending reclaim
window. Dispatch-record listing reads leases without deleting them; pending
lease reclamation belongs to the closer dispatch path after its owner or age
check, and a transient worker status-probe error does not terminate a
dispatched lease. A
closed PR's expired pending lease with no launch ID is deleted, allowing a
reopened PR to acquire a fresh lease. `pr-closed-externally` and
`no-merge:concurrent-writer` are reclaimable terminal outcomes.

`reconcileAmaCloserLease` settles terminal launch ownership before ordinary
closer admission or follow-up claims. A bare `succeeded` process exit on a confirmed live OPEN same head settles
as `failed-without-merge` under the existing caps after the 60-second
terminal settlement grace when `terminal_at` is readable; a missing timestamp
allows immediate same-head settlement. Both synchronous follow-up and asynchronous
watcher probes request `autoMergeRequest`. Armed auto-merge holds ownership only
until the load-aware 30-minute base from the lease's `updatedAt` (falling back to `acquiredAt`),
without refreshing that clock on observation. A no-merge audit bypasses the hold.
At the bound an OPEN terminal launch settles as `failed-without-merge`, so ordinary
retry/refund caps can admit CI repair even while GitHub auto-merge remains armed.
Release emits `ama_closer.auto_merge_hold_released` with the PR and launch ID.
Without live head proof, the existing settlement grace and ownership bound apply.
The active dispatch-record guards still apply. A terminal audit or PR-scoped merged signal permits settlement. Merge
signals cover rekeyed leases too: their stored SHA can be a merge commit,
so lookup does not filter by the current or original lease head. Without an
audit or merge evidence, other terminal launches settle as `superseded` when
the lease was rekeyed to an advanced head, otherwise `failed-without-merge`;
operator-triage statuses settle as `deferred`.
