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

Settlement performs no resolver probe: it records failures and applies
ordinary bounded escalation at the five-failure threshold. After durable
backoff, poll-time probes run only below the infrastructure cap. Each
repository discovery pass shares one watcher-context result per CLI. A healthy
probe re-queues the exact observed open row and clears all claim columns; it
preserves the failure streak and budgets. A failed probe schedules a
load-aware hold and ends processing for that row in the same tick. Both
observations preserve failure breakdowns and reasons. At the infrastructure
cap, probes are bypassed so existing cap alerts and scheduled recovery remain
authoritative. Resolution backoff scales with host load; a changed failure
class or a gap over one hour beyond the scheduled nextRetryAfter starts a
fresh streak. Watcher probes are advisory: they do not reproduce
credential-staged spawn environments or Gemini antigravity selection. Only a
successful review clears failure history.

Identity isolation, credentials and merge rules are unchanged.

## Verification and recovery

Synthetic offline tests cover exit-one versus timeout diagnostics, timeout retry
under simulated load, scaled backoff, persistent failure escalation, healthy
poll-time probes below the cap, preserved failure streaks, shared failed probes,
claim cleanup, closed-PR refusal and stale probes racing a replacement claim.
See the ticket change note for executed checks. Source tests establish behavior,
not deployed recovery. This change performs no live database edits, re-triggers,
watcher changes, or incident notifications. Normal deployment activates the fix.
