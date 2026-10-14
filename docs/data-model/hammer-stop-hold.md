# Data Model - Hammer Stop Hold

**Owner:** AMA closer retry admission
**Store:** `data/follow-up-jobs/hammer-stop-hold/`
**Source of truth:** `src/ama/hammer-stop-hold.mjs`
**Runtime surface:** `src/ama/dispatch-closer.mjs`, `src/ama/audit.mjs`, `src/checks-summary.mjs`, `src/posted-review-row.mjs`

## Purpose

After a hammer stops without merging, the closer holds another attempt until
an input changes, and pages once per head with the recorded predicate. Daemon
failures do not create hammer holds. The producer and legacy compatibility
rules are defined in the [AMA audit contract](ama-audit.md).

## Files and shape

One atomically rewritten JSON object per `(repo, PR)` lives at
`<repo-slug>-pr-<number>.json`. The slug replaces every character outside
`A-Za-z0-9._-` with `-`, including `/`. There is no schema-version field.

| Field | Shape | Contract |
|---|---|---|
| `heads` | object keyed by head SHA | At most eight entries retained, newest `firstObservedAt` first. |
| `heads[sha].stopKey` | string | Audit file head, attempt number (or array index), and attempt start/timestamp identify one stop. A different stop creates a new hold entry. |
| `heads[sha].predicate` | string | Recorded stop reason, normalized to one line and capped at 120 characters, or `reason-not-recorded`. |
| `heads[sha].firstObservedAt` | ISO timestamp | First closer observation of this stop. |
| `heads[sha].inputs` | object | Baseline `{ headSha, baseSha, mergeability, checks }`. SHA fields are strings or null; mergeability is `MERGEABLE`, `CONFLICTING`, or null. `checks` is a sorted, pipe-joined string of lowercase check identities and normalized latest states. |
| `heads[sha].pagedAt` | ISO timestamp or null | Successful operator alert delivery. Carried forward for subsequent stops on the same head. |
| `heads[sha].releasedAt` | optional ISO timestamp | First observation of changed inputs. A released stop remains released across ticks and restarts. |
| `heads[sha].releasedBy` | optional string array | Release dimensions: `head`, `base`, `mergeability`, `checks`, `conflicting` (REMCONFLICT-01), `primary-change-evidence` (CAPROUTE-01), `hold-released` (HOLDRELEASE-01). |
| `heads[sha].releasedInputs` | optional inputs object | Inputs at release; used as the next stop's baseline if another hammer stops on this head. |

## Recovery and retention

HOLDRELEASE-01 reads the latest non-cancelled operator release for this exact
head from [operator_hold_releases](operator-hold-releases.md), only when the
stored labels are readable and no longer held. A `released_at` strictly later
than the stop's `recordedAt` (the attempt's `startedAt`, then `timestamp`, then
`recordedAt`; otherwise the hold's `firstObservedAt`) releases with
`releasedBy: ['hold-released']`. This is deliberately independent of the stop
predicate; ordinary eligibility and retry caps still apply. Because legacy
comparison uses attempt start time, a release during an attempt can also unlock
its later terminal stop. Only proven hold-only non-execution stops qualify for
the separate [retry-cap refund](hammer-retry-cap.md). Refund write failures
log a warning and leave charges intact without suppressing the hold release.

The closer reads fresh audit evidence on each tick; the hold file alone cannot
create a decision. Known current SHA or mergeability readings can release an
unknown baseline; missing current SHA readings and `UNKNOWN` mergeability
cannot prove change. Checks use the canonical latest-run and own-status
exclusion helpers: only matching `StatusContext` entries (or legacy entries
with `context` and no type) are excluded. A same-name external `CheckRun`
remains an input. Missing/non-array rollups are represented as an empty string.

CAPROUTE-01 includes legacy `primary-change-unknown` stops and
`primary-change-read-failed` stops. On every closer evaluation of an open PR
with one of these stops on the live head, a read-only primary-change probe runs
before ordinary eligibility, including on CYCLECAPHAM-01 / CIBLOCKHAM-01
hammer-owner routes and stale-review heads that are not closer-authored.
While the answer remains unknown or unreadable, the hold remains active. Once
the answer is computable, the store persists `primary-change-evidence` in
`releasedBy`, even if the computable answer refuses merge (for example,
`primary-change-reverted`). Release clears the evidence wait, not the merge
predicate. There is one probe per pass while unreleased, no probe backoff in
this store, and no further probe for the same released stop. Hold observation
and release timestamps use the closer pass's `dispatchedAt` when supplied.

TRANSIENTSTOP-01 also includes `history-read-failed`. The posted-review
no-progress lane reads the latest hammer audit before applying backoff. All
`HAMMER_EVIDENCE_FAILURES` stops that have neither paged nor released are
eligible every five minutes, anchored to the no-progress ledger's `lastRunAt`.
This includes the initial observation before a hold file exists. The gate reads
the matching hold through `readHammerStopHoldForHead`; a different `stopKey`
cannot supply release state for the current stop. Paged or released stops use
ordinary lane backoff, including while other dispatch prerequisites remain
pending. Review or gate events are not needed to retry the probe.

Only `history-read-failed` defers its page: a failed probe must remain unresolved
for ten minutes from `firstObservedAt`, allowing two default five-minute polling
intervals for recovery. The probe runs before the page decision, so success at
the deadline releases without paging. The durable timestamp preserves the
deadline across restarts. Other predicates retain immediate paging. A terminal
retryable HQ status is persisted before the launch-capacity scan, so an old
running record cannot delay redispatch when its lease is gone and its ledger
read is unavailable. Live launch, lease, eligibility and retry limits still
apply.

Release permits ordinary eligibility, lease and retry-cap checks; it does not
authorize dispatch or merge by itself. A new head starts its own entry. A new
stop on an existing head carries its page marker and uses the prior release
inputs when available. The `ama_closer.hammer_stop_hold` alert retries on
delivery failure. A successful page also sets process-local debounce so failed
state writes cannot page every tick; that fallback resets on process restart.
Unreadable/malformed hold files are treated as empty state and rebuilt from
audit evidence. Write failures are logged and the in-memory decision still
applies for that tick. Retention is capped at eight heads per PR, with no TTL.
