# SEV3 — Transient executable resolution exhausted review recovery

Ticket: REVIEWRESOLVECAP-01. This report uses synthetic descriptions only.

## Impact

Several completed pull requests remained unreviewed after executable resolution
failed repeatedly and infrastructure recovery exhausted its finite budget.
Manual re-queueing restored progress after resolution recovered. No incorrect
verdict or merge authorization is established by this incident.

## Phase 0 findings and limits

The resolver invokes `hq cli resolve --cli <cli> --consumer review --json` with
a nominal ten-second deadline scaled by the shared load-aware helper, and
retries once. Its failure evidence takes `reason` from the child error's `code`.
For the asynchronous client, numeric `1` denotes child exit status one; it does
not establish a timeout kill. Timeout errors have distinct diagnostics such as
`ETIMEDOUT`. The retained evidence cannot establish why the resolver exited
one. Host contention and later success support a transient-failure hypothesis,
not proof that the deadline killed this particular resolution.

Settlement exempted the first four consecutive resolution failures from both
budgets. At five it wrote `pending-upstream`, charging infrastructure recovery.
Subsequent failed-row recovery claims also incremented the infrastructure
counter. Both settlement and poll-time cap handling lacked a fresh executable
resolution probe. A previous healthy executable resolver could therefore remain
stranded behind historical failures and cap evidence.

## Correction

Resolution backoff now scales with host load. At the consecutive threshold or
an exhausted infrastructure budget, settlement re-probes the resolver. A healthy
result releases the matching session without charging either budget and resets
the resolution streak. Five consecutive failures, separated by gaps no greater
than one hour, still enter bounded infrastructure recovery when the fresh probe
fails. A changed failure class or longer gap starts a fresh streak.

After durable backoff, failed-row recovery also probes before cap handling or
charging another attempt. A healthy result re-queues only the observed row using
its status, failure, head and session as compare-and-swap evidence. Historical
budget counters remain intact. Failed probes preserve bounded recovery and
terminal evidence. Identity isolation, credentials, and merge rules are unchanged.

## Verification and recovery

Synthetic offline tests cover exit-one versus timeout diagnostics, timeout retry
under simulated load, scaled backoff, persistent failure escalation, healthy
re-probes at the threshold and cap, and stale probes racing a replacement claim.
See the ticket change note for executed checks. Source tests establish behavior,
not deployed recovery. This change performs no live database edits, re-triggers,
watcher changes, or incident notifications. Normal deployment activates the fix.
