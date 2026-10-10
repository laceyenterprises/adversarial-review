# Data Model - AMA Closer Dispatch Records

**Owner:** AMA closer dispatch and recovery
**Store:** `data/follow-up-jobs/ama-closer-dispatches/`
**Source of truth:** `src/ama/dispatch-closer.mjs`
**Runtime surface:** `src/ama/primary-change.mjs`, `src/ama/dispatch-closer.mjs`, `src/ama/prelaunch-refusal-retry.mjs`, `src/ama/dispatch-dir-names.mjs`, `src/ama/closer-terminal-cancel.mjs`, `src/follow-up-stuck-claim-sweep.mjs`, `src/recovery-reaper.mjs`, `bin/reconcile-ama-closer-dispatches.mjs`

## Purpose

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
| `dispatchReason` | string or null | Operator-visible reason for dispatch, such as `exhausted-final-hammer`. |
| `workerClass` | string | Logical closer class requested by AMA, usually `hammer`. |
| `dispatchWorkerClass` | string | Physical worker class passed to HQ after harness fallback. |
| `workerId` | string or null | Stable HQ worker id for this closer launch when AMA supplies one. Hammer records include `hammer-ama-pr-<PR>-<scope>` where `<scope>` is derived from the target head or existing record. Legacy records may omit this field; recovery falls back to the old bare `hammer-ama-pr-<PR>` only when no scoped id is recorded. |
| `promptPath` | string or null | Prompt file handed to `hq dispatch`. |
| `promptDir` | string or null | Directory holding durable AMA closer prompts. |
| `hqRoot` | string or null | HQ root used for the dispatch. |
| `state` | string | Launch state such as `dispatching`, `dispatched`, `launch-terminal`, `dispatch-deferred-transient`, `dispatch-failed`, `no-dispatch`, or `completed`. `launch-terminal` releases launch capacity without asserting merge success. |
| `dispatchId` | string or null | Dispatch id parsed from HQ output when available. |
| `launchRequestId` | string or null | Launch request id parsed from HQ output when available. |
| `infraRearmLoggedLaunchRequestId` | string, optional | Launch whose `ama_closer.infra_dead_hammer_rearm` event was already logged. The event is skipped while this equals `launchRequestId`, so it is logged once per launch whatever the re-arm reason. Stamped only while the record still names that launch. |
| `retryCount` | non-negative integer | Budgeted failed-dispatch count. Transient and branch-holder refusals preserve budget. |
| `branchHolderBlockCount` | non-negative integer | Count of branch-holder refusals for bounded same-PR worktree cleanup. |
| `prelaunchRefusalSlowRetry` | optional object | Durable bounded pre-launch retry window; fields below. Applies only before any `launchRequestId` or `dispatchId` exists. |
| `prelaunchRefusalSlowRetry.startedAt` | ISO timestamp | First observation that fast pre-launch retries are spent. Authoritative six-hour window origin, preserved across failed slow attempts and aged holder-counter resets. |
| `prelaunchRefusalSlowRetry.kind` | string | `branch-holder` or `dispatch-refused`; retains slow-retry ownership independently of the current refusal counter. |
| `prelaunchRefusalSlowRetry.pagedAt` | optional ISO timestamp | Successful initial slow-cadence alert delivery. |
| `prelaunchRefusalSlowRetry.exhaustedPagedAt` | optional ISO timestamp | Successful window-exhaustion alert delivery. |
| `lastObservedStatus` | string or null | Most recent worker status observed through HQ/session-ledger probes. Lifecycle cancellation uses HQ's reported status, or `terminal` when HQ confirms termination without naming a status; both release dispatch reservations. |
| `lastObservedAt` | string or null | ISO-8601 timestamp for the latest worker observation. |
| `terminalLaunchStatus` | string, optional | Terminal session-ledger launch status, or `not-found` for an expired missing launch, recorded on `launch-terminal` records by launch-capacity reconciliation; cleared when launching again. |
| `reconciledAt` | string, optional | ISO-8601 timestamp when launch-capacity reconciliation wrote `launch-terminal`; cleared when launching again. |
| `lastAttemptedAt` | string or null | ISO-8601 timestamp for the latest launch attempt. |
| `dispatchedAt` | string or null | ISO-8601 timestamp for a confirmed or ambiguous launch. |
| `createdAt` | string or null | ISO-8601 timestamp from the first write when available. |
| `updatedAt` | string or null | ISO-8601 timestamp from the latest write when available. |
| `lastFailureTransient` | boolean or null | Whether the latest launch refusal was classified as transient. |
| `lastError` | string or null | Sanitized last error or recovery note. A hammer that ended `succeeded` with its PR still open records the same value as `outcome` here. `hammer-outcome-unconfirmed:<why>` means the live PR state (`live-pr-probe-failed`, `live-pr-state-unknown`) or, for an open PR without a local no-merge audit, its comments (`audit-comments-unreadable`) could not be read, so the launch was retained for another tick. |
| `outcome` | string or null | Dispatch result written by `dispatch-closer.mjs` when a hammer ended `succeeded` with its PR still open: `failed-without-merge` (a terminal no-merge audit exists for the current head), `hammer-exited-without-close` (none does; HAMBG-02), or `no-merge:concurrent-writer`. Also written by `closer-terminal-cancel.mjs` for lifecycle settlement (`succeeded` only with matching-head AMA success audit, `no-merge:pr-closed-externally` after HQ cancellation), and by the stale-window reaper for an external merge (`no-merge:pr-merged-externally`). The lifecycle writer locates a rekeyed lease's original dispatch head before updating this record. Unlike lease `terminalOutcome`, this field annotates the dispatch record and may be absent on older records. |
| `status`, `reason`, `terminalOutcome`, `closureAuthority` | string or null | Terminal/no-dispatch annotations used by recovery and audit paths when present. |

