# Data Model - AMA Closer Dispatch Records

**Owner:** AMA closer dispatch and recovery
**Store:** `data/follow-up-jobs/ama-closer-dispatches/`
**Source of truth:** `src/ama/dispatch-closer.mjs`
**Runtime surface:** `src/ama/primary-change.mjs`, `src/ama/dispatch-closer.mjs`, `src/ama/prelaunch-refusal-retry.mjs`, `src/ama/dispatch-dir-names.mjs`, `src/ama/closer-terminal-cancel.mjs`, `src/follow-up-stuck-claim-sweep.mjs`, `src/recovery-reaper.mjs`, `bin/reconcile-ama-closer-dispatches.mjs`

## Fleet retry ownership (SCRATCHRACE-01)

Liveness reads follow launch-ledger `metadata.retryOf` descendants transitively;
a non-terminal descendant keeps the recorded ancestor's scratch and prompt
owned. No additional durable store is introduced. Each dispatch attempt has a
unique `promptPath`, including retries of the same PR and reviewed head.

A `uq_worker_runs_live_logical_job` refusal triggers a fresh retry-chain read
for the existing record's non-null `launchRequestId`. Only a proven non-terminal
descendant restores the predecessor's IDs, scratch, prompt and retry count,
with `state: dispatched`, `reason: dispatch-retry-live`,
`lastObservedStatus: requested`, and `liveRetryLaunchRequestId` naming the live
retry. Terminal outcome fields are cleared. Restoration uses the identity that
owns the ancestor LRQ; its `headSha`, `reviewedSha` and `targetRemediationSha`
never change. If admission targeted a different head, that target is left as
`no-dispatch`, reason `dispatch-retry-live`, with `retryOwnerHeadSha` pointing
to the original record and null launch IDs, scratch and prompt. The target's
pending lease is removed rather than assigning another head's LRQ to it.
Later admissions follow `retryOwnerHeadSha` to the original owner before any
liveness or claim-refusal probe; pointer cycles terminate without inventing a launch.
A same-head restore promotes the pending lease with the ancestor LRQ.

An unproven refusal, including one without a predecessor LRQ, follows the charged
`dispatch-failed` path and existing capped, paged prelaunch recovery. It cannot
suppress merge-agent fallback by claiming fleet ownership. If the refusal-time
retry probe is itself unreadable, charge the failure but retain the predecessor
LRQ and artifacts on its original identity as `dispatch-failed`, reason
`dispatch-retry-chain-unreadable`; suppress fallback until a readable probe can
resolve ownership. No dispatched lease is fabricated. Retry-query failures retain
the successfully read base status with `retryChainUnreadable: true`; that status alone cannot authorize lease settlement, scratch cleanup or
re-dispatch. Malformed unrelated JSON metadata is skipped by both ledger backends.

Predecessor scratch deletion is deferred until the current PR's admission
decision; terminal chains and non-retry failures clean up normally. Interrupted
admission retains that PR's deferred artifacts. Terminal scratch for other PRs
is cleaned immediately by capacity reconciliation, even if admission later aborts.
Admission and cleanup use the same repository identity (`dispatchContext.repo`,
then `prMetadata.repo`, then top-level `repo`) and PR number (`dispatchContext.prNumber`,
then `prMetadata.prNumber`, then top-level `prNumber`). Unlaunched attempts remove their
own unique prompt and scratch; launched prompts remain retained evidence. The
scratch sweep applies the same launch-chain rule over terminal owner records.
Historical terminal records are probed only to discover live descendants;
missing or unreadable probes preserve their stronger evidence without poisoning
other records' capacity reconciliation.

## Purpose

After a native CI-blocked handoff settles without a launch, a skipped wake
retires its unchanged `dispatching` intent as `dispatch-failed`, with
`reason` and `lastError` set to `wake-refused:<eligibility reasons>`.
The snapshot's attempt timestamp and remediation target must still match;
launch receipts, active work and replacement intents retain ownership. Only
the matching unlaunched pending lease is removed, and the phantom dispatch retry
is rolled back once. Background handoffs reconcile
when their queue entry settles. Wake refusal grants no merge authority and
does not become a new dispatch gate.

