# Data Model - Orphan Watchdog

**Owner:** AMA owner-of-last-resort recovery
**Store:** `data/follow-up-jobs/orphan-watchdog/<sha256(repo#prNumber)>.db` and sibling `.lock`
**Source of truth:** `src/ama/orphan-watchdog.mjs`
**Runtime surface:** `src/ama-closure-orchestration.mjs`

## Schema and lifecycle

Each PR has a SQLite database with one `heads` row per observed head SHA. The
`head` text primary key scopes all budgets and guards. Integer columns default
to zero: `ticks`, `attempts`, `paged`, `rereview`, `reserved`, `uncertaintyTicks`,
and `uncertaintyPaged`. Nullable text columns are `evidence` (bounded JSON
attempt summary or reservation metadata) and `pageError` (last enqueue error,
limited to 300 characters). Creation uses `CREATE TABLE IF NOT EXISTS`; existing
databases gain the four reservation/uncertainty columns with idempotent
`ALTER TABLE` migration. Existing attempt counts are preserved.

A nonblocking exclusive flock on the sibling `.lock` serializes observations,
reservation, dispatch and page enqueue across watcher processes. Lock contention
returns pending without consuming a tick or attempt. File descriptors and the
SQLite connection close on every exit.

Six consecutive eligible ownerless observations reserve an attempt atomically:
`attempts` increments, `reserved=1`, `ticks=0`, and `evidence` records
`reservationStartedAt` and `reason=reserved-outcome-unknown` before dispatch.
Settlement clears `reserved` and records only `dispatched`, a bounded `reason`,
and `launchRequestId`. Explicit pre-launch refusals (including a live owner or
gate-read failure) refund the reservation. Cancellation before calling dispatch
also refunds it. Exceptions after dispatch begins, including aborts, timeouts
and transient GitHub failures, retain `reserved=1` and the reservation evidence
for reconciliation; they cannot prove HQ refused admission. No launch is
authorized by uncertain ownership evidence.

After interruption, the next eligible observation reconciles the reservation.
A same-head record with a launch identity and readable launch status proves
dispatch when `dispatchedAt` or `lastAttemptedAt` falls in the reservation second
or later. This accommodates second-truncated receipts and later `no-dispatch`
writes that retain the receipt fields. Launch reconciliation runs before the
live-owner return and retains the charged attempt. With neither an owner nor
uncertain evidence, absence of launch proof refunds it. A live owner
holds the reservation; unreadable or missing launch evidence retains it and
enters the uncertainty lane rather than charging another attempt. Malformed
evidence JSON or a reserved row without a valid reservation timestamp fails
closed without modifying its attempt budget.

`uncertaintyTicks` counts consecutive uncertain ownership observations. At six,
`uncertaintyPaged` deduplicates `ama.orphan_recovery.ownership-uncertain` SEV1
paging while dispatch remains held. A stale `dispatching` record without a
launch identity is uncertain, using the closer's `isAmaCloserLaunchInProgress`
lease/PID/age checks to distinguish it from a live launch (including the narrow
pre-lease write window). It never proves permanent ownership. Unreadable
primary-change evidence (`primary-change-unknown`) uses this uncertainty lane
and cannot admit a repair worker. Proven ownership or restored readable
evidence resets the uncertainty streak. Terminal launch statuses share the
closer's capacity classification; a terminal rekey successor lease's ancestry
supersedes obsolete closer records. Dispatch filenames are filtered to the PR
before reads; cached settled listings and a bounded coexistence probe limit
fleet-history scans and ledger subprocess time.

At two settled attempts, `paged` deduplicates
`ama.orphan_recovery.exhausted` SEV1 paging. Both page guards are set only after
successful enqueue. Exhaustion and uncertainty pages also use deterministic
alert-outbox identities scoped to repo/PR/head, so a crash before updating a
page guard cannot enqueue a duplicate. Failures persist `pageError` and retry
on later ticks without another launch. Pages contain bounded reason/round/stop/launch summaries, never
whole review or job objects. `rereview` guards the one exact-head review request
for an uncertifiable closer-authored head.

Ineligibility or a known owner resets consecutive observation streaks. An
empty head or unsettled background-dispatch result is neutral: no store write,
observation, or reset. Head changes reset other heads' streaks, preserving
attempts and page/re-review guards.
Operator stop codes other than the explicit `no-progress` / `remediation-stopped`
allowlist are ineligible. A blocking job with no stop requires explicit valid
round and max-round evidence; an absent plan grants no below-max admission.
Scoped operator merge-agent fallback and its lease checks precede watchdog
recovery in coexistence routing. Eligible orphan observations, including the
grace period and exhausted heads, precede and hold ordinary automated recovery
and comment-only CI routing. Exhaustion remains a hold for that head until an
operator acts or the head changes; returning to an old head retains its budget.

Filesystem, lock, SQLite and evidence failures are contained at the recovery
boundary. They log a bounded warning, enqueue `ama.orphan_recovery.store-error`
SEV1 through the independent alert outbox, and return `ama-pending` with
`skipMergeAgent: true`, including when an ineligible tick opens an existing
store. The store-error alert identity is deterministic per repo/PR/head.
Pager failure logs a second warning and keeps the hold. No failed-store path
falls through to ordinary recovery or merge-agent dispatch.

## Retention and migration

There is no automatic expiry or cleanup of databases, head rows or lock files.
An operator may archive closed-PR diagnostics. Do not delete an open head's store
to reset its budget or guards. Returning to an old head retains its budget.
This replaces automatic observation writes to the legacy
[HAM primary-change refusal store](ham-primary-change-refusals.md).


Reservation `evidence` also records `recordHeadSha`, the expected closer dispatch
head (which may differ from the live closer-authored head). Together with the
reservation timestamp, this reconciles a launch receipt without refunding an
already spent attempt. Legacy reservations without this field continue to match
the live head and fail closed on uncertain evidence.
