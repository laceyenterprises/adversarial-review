# Data Model - AMA Closer Leases

**Owner:** AMA closer ownership and terminal settlement
**Store:** `data/ama-closer-leases/`
**Source of truth:** `src/ama/closer-lease.mjs`
**Runtime surface:** `src/ama/dispatch-closer.mjs`, `src/ama/closer-terminal-cancel.mjs`

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
identify the launch window. A dispatched lease carries `lrqId`. Rekeys retain
`rekeyedFromHeadSha` and `supersededHeads` so the current lease can identify
the original dispatch record after the PR head changes.

The terminal `terminalOutcome` is one of `succeeded`,
`failed-without-merge`, `deferred`, `superseded`, `pr-merged-externally`,
`pr-closed-externally`, `no-merge:concurrent-writer`, or
`no-merge:pr-merged-externally`. Terminal leases are never demoted. The
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
until 30 minutes from the lease's `updatedAt` (falling back to `acquiredAt`),
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
