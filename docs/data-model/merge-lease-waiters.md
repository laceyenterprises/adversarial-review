# Data Model — Merge Lease Waiters

**Owner:** AMA daemon and hammer merge lane
**Store:** `data/merge-leases/<repo-slug>__<base>.waiters.json`
**Source of truth:** `src/ama/merge-lease.mjs`

The version-1 document contains `schemaVersion`, `updatedAt` and `waiters`.
Legacy bare arrays remain readable. Each waiter records `repo`, `base`, positive
integer `pr`, exact `head`, `waiterId`, `arrivedAt`, `updatedAt`, numeric `attempt`,
positive integer `holderPid`, `holderHost`, and `deadlineSeconds`.

LAC-2098 adds optional positive integer `acquisitionPid` to ordinary CLI
waiters. It identifies the acquiring CLI on `holderHost`; `holderPid` still
identifies the parent/caller that owns the resulting holder lease. Each CLI
invocation registers a fresh UUID-based waiter ID and never adopts a request by
matching parent, PR and head. Cleanup uses `removeMergeLeaseWaiter` with optional `expectedAcquisition:
{ pid, host }`: removal rechecks the ID and recorded acquisition PID/host under
the mutation lock. Missing or rebound metadata preserves the uncertain request,
including adoption by an older CLI. Canonical callers omitting this fence retain
exact-ID removal. This invocation cleans up on timeout, interruption or runtime
failure. SIGINT, SIGTERM and SIGHUP return
retryable exit 75 with `reason: "lease-wait-interrupted"` and `signal`, refund the
provisional gate attempt, and run cleanup in `finally`. Handled signals abort
the pending poll timer; refund and cleanup waits remain uncanceled. Cleanup
attempts the canonical removal under the per-base
mutation lock at most three times, separated by 250ms waits. A failed cleanup
warns; dead-acquirer pruning recovers after an uncatchable exit or lock failure.
Successful acquisition already removes its waiter under the holder lock.

Early pruning requires a same-host PID probe returning exactly `false` (the
default probe treats only ESRCH as death). Live or reused PIDs, unknown/throwing
probes, invalid identities, missing hosts and foreign hosts cannot authorize
early pruning. No start-time mismatch authorizes pruning: a reused PID is
conservatively retained until the existing arrival deadline. Legacy rows without
`acquisitionPid` retain their existing
`holderPid` rule: older CLIs could adopt another invocation's waiter ID, so even
an apparently well-formed `cli_<pid>_<epoch-ms>_<pr>` ID cannot establish the
current acquirer's identity. A dead PID encoded there never authorizes new early
pruning; a live parent conservatively retains that row until cleanup or expiry.
Daemon reservations use the same confirmed same-host death rule for their owning watcher PID. Expiry remains the bounded fallback for uncertain identities. These
rules run under the existing mutation lock during selection and release-wake
pruning; they neither release a holder nor change its identity fence.

LEASEFAIR-01 adds optional `priority: "daemon"`. Missing priority means an
ordinary closer. All roles share arrival order, preserving insertion order for identical timestamps.
The legacy priority field identifies the role and carries no scheduling boost. Refreshing
a request retains its arrival and insertion order. Queue selection, atomic
holder creation, and served-waiter removal share the existing per-base mutation
lock, so a closer cannot read an empty queue then acquire ahead of a newly
persisted reservation. Successful acquisition persists waiter removal before
releasing that lock; it never depends on reacquiring a cleanup lock. A failed
waiter-removal write rolls back the new holder and propagates the error.

