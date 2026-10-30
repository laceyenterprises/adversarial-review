# Data Model - AMA Closer Leases

**Owner:** AMA closer ownership and terminal settlement
**Store:** `data/ama-closer-leases/`
**Source of truth:** `src/ama/closer-lease.mjs`
**Runtime surface:** `src/ama/dispatch-closer.mjs`, `src/ama/closer-terminal-cancel.mjs`, `src/ama/gsr-closer-lease.mjs`, `bin/gsr-closer-lease.mjs`

## Unreceipted intents (LAC-2081)

A `dispatching` intent now prevents the stale-lease reaper from releasing its
lease or refunding a presumed phantom attempt. The keyed native reconciler may
promote a matching dead-owner pending lease after receipt proof, or terminalize
it as `deferred` after proof that submission never began, or after complete
dead-submitter and empty-key proof (CLOSERPENDINGDEAD-01). The lease shape
is unchanged; process identities and diagnostic evidence live on the intent. Lease updates serialize on the existing reclaim flock; native repair
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
`acquiredAt`, `updatedAt`, `watcherPid`, `holderHost`, and `dispatchTimeoutMs`
identify the launch window. LOADAR-01 records the load-aware effective
subprocess budget in `dispatchTimeoutMs`. CLOSERLEASEDEAD-01 expires a pending,
launch-less lease strictly after `acquiredAt + dispatchTimeoutMs`, without
scaling or adding retry overhead. Dispatch-record expiry retains its existing
retry and token-poll window. Nominal
pending fallback and dispatched/unknown reclaim ages use the shared load-aware
helper. Confirmed live launches still retain ownership at any age; no store
fields or lifecycle states change. A dispatched lease carries `lrqId`.
CLOSERCUSTODYLRQ-01 also records `workerId` and `dispatchedAt` when the
dispatcher returns a receipt; `headSha` already binds the lease to its head.
Repeated promotion of the same launch retains its dispatch time, and
terminalization/rekeying retain all receipt fields. Older leases may omit the
new optional fields. Worktree custody uses a matching durable dispatch receipt
or lease before worker observations, including after watcher restart. When
admission retains that custody (live, parked or unreadable launch), it puts the
receipt-bearing predecessor lease back by CAS instead of leaving a receipt-less
`deferred` replacement.
Rekeys retain
`rekeyedFromHeadSha` and `supersededHeads` so the current lease can identify
the original dispatch record after the PR head changes.

The terminal `terminalOutcome` is one of `succeeded`,
`failed-without-merge`, `deferred`, `superseded`, `pr-merged-externally`,
`pr-closed-externally`, `no-merge:concurrent-writer`, or
`no-merge:pr-merged-externally`, `abandoned-holder-dead`, or `abandoned-timeout`. Terminal leases are never demoted in place. TERMLEASE-01 removes a terminal
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
legacy pending reclaim age and dispatch-record window retain retry and
token-poll overhead; dispatched leases use their separate stale boundary. A
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


Launch status meanings come from the SDK-pinned public producer vocabulary
(`hq api spec --surface producer-contracts --format json`, contractVersion 1.x).
Boolean wire `terminal` and `succeeded` values take precedence when present;
status-only ledger rows use the producer definitions. `blocked_needs_decision`
and vocabulary-defined `blocked_`/`waiting_` states are parked: they consume no
closer capacity and settle an active lease as terminal `deferred`, but their
unchanged dispatch identity still owns the PR. They cannot be reclaimed,
redispatched by ordinary or orphan recovery, or lose their scratch directory
while parked. Parked observations are re-read rather than cached as final.
Positive resumed execution occupies fleet capacity again, including through a
matching rekeyed deferred lease. A resolved decision retains the same PR owner and fences
both closer redispatch and inline daemon merge, even though the lease remains
terminal `deferred`. The fence follows matching rekeyed leases and persists
until confirmed terminal launch/retry evidence restores the existing
retry/settlement policy. Unknown evidence preserves the ownership observation.
GSR-03 `suspended` (a launch a graceful restart stopped for resume from its own
session) is non-terminal and not parked, named locally until the pinned SDK
vocabulary carries it: its lease stays `dispatched` and held against every
recovery tier at any holder or launch age, keeping its scratch, until the
ledger releases it to `failed` (`suspended_abandoned` / `suspended_age_expired`).
GSR-07 boot-time resume then hands the lease back (`src/ama/gsr-closer-lease.mjs`,
`bin/gsr-closer-lease.mjs readopt|release`): a natively resumed launch re-adopts
it in place (`updatedAt` refreshed); a launch re-dispatched as a successor
(source `failed/suspended_redispatched`) rebinds `lrqId`, and the closer
dispatch record's `launchRequestId`/`dispatchId` (adding `gsrRedispatchedFrom`),
to the successor, record first; a launch that ended before resume is released
as terminal `superseded` only when `launchRequestOwned` proves it no longer
owns the PR, including its retry descendants. Parked, live and unknown launches
retain the dispatched lease. Successor rebinding searches the current head,
`rekeyedFromHeadSha` and all `supersededHeads` for the source launch's dispatch
record, preserving records owned by other launches.
Each write is a CAS on the observed lease; a concurrent owner wins (`busy`).
The aggregate result reports `busy` when no lease changed and any mutation
collided; successful changes retain precedence, with per-lease outcomes included.
The release CLI prepares the dispatch-read context asynchronously before the
synchronous ledger probe, using the existing app bootstrap/session contract.
Bootstrap failure exits nonzero with a fixed diagnostic and leaves leases intact;
`readopt` needs no ledger session. The exported CLI `main` returns a promise.
The installed SDK 0.3.0 `readDispatchStatus` reader interprets its bundled
public `statusVocabulary`. Each explicit boolean wins independently, including
false; absent or invalid booleans use the vocabulary and malformed values carry
diagnostics. Launch aliases `completed`, `complete`, `done`, `cancelled`, `reaped`
and `rejected` remain unknown rather than authorizing success or retries.
Worker-run and app-owned lifecycle spellings are separate contracts. Unknown
status-only evidence remains unknown. No new durable states or fields are added.


