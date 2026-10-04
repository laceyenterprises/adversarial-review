# Data Model - AMA Closure Lag

**Owner:** AMA closure diagnostics and SLO paging
**Store:** `data/ama-closure-lag/state.json` under the runtime root
**Source of truth:** `src/ama/closure-lag.mjs`

This diagnostic ledger tracks eligible waits, rolling completion samples and
deduplicated SEV1 pages. It grants no merge authority and never releases leases.

| Field | Shape | Contract |
|---|---|---|
| `prs` | object keyed by `repo#PR` | Each entry may contain `closerSeenAt`, `eligibleAt`, `headSha`, `reason`, `terminal`, and `terminalAt`. Timestamps are epoch milliseconds. |
| `samples` | array | Completion observations `{ at, lagMs, pr, reason }` used in rolling p95 lag. |
| `breaches` | object keyed by `p95` or `pr:repo#PR` | Each value contains an immutable breach `event` and a `paged` boolean. Successful delivery sets `paged`; failures leave it false for retry. |
| `sloMs` | optional number | Last supplied p95 SLO, defaulting to 1800000 milliseconds when absent. |

`observeCloserBacklog` returns a Promise of the count of nonterminal PRs seen
within ten minutes. `observeClosureLag` returns a Promise of the observation's
events and pending breach pages; it logs events and delivers pages after saving
the state. The watcher records eligibility and backlog, and lifecycle sync or
inline merge completion marks terminal PRs. Completion lag is sampled only once.

Every state write removes PR-specific breaches whose PR is absent or terminal,
whether paged or undelivered. This also cleans orphaned breaches left by older
writers. Active PR breaches retain their original event and delivery flag. Lag
observations prune terminal PRs older than 24 hours and retain at most 10000
completion samples from the last 24 hours. A delivered p95 breach is cleared
when p95 recovers, allowing a new episode; an undelivered p95 breach remains
retryable. PR-specific breaches begin after an eligible wait exceeds one hour.

Writers serialize through the stable `state.lock` file. Lock probes and filesystem
operations are asynchronous; exclusive nonblocking probes retry every 25ms for
at most one second. This avoids blocking either the event loop or the IO thread
pool behind another writer. Contention expiry or IO/parse failures reject the
observation and release the descriptor; callers log the diagnostic failure and
dispatch falls back to its live-launch census. State is replaced atomically via
a unique temporary file, file fsync and rename, with best-effort directory fsync.
Page delivery and its acknowledgement use separate lock acquisitions.
