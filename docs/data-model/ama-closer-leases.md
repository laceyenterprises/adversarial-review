# Data Model - AMA Closer Leases

**Owner:** AMA closer ownership and terminal settlement
**Store:** `data/ama-closer-leases/`
**Source of truth:** `src/ama/closer-lease.mjs`
**Runtime surface:** `src/ama/dispatch-closer.mjs`, `src/ama/closer-terminal-cancel.mjs`

## Purpose

One file per `(repo, prNumber, headSha)` protects a closer launch against
duplicate watcher ticks. `status` moves from `pending` to `dispatched` to
`terminal`; a pending lease may become terminal when no launch occurred.
`acquiredAt`, `updatedAt`, `watcherPid`, `host`, and `dispatchTimeoutMs`
identify the launch window. A dispatched lease carries `lrqId`. Rekeys retain
`rekeyedFromHeadSha` and `supersededHeads` so the current lease can identify
the original dispatch record after the PR head changes.

The terminal `terminalOutcome` is one of `succeeded`,
`failed-without-merge`, `deferred`, `superseded`, `pr-merged-externally`,
`pr-closed-externally`, `no-merge:concurrent-writer`, or
`no-merge:pr-merged-externally`. Terminal leases are never demoted. The
pending reclaim age includes the configured dispatch timeout and retry and
token-poll windows; dispatched leases use their separate stale boundary.