## Abandoned pending holders (CLOSERLEASEDEAD-01)

Startup/periodic sweeps and closure routing share the abandonment rule for
`pending` leases without `lrqId`. A matching `holderHost` or a legacy lease
without `holderHost` permits a local PID probe: a confirmed absent PID or a process started after `acquiredAt` records
`abandoned-holder-dead`. Unreadable identity evidence retains the lease until
its own persisted dispatch timeout; even foreign-host leases record
`abandoned-timeout` strictly after that deadline. Observation never refreshes
`acquiredAt`. Current-process leases and review handoffs retain ownership.
Leases carrying launch IDs keep launch-based ownership.

Abandonment takes the existing dispatch-intent lock, preserves unresolved
`dispatching` intents for keyed reconciliation, and compares the observed lease
under the reclaim flock before writing `terminal`. A concurrent launch receipt
or replacement holder defeats that write. The terminal outcome remains on disk
until ordinary dispatch reclaims it through the existing exclusive acquisition
CAS; startup logs the released count. Closure recomputes its next action from
that terminal lease, including when an uncertain ownership read crosses the
deadline. Operator holds still suppress closure routing and lease mutation.
No merge eligibility, finding-remediation or current-head proof is granted by
abandonment. CLAIMPIDSTALE-01 applies the same local PID rule to hostless leases
in startup recovery and each closure evaluation, retaining the terminal owner
receipt and abandonment log. Offline regressions cover dead/reused PIDs,
uncertain and foreign ownership, deadline boundaries, a raced launch, retained live owners and
same-pass hammer admission.

## Retryable merge release (HAMLANEWAIT-02)

`status: terminal` is the store's released state. `terminalOutcome` additionally
accepts `retryable-lane-busy`, `retryable-merge-lease-timeout`,
`retryable-required-checks-pending` and `retryable-pr-mergeability-unknown`.
These are reclaimable outcomes under the existing launch-liveness checks.
The terminal audit CLI settles the matching launch's current or original-head
lease under the complete expected snapshot/reclaim flock. Intermediate audit
attempts with `inRunRetry: true` do not release ownership; completed review
handoffs and successor launches are preserved.

Before closure/rescue routing and during bounded recovery sweeps,
`reconcileAmaCloserLeaseAsync` turns a dispatched lease whose launch ended and
whose latest matching audit is retryable into this terminal receipt. Live or
unreadable retry chains retain ownership. The ordinary closure path then owns
same-head daemon eligibility or hammer resume, with existing deferral backoff,
retry/lifetime limits and the exclusive acquisition CAS. No persistent fields
or status values are added. The orphan watchdog uses the lease LRQ as liveness
evidence even when its dispatch projection is missing.

## Recovered capacity decision (CIBLOCKRESUME-01)

A legacy decision-blocked closer's lease can be CAS-deleted under the PR intent
lock after its exact-head infrastructure stop releases and a fresh launch read
proves `blocked_needs_decision` with no live or unreadable retry descendants.
The corresponding dispatch receipt retains `recoveredLaunchRequestId` and
`reason: ci-infrastructure-recovered`; it clears live launch references. This
exception does not apply to running or otherwise parked owners. It does not
change the merge lease or authorize merge. See the
[dispatch receipt contract](ama-closer-dispatches.md#recovered-capacity-decision-ciblockresume-01).
