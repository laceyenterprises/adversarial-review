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
the bound. Explicit operator-hold decisions, draft and terminal PRs do not enter
recovery. A selected closure-recovery row under an automated hold still reports
its expiry; any observed hold label always fences launch admission.

A head-bound shared reviewer dispatch can execute before the idle bound after
proving ownership absent. The existing `heads.rereview` reservation permits one
successful immediate request per head; a local refusal refunds the reservation.
The request retains `system-orphan-head-review:<head>`, exact-head deduplication
and the review-state CAS. Live or uncertain ownership never permits a request.
The selected actor remains visible even while physical admission waits.

After the idle bound, only the same head's selected reviewer or hammer dispatch
can reserve an action, and drain/capacity deferral remains effective. The watchdog
no longer derives eligibility from review verdicts, reason sets, closer identity,
final-round ledgers or historical stops. Those facts enter the shared snapshot.
Automatic stops, exhausted retries and unknown descendants retain recovery
ownership. There is no separate rescue policy. Pending/failed and posted caller
paths retain their terminal PR guards; a daemon's confirmed merge settles before
recovery even if the earlier candidate was OPEN.

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
readable but no longer control recovery. The independent closer-head recovery seam remains retired. Ordinary ownerless
recovery uses the shared two-attempt budget; execution of an explicit
`rereview-exact-head` decision uses the existing per-head `rereview` reservation.

Every recovery emits one `ownerless-recovery` log line containing repo, PR,
head, elapsed idle minutes, last reason and action. Store failures retain the existing
store-error page behavior. All tests use fixture state and injected dispatch,
ledger and pager functions.

## Deadline-bound ownership (OWNERDEADLINE-01)

For a matching-head closure-recovery action, RECOVERYDEADLINE-01 handles expiry
on the first due wake, bypassing the additional `ownerlessBoundMs` grace and idle
threshold. Recoverable receipts/expired leases select hammer through the shared
policy and existing lease; unreadable/input-dependent evidence, deferrals and
refused dispatches page once through `transition_pages`. The page includes
evidence references as well as row, reason and deadline. Ordinary actions retain
their existing grace. No schema or attempt-budget changes.

For any other matching-head shared next action overdue by `ownerlessBoundMs`, recovery
uses the earlier of `ownership.idleSince` and `nextAction.deadline.at`. A fresh
request timestamp cannot extend this deadline. Current-head live processes,
live launches/retries and fresh lease evidence still hold dispatch. A
current-head dispatched lease's explicit `heartbeatAt` proves liveness only
inside that same bound; absent, stale or future heartbeats do not. No lease
writer or lease mutation changes. Older-head receipts do not own an overdue
current-head action. Uncertain ownership pages diagnostics without dispatch.
Dispatch records match the inspected head when any of `targetRemediationSha`,
`headSha` or `reviewedSha` matches; live worker/launch evidence is still required.
Different values in the other SHA fields do not override a matching field.
Overdue reviewer dispatch also uses `heads.rereview` for once-per-head request
reservation and returns the `reviewRequest` receipt for closure handoff, while
retaining the deadline recovery attempt cap. No column or table shape changes.

The additive `transition_pages(head TEXT, transition TEXT, PRIMARY KEY
(head, transition))` table records successful or terminal page receipts. The
transition is the JSON tuple `[row, action, actor, reason]`, scoped by head;
rolling timestamps and route reason strings do not create another page.
Missing executors, deferrals, reconcile/observe rows, expired waits and spent
attempts page the selected row, reason and deadline as structured `nextAction`
evidence and in message text. Failed enqueues retry on the next observation;
`delivered` and `dead-letter` receipts end enqueue retries. The outbox uses the same head/transition identity even after a crash before
the SQLite receipt; see [alert delivery](alert-delivery-state.md). The legacy
`heads.paged` exhaustion receipt remains readable. Attempt caps stay per head.

Discovery reads current-head lane evidence before admission or full-walk
backoff. Legacy lanes without a stored action derive the shared refresh
row from `firstNoProgressAt` (or `lastRunAt`); observation time cannot move a
durable anchor. Deadline observation itself performs no GitHub requests.