`data/follow-up-jobs/ama-closer-dispatches/` records the AMA closer's current
dispatch state for a pull request head. The watcher, follow-up daemon, and
reapers use these files to avoid double-dispatching terminal remediation, to
reattach to a live closer, and to release stale launch records after bounded
recovery checks.

The file is keyed by `(repo, PR, headSha)`. `headSha` is the dispatch-record
identity and filename SHA, not necessarily the commit that produced the posted
review verdict. For stale-review terminal-hammer redrive, current writers store
the live remediation target in `headSha`/`targetRemediationSha`, while
`reviewedSha` preserves the posted-review commit for audit paths and freshness
guards. Human-readable routing reasons such as `exhausted-final-hammer` belong
only in `dispatchReason`, never in a field whose contract is a Git commit SHA.

## Files

Directory: `data/follow-up-jobs/ama-closer-dispatches/`

| File | Shape | Contract |
|---|---|---|
| `<repo-slug>-pr-<number>-<head-sha>.json` | AMA closer dispatch record | One current record per `(repo, PR, headSha)`. The repo slug replaces `/` with `__` and unsafe filename characters are replaced with `-`. |

## AMA Closer Dispatch Record

| Field | Shape | Contract |
|---|---|---|
| `schemaVersion` | number | Current value is `1`. |
| `repo` | string | Repository full name, such as `owner/repo`. |
| `prNumber` | positive integer | Pull request number. |
| `headSha` | string | Dispatch-record identity SHA and filename key. Current stale-head redrive writers use the live remediation target SHA. |
| `reviewedSha` | string or null | Commit SHA that carried the posted review verdict; preserved for audit/freshness even when `headSha` targets newer remediation. |
| `targetRemediationSha` | string or null | Live PR head SHA targeted by HAM remediation; may differ from `reviewedSha` during stale-review exhausted-lane redrive. |
| `observedHeadSha` | optional string or null | Head returned by the last pre-launch live probe when it differs from the targeted head; null if unavailable. Diagnostic evidence only. |
| `dispatchReason` | string or null | Operator-visible reason for dispatch, such as `exhausted-final-hammer`. |
| `workerClass` | string | Logical closer class requested by AMA, usually `hammer`. |
| `dispatchWorkerClass` | string | Physical worker class passed to HQ after harness fallback. |
| `workerId` | string or null | Stable HQ worker id for this closer launch when AMA supplies one. Hammer records include `hammer-ama-pr-<PR>-<scope>` where `<scope>` is derived from the target head or existing record. Legacy records may omit this field; recovery falls back to the old bare `hammer-ama-pr-<PR>` only when no scoped id is recorded. |
| `promptPath` | string or null | Prompt file handed to `hq dispatch`. |
| `promptDir` | string or null | Directory holding durable AMA closer prompts. |
| `hqRoot` | string or null | HQ root used for the dispatch. |
| `state` | string | Launch state such as `dispatching`, `dispatched`, `launch-terminal`, `dispatch-deferred-transient`, `deferred-by-drain`, `dispatch-failed`, `no-dispatch`, or `completed`. `launch-terminal` releases launch capacity without asserting merge success. |
| `dispatchId` | string or null | Dispatch id parsed from HQ output when available. |
| `launchRequestId` | string or null | Launch request id parsed from HQ output when available. |
| `unadoptedLaunchRequestId` | string, optional | Foreign launch receipt rejected using authoritative ticket evidence. Retained for diagnosis after clearing `launchRequestId` and `dispatchId`; it grants no closer ownership. Reconciliation refunds a previously charged foreign launch once. |
| `infraRearmLoggedLaunchRequestId` | string, optional | Launch whose `ama_closer.infra_dead_hammer_rearm` event was already logged. The event is skipped while this equals `launchRequestId`, so it is logged once per launch whatever the re-arm reason. Stamped only while the record still names that launch. |
| `retryCount` | non-negative integer | Monotonic launch/pass attempt identity. Admission subtracts `unexecutedRefundCount` from this value when enforcing the per-head redispatch bound. Transient and branch-holder refusals preserve budget. |
| `unexecutedRefundCount` | non-negative integer, optional | Number of durable non-execution or independently observed operator-label deferral refunds reconciled for this dispatch head. A label-deferring hammer may have run; this is admission credit, not proof that it never executed. Defaults to zero; reset when the dispatch head advances. Does not reset retry/pass numbering or refund lifetime charges. |
| `labelGateRefundedLaunchRequestId` | string, optional | Launch already credited for a typed operator-label deferral corroborated by a matching live gate on that exact head. Prevents repeat label refunds and duplicate credit during later HAMREFUND-01 or exited-without-close reconciliation. |
| `previousUnexecutedLaunchRequestId` | string, optional | Most recently reconciled non-execution launch, retained after clearing `launchRequestId` and `dispatchId`. Keeps the refunded record discoverable as the review series owner during slow retry. |
| `branchHolderBlockCount` | non-negative integer | Count of branch-holder refusals for bounded same-PR worktree cleanup. |
| `prelaunchRefusalSlowRetry` | optional object | Durable bounded retry window; fields below. Pre-launch refusals apply before launch IDs exist. `non-execution` also applies after a durable harness death; its window survives admission of replacement launches. |
| `prelaunchRefusalSlowRetry.startedAt` | ISO timestamp | First observation that fast pre-launch retries are spent, or a durable non-execution launch is reconciled. Authoritative six-hour window origin, preserved across failed slow attempts and aged holder-counter resets. |
| `prelaunchRefusalSlowRetry.kind` | string | `branch-holder`, `dispatch-refused`, or `non-execution`; retains slow-retry ownership independently of the current refusal counter. |
| `prelaunchRefusalSlowRetry.pagedAt` | optional ISO timestamp | Successful initial slow-cadence alert delivery. |
| `prelaunchRefusalSlowRetry.exhaustedPagedAt` | optional ISO timestamp | Successful window-exhaustion alert delivery. |
| `lastObservedStatus` | string or null | Most recent worker status observed through HQ/session-ledger probes. Lifecycle cancellation uses HQ's reported status, or `terminal` when HQ confirms termination without naming a status; both release dispatch reservations. |
| `lastObservedAt` | string or null | ISO-8601 timestamp for the latest worker observation. |
| `terminalLaunchStatus` | string, optional | Terminal session-ledger launch status, or `not-found` for an expired missing launch, recorded on `launch-terminal` records by launch-capacity reconciliation. PR ownership reconciliation also writes it when settling the matching dispatched lease; terminal observation also writes `state: launch-terminal` before merge evidence is resolved. Cleared when launching again. |
| `reconciledAt` | string, optional | ISO-8601 timestamp when launch-capacity reconciliation wrote `launch-terminal`; cleared when launching again. |
| `lastAttemptedAt` | string or null | ISO-8601 timestamp for the latest launch attempt. |
| `dispatchedAt` | string or null | ISO-8601 timestamp for a confirmed or ambiguous launch. |
| `createdAt` | string or null | ISO-8601 timestamp from the first write when available. |
| `updatedAt` | optional string or null | ISO-8601 timestamp from the latest write when available. For drain deferrals, records the initial refusal or last confirmed active drain poll; lane hints expire after 300 seconds. Legacy drain records fall back to `lastAttemptedAt`. |
| `drainEpoch` | optional string or null | Epoch parsed from an exit-6 drain-in-effect refusal. Diagnostic scheduling evidence; grants no launch or merge authority. |
| `lastFailureTransient` | boolean or null | Whether the latest launch refusal was classified as transient. |
| `lastError` | string or null | Sanitized last error or recovery note. A hammer that ended `succeeded` with its PR still open records the same value as `outcome` here. `hammer-outcome-unconfirmed:<why>` means the live PR state (`live-pr-probe-failed`, `live-pr-state-unknown`) or, for an open PR without a local no-merge audit, its comments (`audit-comments-unreadable`) could not be read, so the launch was retained for another tick. |
| `outcome` | string or null | Resolved lease outcome written during terminal-launch reconciliation (`succeeded` for confirmed merge, otherwise the reclaimable no-merge outcome). Existing successful-process/open-PR classification also writes: `failed-without-merge` (a terminal no-merge audit exists for the current head), `hammer-exited-without-close` (none does; HAMBG-02), or `no-merge:concurrent-writer`. Also written by `closer-terminal-cancel.mjs` for lifecycle settlement (`succeeded` only with matching-head AMA success audit, `no-merge:pr-closed-externally` after HQ cancellation), and by the stale-window reaper for an external merge (`no-merge:pr-merged-externally`). The lifecycle writer locates a rekeyed lease's original dispatch head before updating this record. Unlike lease `terminalOutcome`, this field annotates the dispatch record and may be absent on older records. |
| `status`, `reason`, `terminalOutcome`, `closureAuthority` | string or null | Terminal/no-dispatch annotations used by recovery and audit paths when present. |