`acquireDaemonMergeLease` registers `daemon_<pr>_<head>` on every acquisition
attempt. This identity survives watcher passes. A dead same-host owner loses its arrival
position; a replacement watcher re-enters at the tail. A daemon
reservation expires after at least twice the watcher's configured poll interval
(default 300 seconds), scaled once by the existing load-aware timeout policy.
The stored whole-second deadline is capped at `floor((2^31 - 1) / 1000)`, so
conversion to milliseconds remains within the JavaScript timer limit. A confirmed dead same-host owning watcher is pruned before selection.
Direct `upsertMergeLeaseWaiter` callers may supply a nominal `deadlineSeconds`
for daemon waiters, scaled once like closer deadlines. An already-sized
`effectiveDeadlineSeconds` takes precedence for either class without rescaling.
Ordinary waiters retain their existing arrival-based deadline and dead-process
cleanup. Expired reservations lose their old arrival order on renewal.
Acquisition removes the matching waiter. Watcher eligibility exits, head moves,
terminal outcomes and merge completion remove the PR's obsolete reservation
immediately; only eligible lease contention retains it. An absent daemon's
reservation still expires after the stored deadline.
LAC-2087 extends that cleanup boundary to the posted-review candidate handler:
an operator skip, terminal candidate, or moved head can exit before closure ever
attempts another acquire. Only the nested daemon `lease-contended` result keeps
the current reservation. A concrete coexistence promise that outlives the caller’s
soft deadline owns its own reservation scope until settlement. Terminal and
stacked-base exits before closure dispatch, and rejected operations, remove the
reservation; eventual eligible lease contention retains it. The
long-lived watcher PID proves service liveness,
not an active acquire. Cleanup uses the existing per-base mutation lock and
removes only this PR's obsolete daemon requests; ordinary waiters, other PRs'
requests and holder fences remain intact.
Cleanup requires a resolved head; an absent head leaves existing reservations
intact while the caller's attempt handles the unresolved candidate.

LEASEFAIR-04 makes both ordinary holder release and retryable-abort release
request one watcher wake when the first surviving waiter is a daemon. The wake
carries that waiter's PR and exact head, and uses the existing consumer's per-head
cap. A stale fence requests no wake. A failed wake write leaves the release
successful and ordinary watcher polling supplies recovery. No holder is
preempted, including a live same-host holder past its nominal deadline.
Release-wake pruning holds the same per-base mutation lock used by waiter
registration and cleanup; there is no separate waiter-file lock to acquire.

Contention results include `queuePosition` (one-based service order, or `null`
when the requester is absent from the pruned queue). The daemon
propagates it with `waitMessage: "waiting for the merge lease, position N"` into
watcher logs and the existing bounded-wait/page receipt. The existing page
deadline does not authorize a merge or turn contention into a safety hold.

This is a compatible optional-field extension, with no migration or config key.
Fair service requires daemon and closer acquisitions to use the updated lease
library; already running closer procedures finish under their existing fences.

LEASEFAIR-03 adds the CLI's `--wait-by-progress` mode for closers. `--wait`
becomes the nominal no-progress interval (900 seconds in the procedure), with a
six-hour nominal total ceiling. The existing load-aware helper sizes each bound
once and clamps to the platform timer limit. The waiter receives that already
sized ceiling without scaling again, preserving arrival order throughout the
wait. A decreasing service position or a newly observed grant/release/steal/
expiry resets the stall timer; arrivals and holder renewals do not. The overall
ceiling remains fixed even under continuous service. Ordinary
`--wait` and the compatibility `--wait-for-holder-deadline` retain their prior
wall-clock semantics without the new flag. Dead-holder reclamation is unchanged.

Timeouts name `lease-queue-no-progress` or `lease-wait-ceiling` and report the
[holders observed](merge-lease-history.md). Green exact-head closers refresh the
live head/check snapshot and record a deferred audit before each of up to two
in-run acquisition retries. They re-enter admission on every retry. Final green
exhaustion records `leaseWaitExhausted: true`, which requests the next closer
pass without charging failure counters. This does not waive any live merge gate.

No-merge release re-enters behind all arrivals already present, with optional
`notBefore` from the head's persistent exponential backoff. Delayed waiters do
not block ready requests. A served holder stores its optional `waiter` snapshot
so a fenced non-terminal release can reinsert the same reservation at its new
arrival time. The next acquiring CLI retains its unique invocation identity;
a dead prior CLI reservation is pruned normally. Terminal/merged releases do not
requeue. The daemon preserves transient retry reservations and withdraws
draft, closed, terminal, moved-head or declined reservations on its next pass.
Parking removes the reservation; retry evidence survives withdrawal.

CLI status/list projects `position` (one-based arrival order), `role`
(`daemon` or `closer`) and the stored `arrivedAt`. Polling starts at 250ms,
doubles to a nominal ceiling sized once by the load-aware helper: at least 30 seconds,
increasing with the nominal wait budget (one sixtieth) up to the existing watcher
poll interval,
and clamps each sleep to the remaining caller/stall budget. Signal cancellation
and fixed bounded cleanup retries retain their existing behavior.