## Operational Contract

- Active `dispatching` and `dispatched` records reserve the same `(repo, PR)`
  from follow-up consumption until the record reaches a terminal state or ages
  past the documented reclaim window.
- Recovery checks age records from the latest parseable timestamp among
  `lastObservedAt`, `lastAttemptedAt`, `dispatchedAt`, and `createdAt`.
- A `dispatching` record with no parseable timestamp is stale; a launch-only
  `dispatched` record without timestamps remains held until first observation.
- Dispatch capacity first applies record identity, age and lease liveness checks.
  Only launches that would otherwise consume a slot are probed in the ledger;
  aged-out historical records are left for manual reconciliation. The first
  unreadable ledger result suppresses further probes for that scan, retaining
  capacity under the existing liveness rules. Cancellation is checked between
  probes. `dispatching` intents are never probed or rewritten, since same-head
  retries can still reference the previous LRQ.
- Reconciliation annotates confirmed terminal `dispatched` launches as
  `launch-terminal`, preserving existing fields and leaving closer and merge
  leases untouched. Launch success alone is not merge success. Missing rows
  expire after the pending-launch timeout; an unparseable launch timestamp
  keeps the reservation until observation. New launch writes clear
  `terminalLaunchStatus` and `reconciledAt`. Capacity recognizes `reaped` and
  `cancelled` without widening the per-PR unknown-status retry/re-arm decision.
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
  launch clears the object; a new head has a new dispatch record. Exhaustion
  stops retries and pages once with the latest refusal. Failed alert deliveries
  retry on later ticks; process-local debounce limits repeat pages if persistence
  fails, but does not survive a watcher restart. No new schema version is needed
  for this optional additive field.

- Primary-change collection uses the earliest hammer launch with a valid 40-hex
  `targetRemediationSha` as trusted author-baseline evidence, even when repairs
  lack HAM trailers. If a rebase diverges from that launch, the first verified
  HAM commit parent supplies the rebased baseline. Malformed matching JSON records are skipped. Matching-record I/O failures
  defer intent collection as `primary-change-read-failed` rather than parking
  permanently or silently dropping protection. Legacy records without valid
  baseline SHAs do not hide later trusted launches.