## Operational Contract

- A newly returned launch receipt retains `state: dispatched`, its launch IDs,
  and its active lease when ticket evidence is unavailable. It is charged
  conservatively until reconciliation; authoritative foreign-ticket evidence
  retires the record and refunds that charge once. Missing ticket evidence
  cannot create a `no-dispatch` record or authorize another spawn.
- Active `dispatching` and `dispatched` records reserve the same `(repo, PR)`
  from follow-up consumption until the record reaches a terminal state or ages
  past the documented reclaim window.
- A same-worker provision-slot lock timeout with a proven live holder and no
  launch receipt settles as `dispatch-deferred-transient`, with
  `lastFailureTransient: true`, the refusal in `lastError`, and unchanged
  `retryCount`. The failed attempt releases its pending lease and no longer
  reserves launch capacity, allowing provisioning to retry on the next poll.
  A receipt retains ownership; a mixed diagnostic uses ordinary refusal rules.
- Recovery checks age records from the latest parseable timestamp among
  `lastObservedAt`, `lastAttemptedAt`, `dispatchedAt`, and `createdAt`.
- A `dispatching` record with no parseable timestamp is stale; a launch-only
  `dispatched` record without timestamps remains held until first observation.
- Dispatch capacity first applies record identity, age and lease liveness checks.
  Only launches that would otherwise consume a slot are probed in the ledger;
  aged-out historical records are left for manual reconciliation. Production PostgreSQL scans share one timeout-bounded read-only launch snapshot,
  including transitive retry descendants; SQLite uses its in-process indexed reads.
  Unreadable, missing or budget-skipped evidence retains same-PR ownership and
  reserves fleet capacity inside the bounded pending-launch window. Unreadable
  retry chains reserve the same bounded capacity even with a terminal ancestor.
  The watcher explicitly enables snapshots through its status wrapper and
  forwards the snapshot to every per-record read, including failed snapshots.
  Injected per-launch readers retain the one-second scan budget and stop further queries after an unreadable result. Cancellation is checked between
  probes. `dispatching` intents are never probed or rewritten, since same-head
  retries can still reference the previous LRQ.
