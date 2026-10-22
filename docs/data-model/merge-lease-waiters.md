# Data Model — Merge Lease Waiters

**Owner:** AMA daemon and hammer merge lane
**Store:** `data/merge-leases/<repo-slug>__<base>.waiters.json`
**Source of truth:** `src/ama/merge-lease.mjs`

The version-1 document contains `schemaVersion`, `updatedAt` and `waiters`.
Legacy bare arrays remain readable. Each waiter records `repo`, `base`, positive
integer `pr`, exact `head`, `waiterId`, `arrivedAt`, `updatedAt`, numeric `attempt`,
positive integer `holderPid`, `holderHost`, and `deadlineSeconds`.

LEASEFAIR-01 adds optional `priority: "daemon"`. Missing priority means an
ordinary closer. Daemon reservations precede closer requests; each class uses
arrival order, preserving insertion order for identical timestamps. Refreshing
a request retains its arrival and insertion order. Queue selection, atomic
holder creation, and served-waiter removal share the existing per-base mutation
lock, so a closer cannot read an empty queue then acquire ahead of a newly
persisted reservation. Successful acquisition persists waiter removal before
releasing that lock; it never depends on reacquiring a cleanup lock. A failed
waiter-removal write rolls back the new holder and propagates the error.

`acquireDaemonMergeLease` registers `daemon_<pr>_<head>` on every acquisition
attempt. This identity survives watcher passes and process restarts. A daemon
reservation expires 120 seconds after its last refresh; unlike a closer waiter,
it is not removed merely because its original process exited. Ordinary waiters
retain their existing arrival-based deadline and dead-process cleanup. Expired
reservations lose their old arrival order on renewal. Acquisition removes the
matching waiter; abandoned or newly ineligible heads therefore block closer
acquisitions for at most 120 seconds after their last attempt. No holder is
preempted, including a live same-host holder past its nominal deadline.

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
ceiling remains fixed even under continuous daemon priority service. Ordinary
`--wait` and the compatibility `--wait-for-holder-deadline` retain their prior
wall-clock semantics without the new flag. Dead-holder reclamation is unchanged.

Timeouts name `lease-queue-no-progress` or `lease-wait-ceiling` and report the
[holders observed](merge-lease-history.md). Green exact-head closers refresh the
live head/check snapshot and record a deferred audit before each of up to two
in-run acquisition retries. They re-enter admission on every retry. Final green
exhaustion records `leaseWaitExhausted: true`, which requests the next closer
pass without charging failure counters. This does not waive any live merge gate.
