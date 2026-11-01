# Data Model - Hammer Retry Cap Ledger

## Non-closer head series reset (CLOSERPROOF-01)

A series belongs to the heads the closer authored. When the PR head moves to a
commit the closer did not author, such as another worker's rebase of the
hammer's commit, the series exhaustion recorded for an earlier head does not
carry over. `resetHammerSeriesForNonCloserHead` decides this only from the
shared proof (`proveCloserAuthoredStaleHead`): `hammer-app-attestation-missing`
anchored at the ledger's `jobKey`, with `currentHeadHammerAttested: false`
(no authenticated hammer edge ends at the exact SHA, compared
case-insensitively). Commit trailers and author
fields are never read. The closure orchestration calls it before evaluating the
owner cap, under the existing PR-scoped lock.

The reset's `jobKey` is the proof's reviewed head (`originalReviewedHead`, the
review row's `reviewer_head_sha`), because the proof compared that head and
dispatch recorded the hammer series under it. The owner cap is evaluated under
`reviewState.headSha`, the gate's evidence head. When the two differ, the cap
already starts a fresh series for the evidence head, so the reset has nothing to
clear there.

A reset sets `attemptCount: 0` and `dispatchHeads: []`, clears the series
suppression fields (`suppressed`, `suppressedJobKey`, `suppressedHeadSha`,
`suppressedAttemptCount`, `alertedAt`) and drops the series `retryable`
refunds. `suppressionState` is cleared unless a target suppression is still in
force. Lifetime counts, lifetime suppression, target fields and charge receipts
are unchanged.
The optional `nonCloserHeadResets` map, keyed by head SHA, records
`{ resetAt, jobKey, reason, priorAttemptCount, priorSuppressed,
priorSuppressedHeadSha }`. It survives every later write, so each head resets at
most once. Nothing resets for a proven or unknown proof, a proof anchored at
another head, a head the hammer was dispatched for, a lifetime-suppressed or
corrupt ledger, or a series with nothing spent. A hammer push on top of the new
head is attested, so it never resets.

## Missing phase input replacement (HAMSCRATCHRESUME-01)

The optional PR-scoped `phaseInputsReplacement` receipt stores
`{ launchRequestId, refundedAt, budgets: { pr, head } }`. It survives target
and review-series changes. A complete terminal launch chain with the named
quota-resume failure or a matching launch-bound missing-phase audit authorizes
one fresh closer. The exact `dispatchCharges` entry must exist. Matching PR and
head/epoch counters are credited once and `refundedBudgets` prevents overlapping
credits. The lifetime ceiling remains charged. Missing/corrupt accounting,
unknown/live descendants and a second broken replacement refuse recovery.
Monotonic dispatch-record `retryCount` is retained; `unexecutedRefundCount`
accounts for the one dispatch repair. This is an input repair, not a no-work
execution verdict.
For a single-attempt adapter response, an omitted or null retry chain is treated
as empty unless explicitly marked unreadable. The launch identity and terminal
audit/refusal evidence are still required; live or unreadable retries refuse
replacement.

## Operator approval re-arm (APPROVALREARM-01)

A terminal closer refusal records `awaitedInputs: [{ kind: "operator-label",
label }]`. The audit writer extracts explicit `operator-label-required:<label>`
reasons and the legacy activation-gate requirement for `operator-approved`;
other producers may supply the typed input directly. Bare label mentions do
not establish a requirement. All named inputs must appear on the same live,
open head before the closer can re-arm.

The existing PR ledger adds optional `operatorApprovalRearms`, keyed by exact
head SHA. Each receipt records `state: pending | consumed`,
`reason: operator-approval-applied`, the reviewed `jobKey`, refusal `stopKey`,
`awaitedInputs` and `grantedAt`. A confirmed launch adds `consumedAt`,
`launchRequestId` and `dispatchKey`. Creation uses the existing PR-scoped lock.
Missing legacy maps mean no grants; corrupt ledgers/counters cannot grant.
Receipts survive suppression writes, target changes and fresh review series,
so label toggles and returning to an old head cannot replenish the allowance.

For an exhausted ledger on the last dispatched head and same review series,
a pending receipt admits one extra dispatch through the series, target,
lifetime and dispatch-record retry caps. Counters are never decremented: the
confirmed launch increments them normally and atomically consumes the receipt.
Ledger lock ordering, rather than producer timestamps, determines consumption;
already recorded charge identities return before consumption. A failed
pre-launch admission leaves the allowance pending. A second refusal is capped
again. An unused receipt applies only to its exact head and review series;
it cannot enable another head or enable a disabled hammer (ceiling zero).
Ordinary terminal-state, operator hold, identity, lease, capacity, CI and merge
predicates remain authoritative. Label presence grants retry admission only;
a worker/bot-applied label may spend it, while the merge gate still checks
operator authority. A consumed receipt also identifies a fresh cap-alert episode. No config or label is added.

## Companion wait credits (COMPANIONFLOAT-01)

`src/ama/companion-stop-wait.mjs` credits only exactly matched dispatch charges
whose terminal audit names solely a companion dependency wait. Matching requires
the launch ID, audit job key and target head. A genuine blocker for the same
launch prevents credit. Unmatched legacy or unreadable accounting stays charged.
Each `dispatchCharges[key]` may add `companionWaitRefund: { stopKey, refundedAt }`.
Existing `refundedBudgets` tracks PR, current head/epoch and lifetime credits;
series changes cannot credit unrelated counters. Refunded launches join
`unexecutedLaunchRequestIds` to prevent sibling consumers crediting them again.
Repeated polls leave counters unchanged. The dispatch-record retry bound
subtracts companion credits for its head without resetting monotonic
`retryCount`. Ordinary caps still block genuine failures after float, and
ordinary lease admission retains single-flight dispatch.


## Actions infrastructure refunds (CIBLOCKINFRA-01)

After successful current-head replacement checks, only an audited all-
infrastructure CI launch with a matching `dispatchCharges` entry is refunded.
The existing `refundedBudgets` credits prevent double refunds across readers
and restarts. PR and target counts require matching charge scope; target
credit also requires the same target epoch. Lifetime credit remains attached
to the exact launch. Unverifiable legacy charges are not credited.

`dispatchCharges[key].ciInfrastructureRefund` records
`{ reason: 'checks-executed-again', stopKey, refundedAt }`. These charge
receipts survive series resets. Suppression is recomputed from the remaining
charges; real failures retain their budget cost.

**Owner:** AMA hammer dispatch retry and redrive caps
**Store:** `data/follow-up-jobs/hammer-retry-cap/`
**Source of truth:** `src/ama/hammer-retry-cap.mjs`
**Runtime surface:** `src/ama/operator-hold-refund.mjs`, `src/ama/dispatch-closer.mjs`, `src/ama/dead-hammer-rearm.mjs`, `src/ama-closure-orchestration.mjs`

## Purpose

SAFETYSTOPOWNER-01 uses this same ledger for scoped safety-stop PR updates.
`reserveHammerRepairDispatch` evaluates all existing caps and writes a normal
dispatch charge under the existing PR lock before submission. Its deterministic
key binds the recovery head and refusal key. An already charged key refuses
another reservation; interrupted or uncertain submissions retain the charge.
No cap is reset, suppression bypassed, lease changed or refund introduced.

`data/follow-up-jobs/hammer-retry-cap/` records per-PR hammer dispatch counts
for the AMA closer. The ledger bounds three related retry loops:

- per-series hammer dispatches for the same reviewed head;
- lifetime hammer dispatches for the PR across fresh-review resets;
- target-redrive hammer dispatches against the same live remediation target SHA
  across different reviewed-head job keys.

The file is keyed only by `(repo, PR)`, not by head SHA, so hammer-created head
churn cannot reset quota protection. Fresh adversarial reviews may reset the
per-series counter, but they do not reset the lifetime counter. Target-redrive
state resets only when the live remediation target SHA changes.

LAC-2081 adds optional `chargedDispatchKeys` (unique attempt keys). Receipt
recovery and ordinary receipt persistence charge a key once, before writing the
local receipt. Keys survive review/head resets and are not truncated while the
PR ledger is retained. Reconciliation retains existing suppression/page markers
and refuses to overwrite a corrupt retry ledger. Proven no-submission settlement
rolls back only the intent's pre-increment; it does not refund a launch charge.

## Files

Directory: `data/follow-up-jobs/hammer-retry-cap/`

| File | Shape | Contract |
|---|---|---|
| `<repo-slug>-pr-<number>.json` | Hammer retry cap ledger | One current ledger per `(repo, PR)`. The repo slug replaces `/` with `__` and then strips unsafe filename characters. |

## Hammer Retry Cap Ledger

| Field | Shape | Contract |
|---|---|---|
| `schemaVersion` | number | Current value is `3`. Version `3` adds permanent charge/refund identities and target epochs. Version `2` introduced the target-redrive fields: `targetRemediationSha`, `targetAttemptCount`, `targetSuppressed`, and `targetAlertedAt`. |
| `repo` | string | Repository full name, such as `owner/repo`. |
| `prNumber` | positive integer | Pull request number. |
| `jobKey` | string or null | Stable reviewed-head key for the current per-series counter. A changed known job key resets `attemptCount`, `dispatchHeads`, ordinary retry refunds, and the three per-series deferral fields below. Lifetime refund usage survives. |
| `attemptCount` | non-negative integer | Confirmed hammer dispatches in the current reviewed-head series, less ordinary retry, contention, durable non-execution and independently observed operator-label deferral refunds. Dispatches increment only after launch succeeds. |
| `lifetimeAttemptCount` | non-negative integer | Confirmed hammer dispatches for the PR across all reviewed-head series, less ordinary contention refunds (at most twelve for the entire PR), green lease-wait / legacy lane-busy refunds and proven hold-only non-execution refunds. Missing legacy values are seeded from `attemptCount`; non-finite present values fail closed to the lifetime ceiling. |
| `targetRemediationSha` | string or null | Live PR head SHA targeted by HAM remediation. This may differ from `jobKey` when the review is stale and the exhausted-lane hammer runs against a newer head. |
| `targetAttemptCount` | non-negative integer | Confirmed hammer dispatches against `targetRemediationSha` across job keys. A changed known target SHA resets the count; missing legacy values are backfilled from `attemptCount` on suppression writes and from the evaluated target count on dispatch writes. |
| `retryable` | non-negative integer, optional | Dispatches refunded because the hammer exited `succeeded` without closing its PR (HAMBG-02), or its launch failed for an infrastructure reason and it pushed nothing (CLOSERREUSE-01). `attemptCount` and the matching `targetAttemptCount` go down by one, and `retryable` goes up by one. At most `HAMMER_EXITED_WITHOUT_CLOSE_RETRY_BUDGET` (1) per series. Belongs to the series: a fresh-review job-key change resets it, on a dispatch write and on a suppression write alike. Absent until the first refund. Not the same counter as the base-branch merge gate's `retryable` (HAMGATE-01, `data/merge-leases/`): the two live in different stores and have separate budgets. |
| `retryableLaunchRequestIds` | string array, optional | Launch request ids already refunded, so a launch observed on several ticks is refunded once. Retained for the series; reset with `retryable`. RCV-08 full refunds use permanent `noWorkRefunds` instead. |
| `unexecutedLaunchRequestIds` | array of strings, optional | HAMREFUND-01, LABELGATE-01 and HOLDRELEASE-01 refunded launch identities, permanent for the retained PR ledger. Preserved across dispatches, suppression writes and fresh-review resets; absent legacy values mean no recorded non-execution refunds. |
| `operatorHoldRefundStopKeys` | string array, optional | Audit stop keys already refunded by HOLDRELEASE-01. Preserved across dispatches, suppression writes and fresh-review resets; not truncated, so older stops cannot be refunded again after launch history rolls off. Missing legacy values mean no recorded hold refunds. |
| `operatorHoldRefundedAt` | ISO-8601 string, optional | Latest successful hold-only refund timestamp. Preserved with the stop-key history across dispatches, suppression and fresh-review resets. |
| `transientRetryHeads` | object of head SHA to positive integer grant count, optional | Spent closer-authored stale-head retry grants. Default limit is one grant per head. Retained for the PR's lifetime across target churn, dispatch/suppression writes and fresh-review job-key resets; unlike refunded launch history, this map is never truncated to ten heads. Absent legacy values mean no grants recorded. |
| `lastTransientRetryAt` | ISO-8601 string or null, optional | Timestamp supplied for the latest transient retry grant, or null if none was supplied. Preserved with grant history on later dispatch/suppression writes and fresh-review resets. |
| `deferralLaunches` | string array | Launch IDs observed parked on merge-lease contention or pending required checks in this review series. Dedupes refunds across ticks and against `retryableLaunchRequestIds`. Resets on a changed known job key because the certified reviewed-head queue changed. At twelve deferrals the queue expires. |
| `leaseWaitExhausted` | boolean, optional | Whether the latest deferral is proven green exact-head merge-lease wait exhaustion or HAMLANEWAIT-01 legacy lane-busy contention. When true, ordinary contention queue expiry does not apply. Green lease waits skip backoff; legacy lane-busy waits use `deferralNextAt`. Preserved in the same reviewed-head series; reset on a changed known job key. |
| `leaseWaitLaunches` | string array, optional | Lease-wait or legacy lane-busy launch IDs already observed and refunded, retaining the newest 64 for deduplication across ticks and other refund paths. Preserved in the same reviewed-head series; reset on a changed known job key. |
| `laneBusyDeferral` | object or null, optional | Latest lane-busy parked `headSha` and `launches` (newest 64 distinct launch IDs). Resets on a changed parked head or reviewed job key, and clears on a non-lane deferral. Same-head observations dedupe through the shared refund history. Selects two-minute exponential backoff capped at thirty minutes, without consuming failure credit. The third distinct launch pages through the existing closure-wait receipt, deduped per PR/head and `lane-busy` class across restarts. |
| `deferralStartedAt` | ISO-8601 string or null | First observed deferral in this series; anchors the six-hour queue deadline. Resets with the job key. |
| `deferralNextAt` | ISO-8601 string or null | Earliest resume time after the latest newly observed deferral; two-minute exponential backoff capped at thirty minutes. Resets with the job key. |
| `lifetimeDeferralRefundCount` | integer in 0..12 | Contention lifetime refunds consumed across all series. Never reset by a fresh review or suppression write. New ledgers start at zero. Missing or malformed legacy values are treated as twelve (refunds exhausted); only operator reconciliation can restore unproven refund capacity. |
| `dispatchCharges` | map of native attempt key to charge | Permanent launch, attempt (1), reviewed series, target SHA/epoch, ISO-8601 `chargedAt` (defaults to the current time when `now` is omitted/null), consumer version, effective wait snapshot, optional consumed transient grant identity and per-budget partial-credit flags. Written atomically with counters. Duplicate native keys/LRQs do not charge again. |
| `noWorkRefunds` | map of charge key to receipt | Permanent verdict ID, launch/attempt, series/head, refund time and actual refunded budget flags. Stored with counter decrements; never a recent-history ring. |
| `targetChargeEpoch` | string | New identity when the target changes, including changes stamped by suppression. Returning to an old SHA cannot make its old verdict debit the new epoch. |
| `pendingTransientCharge` | object or null | Grant UUID, head and series awaiting its next confirmed dispatch. Only that dispatch consumes/binds the grant. |
| `dispatchHeads` | string array | Unique dispatched head SHAs observed in the current reviewed-head series. Resets on a fresh-review job-key change. |
| `lastDispatchedHeadSha` | string or null | Most recent head SHA used for a confirmed hammer dispatch. |
| `suppressed` | boolean | `true` once any cap has blocked hammer dispatch for the ledger's current state. |
| `lifetimeSuppressed` | boolean | `true` once the lifetime cap has blocked dispatch. This flag is not cleared by job-key changes. |
| `targetSuppressed` | boolean | `true` once the target-redrive cap has blocked dispatch for `targetRemediationSha`. A changed known target SHA clears stale target suppression. |
| `suppressionState` | string or null | Operator-visible suppression state. Values are `hammer-retry-cap-exhausted-needs-operator`, `hammer-lifetime-ceiling-reached-needs-operator`, or `hammer-target-redrive-cap-exhausted-needs-operator`. |
| `suppressedJobKey` | string or null | Job key associated with the suppression stamp. |
| `suppressedHeadSha` | string or null | Head SHA associated with the suppression stamp. |
| `suppressedAttemptCount` | non-negative integer or null | Per-series attempt count observed when suppression was stamped. |
| `alertedAt` | string or null | ISO-8601 timestamp for the first successful operator alert in the continuous per-series or lifetime suppression episode. Repeated successful alerts preserve it. Lifetime suppression preserves it across job-key changes; a new series or newly exhausted lifetime cap records a new time. |
| `targetAlertedAt` | string or null | ISO-8601 timestamp for the first successful operator alert in a continuous target-redrive suppression episode. Repeated alerts preserve it; a target SHA change resets it. |
| `createdAt` | string or null | ISO-8601 timestamp from the first write when available. |
| `updatedAt` | string or null | ISO-8601 timestamp from the latest write when available. |

## Operational Contract

STOPSTALE-03 projects a lifetime stop's freshness boundary from complete
confirmed `dispatchCharges` when available: unique launch IDs, supported charge
shape, valid charge times and an unrefunded count equal to
`lifetimeAttemptCount` at or above the configured positive ceiling. The latest
charge time, including refunded charges, bounds a superseding exact-head review.
Otherwise `alertedAt` remains the fallback. An active target suppression still
requires its own alert time. This read-only projection tolerates timestamps
overwritten by older re-alert writers without modifying stored evidence or
refunding any budget. R07 supersession remains daemon-only and retains all live
merge gates. The schema and retention policy are unchanged.

HOLDRELEASE-01 refunds only hold-only terminal stops on the last dispatched
head and current audit job key, with a launch identity and explicit
`noExecution: true`, `workerState: never-spawned`, or `executionStarted: false`
evidence. It rejects corrupt counters, already-refunded stop keys and launch
identities, and a dispatch newer than the stop. Each eligible stop reduces
`attemptCount`, `lifetimeAttemptCount` and the matching `targetAttemptCount`
once, never below zero. Suppression flags clear so ordinary cap classification
can re-evaluate remaining charges. No real execution is refunded. Launch IDs are shared permanently with other refund consumers; permanent stop keys
also retain hold-refund deduplication.

Current in-repo hammer audit producers do not emit this no-execution evidence.
This refund path is inert for their audits until a producer supplies both the
explicit evidence and launch identity; a hold-only reason alone never qualifies.

- Missing ledger files are treated as no prior attempts.
- Read or parse failures fail closed by returning a synthetic exhausted ledger;
  corrupt files must page the operator rather than silently resetting counts.
- Ordinary hammer accounting counts confirmed launches. Scoped safety-stop
  repairs reserve a charge before submission, including interrupted attempts.
  Interrupted ordinary pre-launch work
  does not create phantom attempts that need reclaiming.
- Ordinary exited-without-close/infrastructure refunds never touch
  `lifetimeAttemptCount`, and are refused once the series is suppressed or their
  budget is spent. Contention deferrals separately refund `attemptCount` and the
  matching `targetAttemptCount` once per charged launch, for up to twelve
  deferrals per series. They reduce `lifetimeAttemptCount` only while the
  PR-wide `lifetimeDeferralRefundCount` is below twelve, and increment that
  durable usage counter. Fresh reviews cannot replenish lifetime refunds, so
  excluding proven hold-only non-execution refunds, the total launch ceiling is
  bounded by the normal lifetime ceiling plus twelve, excluding proven green lease-wait exhaustion and legacy lane-busy contention.
  Both refund paths refuse a launch already refunded by the other path.
- RCV-08 consumes the RCV-07 `ExecutionVerdict.export` contract through the canonical
  SQLite/Postgres read adapter. Only schema 1 / `cwp-execution/1` `no_work` with
  an exact launch/attempt identity and credential-free ledger evidence references
  authorizes a full refund. Failure classes, signal names, absent logs and 429
  text cannot authorize it. Unknown, productive progress and post-progress quota
  failures remain charged. Existing live OPEN head, no terminal audit, missing
  merge-signal and readable provenance checks remain in the closer path.
- Full refunds return the recorded lifetime charge and the current matching
  series/target epoch charges, plus a transient grant only when that launch
  consumed it. A delayed old-head refund never decrements the replacement
  head/series. Counters and the permanent per-charge receipt commit in one
  verified atomic write under a stable-inode PR-scoped flock. Every sibling
  writer, including hold-stop refunds, participates; busy writers retry through
  existing observation/error paths. A crash after rename replays the receipt.
  A later verdict returns only allowances not already credited by a legacy refund. Legacy charges without a recorded launch binding are not guessed or backfilled.
  Existing bounded exit-only and lease/label/hold deferrals retain their own
  semantics and cannot double-credit a full no-work refund.
- Per-series suppression clears when a known fresh reviewed-head job key
  arrives. STALECLOSER-03 also permits `grantTransientHammerRetry` to reopen an
  exhausted series/target cap once per closer-authored stale head: dispatch must
  first receive an eligible shared predicate for the exact live target head.
  That predicate requires a proven closer-only chain, a settled clean carried
  verdict, green exact-head CI and `MERGEABLE` mergeability. Pending CI or unknown
  mergeability retry without granting; resolved conflicts are hard misses.
  All ordinary dispatch and merge authority gates still apply.
- A grant requires a readable existing ledger, a head SHA, the same known review
  series, an exhausted series/target cap, unused per-head grant capacity and room
  below the configured lifetime ceiling. It atomically persists the spent grant
  and timestamp, lowers `attemptCount` (and a matching `targetAttemptCount`) to at
  most one, and clears `suppressed`, `targetSuppressed`, `suppressionState` and the
  three suppression stamps. It preserves alert timestamps, lifetime counts and
  lifetime suppression; it never grants once the lifetime ceiling is exhausted.
  The grant is spent if the subsequent launch does real or unknown work; a producer-certified no-work launch returns its recorded grant once. Confirmed launches
  consume the reopened slot and increment the lifetime counter normally.
- Target-redrive suppression is scoped to the live target SHA. When the target
  SHA changes, target suppression and `targetAlertedAt` reset so a genuinely new
  target is not blocked by stale target state.
- Operator alerts are debounced by `alertedAt` and `targetAlertedAt`. A failed
  alert write leaves the relevant timestamp null so a later suppression tick can
  retry delivery.
- Ledger writes are atomic JSON rewrites. Operators may repair or clear a file,
  but malformed numeric counters fail closed rather than re-arming quota burn.
- The two refund kinds share one budget per series, and
  `retryableLaunchRequestIds` keeps either from refunding a launch twice. The
  infrastructure reasons (`src/ama/dead-hammer-rearm.mjs`) are the LRQ failure
  classes `oauth_access_token_revoked` and `adapter_boot_crash`, and
  `process_exited_after_progress` or `worker_killed` with the provider's API
  429 in the worker's own output. The first two are refunded only when the
  next dispatch resolves to a different harness class; otherwise the death
  stays charged (`infra-cause-persists`), keeping the refund for an exit that a
  re-dispatch could help. A 429 death is refunded without that check.

Deferral fields are preserved on suppression writes within a series. A changed
known job key clears only the series queue, including on suppression writes.

Queue bounds and backoff are evaluated by `evaluateHammerDeferralQueue`; missing or invalid `deferralStartedAt` fails closed as expired.

LABELGATE-01 reuses the non-execution refund operation for an executed hammer
that deferred at an operator-label gate. The closer requires a matching live
exact-head gate and a latest typed deferred audit at or after the recorded
launch. `unexecutedLaunchRequestIds` dedupes this credit against later
HAMREFUND-01 reconciliation; lifetime charges remain intact. Ordinary exited-without-close refunds also check this durable launch history,
preventing another credit even when a dispatch marker is absent. The dispatch
record retains `labelGateRefundedLaunchRequestId` to prevent duplicate per-head
admission credit.

LEASEFAIR-03: a `deferred` / `merge-lease-timeout` audit with
`leaseWaitExhausted: true` means a fresh exact-head green snapshot followed a
progress-aware lease wait. This is contention, so `deferHammerRetryDispatch`
refunds series, target and lifetime failure charges once per launch, sets
`leaseWaitExhausted: true` and `deferralNextAt` to now, and retains up to 64
`leaseWaitLaunches`. The next pass does not apply contention backoff or expiry.
These refunds do not consume the ordinary lifetime deferral refund allowance.
Legacy lane-busy uses the same refund but retains `laneBusyDeferral` and exponential
`deferralNextAt` backoff; the third distinct same-head launch pages through
`observeClosureWait`, without arming a stop or expiring refundable contention.
Green lease identities are separate from `deferralLaunches`, so they do not
consume the ordinary queue count or start its six-hour deadline. Other deferrals
retain their existing bounded budget; a later real failure is charged normally. Daemon recovery still applies its live eligibility predicates.

## Read-only activation

`node bin/recovery-status.mjs --json` reports source health, observed runtime
consumer versions and ages, configured values/resolution, charge/refund coverage,
and effective spawn wait evidence. Missing receipts remain inactive; an organic
charge observation older than 24 hours is stale. Refund counts are observations,
not fabricated organic execution. See the RCV-08 runbook for operator deployment.
