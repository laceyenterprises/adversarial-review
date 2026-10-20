# Data Model - Orphan Watchdog

**Owner:** AMA ownerless recovery (OWNERPROOF-01)
**Store:** `data/follow-up-jobs/orphan-watchdog/<sha256(repo#prNumber)>.db` and sibling `.lock`
**Source of truth:** `src/ama/orphan-watchdog.mjs`
**Runtime surfaces:** `src/ama-closure-orchestration.mjs`, `src/ownerproof-review-recovery.mjs`

Each PR has a SQLite database with a `heads` row per head SHA. A nonblocking
exclusive flock serializes observations, attempt reservation, dispatch and
paging. Existing attempt counts survive migration and process restarts.

Ownership requires a live current-head reviewer process, a remediation job
with a live worker process, a PR-scoped launch ID with a nonterminal session
ledger status, a current-head pending review request younger than the bound,
or a current-head pending closer lease with a live watcher PID before launch
expiry. Recovery excludes its own watcher PID from the pending-lease check
after acquiring its reservation; other ownership evidence is still checked.
Queued jobs, other leases, dispatch receipts and refusal reasons alone do not
prove ownership. Unreadable ledger evidence is unknown; it advances the same idle
clock as absence of an owner. A proven owner clears `idleSince`.

`OWNERLESS_BOUND_MS` defaults to 15 minutes. `OWNERPROOF_IDLE_MINUTES` accepts a
positive numeric override; invalid values retain the default. `ownership.idleSince` stores
the first PR-wide observation without a proven owner, across head changes. Poll frequency does not affect
the bound. Held, draft and terminal PRs do not enter recovery.

After the bound, current-head review evidence chooses the next action: request
review if absent and re-review remains open, otherwise request a hammer. Recovery
shares review admission's settled Comment-only predicate (captured completed
passes and follow-up jobs), and reads the terminal final-round ledger even when
the reviewed head is older. If the readonly captured-pass query fails (including
an unmigrated database), it logs a warning and falls back to filesystem review
evidence without migrating the database. Closed final-round and exhausted-cycle facts also
select the hammer; historical verdicts alone do not close review on a new head.
Historical dispatch stops and
retry counters are set aside for this bounded recovery. The hammer and merge
agent retain their live merge predicates, quota admission and operator holds.
Pending/failed review rows visit the watchdog before ordinary retry admission;
posted rows visit it through closure orchestration. Live PR reads guard both
paths against already merged or closed targets. A daemon merge completed during
closure settles the PR as terminal before recovery, even when the earlier live
read still reported OPEN.

A review request cannot reset a `reviewing` delivery row, including a claim
whose child has not yet acquired a process group. It returns `review-in-flight`
and preserves the session, head and lease for settlement or lease reconciliation.
Discovery separately requeues legacy `posted` rows missing a reviewed head when
their revision matches the live head, without changing any retry budget.

Before the external action, `attempts` increments and `outcomes` appends an
`outcome-unknown` record with action and timestamp. Settlement records the
bounded reason, optional underlying `holdReason`, launch identity, dispatched
flag and review-request result. `holdReason` uses an explicit result field when
present, otherwise the suffix of `reason: 'harness-hold:<reason>'`; both forms
populate the dedicated field in `outcomes` and the latest `evidence` summary.
Proven recovery waits refund the reservation
and remove its outcome from the spent-attempt history, retaining its summary in
`evidence`. These include coexistence/background waits, rate limits,
`stacked-base-read-failed`, and quota status read failures
(`fleet-quota-status-unavailable` or `fleet-quota-status-unreadable`) reported as
`harness-hold:<reason>` or with an explicit `holdReason`, regardless of the outer
reason (including a missing or generic reason).
Genuine quota exhaustion and unknown holds still consume attempts. Other
exceptions consume an attempt; missing receipts cannot refund it.
Attempts do not prove ownership or restart the idle timer. At two attempts, the next
ownerless observation pages with repo, PR, head and both outcomes' reasons in
the message text as well as the structured payload. `paged` is set
after successful enqueue or a deduplicated `delivered` or `dead-letter` receipt.
Transient unqueued results (`failed`, `pending`, `inflight`) retry without
another launch. A dead-letter receipt logs a distinct operator-action warning
once and ends watchdog enqueue retries; it does not prove delivery. The alert
sink remains degraded until the operator resolves the dead letter.
Legacy evidence fills missing historical outcomes with explicit
unknown summaries. `evidence` retains the latest summary for existing readers.

Migration adds a singleton `ownership` clock table, nullable `heads.idleSince`, JSON `outcomes` (default `[]`) and the
legacy reservation column if absent. Old tick and uncertainty columns remain
readable but no longer control recovery. The independent closer-head review
helper retains its historical `rereview` guard; ownerless recovery uses the
shared two-attempt budget instead.

Every recovery emits one `ownerless-recovery` log line containing repo, PR,
head, elapsed idle minutes, last reason and action. Separate diagnostics record
that historical stops were set aside. Store failures retain the existing
store-error page behavior. All tests use fixture state and injected dispatch,
ledger and pager functions.