- The path and read-only JSON reader live in `src/ama/dispatch-record-read.mjs`,
  re-exported by the dispatcher for compatibility; hammer wakes import the leaf.
- Reconciliation annotates confirmed terminal `dispatched` launches as
  `launch-terminal`, preserving existing fields and leaving closer and merge
  leases untouched. Launch success alone is not merge success. Missing rows
  expire after the pending-launch timeout; an unparseable launch timestamp
  keeps the reservation until observation. New launch writes clear
  `terminalLaunchStatus` and `reconciledAt`. Capacity recognizes `reaped` and
  `cancelled` without widening the per-PR unknown-status retry/re-arm decision.
- Terminal-success ownership remains held while a live OPEN PR has an armed
  `autoMergeRequest` only within the 30-minute dispatched-lease window, measured
  from `updatedAt` (or `acquiredAt`) without extending it on observation. A no-merge
  audit bypasses this hold. Expiry emits `ama_closer.auto_merge_hold_released`
  and releases as `failed-without-merge` under ordinary retry/refund caps. A
  stale-active worker with ledger `succeeded` enters the live terminal-success
  classifier before retry/refund admission; the persisted observation remains
  `unverified-terminal-success` with raw `terminalLaunchStatus: succeeded`.
- Manual reconciliation must run as the canonical daemon account for the runtime
  root, pinning `--hq-root` and `--ledger-target` to match the watcher. The CLI
  reports the resolved backend and source without exposing DSN credentials.
  Atomic replacement takes the caller's ownership; see the owner-qualified
  commands in `docs/RUNBOOK-ama-closure.md`.
- `workerId` is authoritative for scoped hammer cleanup when present. Legacy
  records without `workerId` remain readable and use the historical unscoped
  hammer id as the fallback cleanup target.
- The closer reconciles the review series' newest launch. A launch on an
  advanced head writes its record under that head, so when a record for the
  same `reviewedSha` carries a newer `launchRequestId` and `dispatchedAt` than
  the reviewed-head record, the closer reads that one (HAMBG-02).
- The per-PR scan and the active-launch scan share one directory listing
  (`src/ama/dispatch-dir-names.mjs`). A stat of the directory decides whether
  that listing is reused. Any entry created, renamed or removed changes the
  directory mtime, and a listing taken within 2s of that mtime is never reused.
  Record contents are always read fresh.
- Writes are atomic JSON rewrites. Corrupt or unreadable records are skipped by
  bounded scans so one bad file cannot blind later active reservations.
- Exhausted pre-launch refusals retry at most once per pending-lease reclaim
  window (about 31 minutes by default), for six hours from the first exhausted
  observation. `startedAt` and both page markers survive every pre-launch write,
  including `dispatching` and subsequent failures. Resetting a branch-holder
  counter does not restart fast retries or extend the deadline. A confirmed
  launch clears pre-launch refusal windows. A `non-execution` window survives
  replacement admission and later deaths; a new head resets that window and
  `unexecutedRefundCount`, while PR-wide lifetime charges remain intact. Exhaustion
  stops retries and pages once with the latest refusal. Failed alert deliveries
  retry on later ticks; process-local debounce limits repeat pages if persistence
  fails, but does not survive a watcher restart. No new schema version is needed
  for this optional additive field.

- HAMREFUND-01 requires durable signal/tool-host failure fields, the same
  live OPEN head, no terminal local audit, readable absence of a no-merge
  closing audit and a cleanly missing merged signal with repository producer
  evidence. It refunds series/target charges once per retained launch identity,
  preserves lifetime charges and suppression, cleans up the worker, records the
  failed pass and terminalizes the lease before arming `non-execution` slow retry.
  A concurrent record change emits
  `ama_closer.unexecuted_refund_dispatch_record_changed` with the refunded LRQ.
  The ledger refund remains durable and is idempotent on reconciliation.
- Before eligibility, the current PR reconciles its own terminal ledger launch
  independently of the fleet scan budget. Its record becomes `launch-terminal`;
  confirmed no-merge settlement writes `outcome` and `terminalOutcome` alongside
  the matching lease. A live OPEN same-head probe releases a successful process
  exit after the 60-second grace when `terminal_at` is readable; without that
  timestamp the same-head exit releases immediately. Armed auto-merge adds only
  the bounded hold described above. Merge evidence and
  successful audits stay sticky. Series, target, lifetime and refund caps remain
  authoritative; unreadable PR evidence retains existing ownership bounds.

- Primary-change collection uses the earliest hammer launch with a valid 40-hex
  `targetRemediationSha` as trusted author-baseline evidence, even when repairs
  lack HAM trailers. If a rebase diverges from that launch, the first verified
  HAM commit parent supplies the rebased baseline. Malformed matching JSON records are skipped. Matching-record I/O failures
  defer intent collection as `primary-change-read-failed` rather than parking
  permanently or silently dropping protection. Legacy records without valid
  baseline SHAs do not hide later trusted launches.

## Operator-label deferral credit (LABELGATE-01)

A latest `deferred` audit attempt with `reason: operator-label-required:<label>`
is eligible only while the closer independently observes that matching label
gate on the current live head. The recorded hammer must match the retry ledger's
latest dispatched head and reviewed-head job key, and the attempt timestamp must
be at or after its dispatch. A hammer-written reason alone grants no credit.
The existing PR 1261 refund operation records the LRQ in
`unexecutedLaunchRequestIds`, reducing series/target charges once while retaining
lifetime charges and suppression. The record's marker and
`unexecutedRefundCount` are updated once; later signal/non-execution or
exited-without-close reconciliation cannot grant another credit to that launch.

Terminal-worker cleanup, lease settlement and pass/token accounting run before
the label refund and hold.
The label refund itself does not perform those operations. Its receipt is
separate from dispatch ownership; see [Operator Label Holds](operator-label-holds.md).

A final live-probe head movement writes `state: no-dispatch`,
`reason: dispatch-head-context-changed`, and `observedHeadSha` before charging
retry budget. Stale context with no reviewed-head binding returns
`dispatch-head-context-unavailable` after lease reconciliation and evidence-hold
probing; it does not create a new dispatch record or launch a worker.

## Configuration refusal (UNREGREPO-01)

A dispatch refused with `repo_unregistered`, without launch evidence, stores
`state: dispatch-configuration-refused`,
`closureBlocker: dispatch-configuration-refused:repo_unregistered`, and
`lastFailureTransient: false`. Its retry count is preserved and its pending
lease is released. Rechecks use the normal pending-lease reclaim interval;
successful admission sets `closureBlocker: null` and `state: dispatched`.
Repository-wide paging receipts live in
[AMA dispatch configuration receipts](ama-dispatch-configuration.md).
Legacy no-launch records whose last error names `repo_unregistered` are
reclassified on observation, including records with an exhausted generic slow
retry window. Only that configuration refusal bypasses generic prelaunch retry
exhaustion; hammer launch/lifetime caps remain unchanged.

## Deploy drain scheduling (DRAINDEFER-01)

Exit 6 with an anchored `dispatch refused: drain in effect` line records
`state: deferred-by-drain` and `drainEpoch`.
`drainEpoch` preserves the complete non-whitespace epoch token up to a comma or
closing parenthesis, including formatted or alphanumeric identifiers; absent
epochs are null. Drain classification requires exit 6 and the anchored diagnostic.
Incidental drain text or another exit code does not qualify for drain retries.
No launch IDs means the pending
lease is released, the retry budget is preserved, and inline transient retries
are skipped. The drain lookup and hint retirement resolve the head from
`prMetadata.headSha`, then `reviewState.headSha`, then
`dispatchContext.reviewedSha`, then top-level `headSha`, using the first
non-empty value. On each watcher pass the closer reads `hq dispatch drain-status
--no-reap` for its HQ root (and ledger DB override when supplied). Any active
drain, including a newer epoch, keeps the PR deferred. A clear drain re-enters
ordinary live-head, eligibility, lease and capacity admission on that pass.
Unreadable status falls back to ordinary dispatch, whose refusal is authoritative.

The lane reads the current-head closer record before applying backoff. Only
hints younger than 300 seconds bypass backoff and no-progress accounting.
`updatedAt` records the initial drain refusal and each confirmed active status
poll; legacy records fall back to `lastAttemptedAt`. Missing, malformed, future
or expired timestamps do not bypass accounting. The lane retires expired hints
independently of closer admission; either AMA kill switch retires them too.
When autonomous execution is disabled and the live head is unavailable,
orchestration retires the hint keyed to the reviewed head.
Existing lane debt is preserved, including debt predating the drain. Legacy
transient records with an exit-6 drain diagnostic obey the same freshness rule.
This recovery does not consume decision reset credit. Background settlement of
a drain refusal submits fresh work on the next pass instead of spending that pass applying an obsolete refusal.
Other exit-6 causes retain ordinary classification, inline retries and budgets.

Before ordinary admission resumes, the closer retires the drain scheduling hint
as `no-dispatch`, reason `drain-wait-ended`, so a new eligibility blocker uses
normal lane accounting. Hint cleanup is best effort and cannot refuse admission.
Other exit-6 diagnostics include dispatch preflight timeouts and worker-class
fallback refusals; these keep their existing transient/failure classification.

The external producer contract was inspected in agent-os commit
`071f52c62d802f03681ea69a5269a4384fa6cc93`:
`modules/worker-pool/lib/python/cwp_dispatch/cli_drain.py` (`cmd_drain_status`
and its parser) accepts `dispatch drain-status --no-reap --root <hqRoot>` and
optional `--db-path <ledgerDbPath>`; `drain_state.py:DrainState.to_json` emits
boolean `isDraining` and numeric `epoch`. The caller uses `cwd: AGENT_OS_ROOT`.
Invalid JSON or a missing/non-boolean `isDraining` is unreadable status, never
confirmed clearance. As with command failures, it falls back to authoritative
ordinary dispatch, logging once per HQ root/recorded epoch per process (bounded
to the latest 100 keys). Offline fixtures pin arguments, cwd and schema handling;
this repository does not execute the external producer during tests.
