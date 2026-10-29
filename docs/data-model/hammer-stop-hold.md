# Data Model - Hammer Stop Hold

## Deployment recovery (HOLDGATEVERSION-01)

Deterministic refusals also record `gateRevision: { serviceRevision,
predicateVersion }`. The terminal audit's `reviewServiceRevision` and optional
`gatePredicateVersion` take precedence; missing legacy provenance is anchored
at the first observation with a nonempty service or predicate revision. If both
are unavailable, defer anchoring; an existing all-null anchor is retried on
later observations. Repeated observations retain a known baseline. A missing
revision cannot prove a deployment, and legacy holds without provenance require
a subsequent observed revision change rather than a guessed historical revision.

`awaits` adds `gate-revision-change` only for deterministic refusals. Either
nonempty recorded component differing from its nonempty current observation
releases the hold. `serviceRevision` is the service checkout commit captured
when the process loads (`git:<sha>`), comparing canonical physical paths so
symlinked checkouts retain Git provenance and accepting LF or CRLF stdout. It
falls back to `package:<version>` for packaged deployments. The subject PR and Agent OS parent checkout are never
revision sources. Updating files underneath a running process does not advance
its loaded revision; normal deployment must load the new service code.
Predicate versions are optional producer evidence, with no new config key.

Normal admission and the skipped-subject poll sweep share anchoring and this
predicate. Both upgrade existing `holdVersion: 1` refusals with missing or
all-null provenance and install the predicate before evaluation. The sweep
persists the upgrade under its existing lock and unchanged-file fence even
when no release or alert is due, preserving deadlines and delivery receipts.
A retained refusal behind packaging-only audit history uses the same upgrade;
packaging provenance cannot become the refusal baseline.
Release persists `releasedBy: ['gate-revision-change']`, `releasedAt`,
`releasedGateRevision` and the ordinary released input baseline. Repeated polls
and restarts retain one release receipt. A subsequent deterministic stop under
the new revision starts a fresh hold. Existing leases fence duplicate dispatch;
per-head, series and lifetime caps remain charged and can refuse re-dispatch.
Transient and companion stops retain their existing recovery behavior. Release
grants no merge authority and changes no merge predicate.


## Actions infrastructure recovery (CIBLOCKINFRA-01)

Closure preflight calls the evaluator only for stops already classified as
infrastructure. Ordinary executed CI and refusal-bearing stops retain the
closer's complete review baseline; preflight cannot seed or release that hold.

`isInfrastructureStop` also recognizes CI-only stop reasons when every
recorded failure has shared zero-step or billing/quota evidence. Unknown or
real failures and non-CI refusal reasons retain the ordinary hold. The audit
reader preserves failed-check evidence and never lets a later infrastructure
stop erase an earlier real deterministic refusal.

Infrastructure-only CI creates no hold or page. Required-check greenness
continues to refuse merge. On an open current head, successful replacements
for every failed check release an existing CI hold with
`releasedBy: ['ci-infrastructure-recovered']`. The hold retains
`failedChecks`, `stopKey` and `releasedAt`; the event
`ama_closer.ci_infrastructure_stop_released` names `checks-executed-again`.
Historical job URLs may supply missing exact-head steps through one bounded
read. Unproven historical stops remain held.

Only positively identified infrastructure dispatch charges are credited
through the existing hammer ledger's per-budget refunds. A real stop in the
same series is preserved. Packaging-stop behavior and its retry charges are
unchanged.

**Owner:** AMA closer retry admission
**Store:** `data/follow-up-jobs/hammer-stop-hold/`
**Source of truth:** `src/ama/hammer-stop-hold.mjs`
**Runtime surface:** `src/ama/dispatch-closer.mjs`, `src/ama/audit.mjs`, `src/checks-summary.mjs`, `src/posted-review-row.mjs`

## Shared closer contract (HOLDCONTRACT-01)

Each active head entry also carries `owner`, `awaits`, `deadline`, `onDeadline`
and `reason`, validated before persistence. The shared evaluator retains the
existing release and paging horizons, and poll evaluation includes scheduled-out
subjects. Existing readers normalize legacy entries. See the
[shared record and predicate contract](closer-holds.md) for writer inventory,
legacy defaults, poll deduplication and deadline receipts.

## Companion dependency waits (COMPANIONFLOAT-01)

Pure `companion-submodule-pr-unmerged`, `companion-float-pending` and
`companion-submodule-float-pending` stops use `mode: companion` before transient
upgrade, input-change, conflict or timed releases. Mixed blockers retain ordinary
handling. The hammer records `companionWait: { repo, prNumber, submodulePath,
mergeCommit }` on its terminal audit. Older notes can recover only a unique PR
URL mapped through the base `.gitmodules`; ambiguous evidence stays held.

The hold adds `owner: closure-recovery`, `awaitedEvent`, `waitUntil`,
`companionWait`, `events` and optional `probeError`. The dependency records its
repository, PR and path, authoritative `state`, `mergeCommit`, `mergedAt`,
observed `baseSha`, `gitlinkSha` and `containsMerge`. Failed ancestry reads retain
known merge evidence and fail closed. TIMEOUTSWEEP-01 records a failed companion
state read as `state: unknown`, `containsMerge: false` and `probeError`; prior
identity and timing remain evidence only. This record never proves open, closed,
merged or floated and is re-probed on the next pass. A closed-unmerged alert
requires a fresh read; the existing elapsed dependency SLA still escalates once.
Status and escalation name the automated
owner and awaited event, replacing historical operator follow-through prose.

The posted-review lane probes unreleased waits every five minutes, including
paged waits. Unrelated base/check/review movement cannot release an open
companion. Merge records `events.companionMergedAt` and a `companion-merged`
release audit, then immediately re-evaluates the float wait without launching a
closer. The base contents API must identify the expected submodule repository;
its gitlink must equal or descend from the authoritative merge commit (compare
API merge-base proof). Containment records `events.companionFloatedAt`,
`releasedAt` and `releasedBy: [companion-floated]`. Ordinary gates, exact-head
validation, leases and remaining caps then decide one dispatch. Each admission
reads fresh dependency evidence; a stale release cannot authorize a regressed
base. Release events are logged once per dependency/head.

Closure orchestration applies this fence before owner/cap selection and daemon
merge. Generic final-round and automated-recovery timers defer to its deadline.
Normal submodule float owns the gitlink update. A closed-unmerged companion
escalates immediately; a missing float escalates 24 hours plus a one-hour
scheduling margin after merge. Unmerged/unreadable waits have the same bound
from first observation. `pagedAt` and process debounce make the existing
`ama_closer.hammer_stop_hold` escalation once-only per dependency/head, naming
the companion and owner. Failed delivery retries. No config or float changes.

Only exact recorded dispatch charges with pure companion terminal evidence are
credited once per launch through the existing PR-scoped ledger lock. Mixed and
genuine failures remain charged. The per-head dispatch bound subtracts these
credits too; see [retry-cap accounting](hammer-retry-cap.md#companion-wait-credits-companionfloat-01).

## Operator approval release (APPROVALREARM-01)

Refusals may carry `awaitedInputs: [{ kind: "operator-label", label }]`.
When every named label appears on the exact open head, the hold records
`releasedBy: [operator-approval-applied]`. The event is independent of elapsed
recovery deadlines. An unrelated label or removing a hold label cannot create
this event. The refusal still records its reasons and missing evidence. Awaited-label stops
are deterministic, including legacy activation requirements and typed-only
inputs; adding awaited inputs changes legacy refusal keys/generations and may
page again. Typed-only inputs default to an approval-specific next action.
Watcher and closer exclude the pipeline gate context from their check baseline.
The [retry ledger](hammer-retry-cap.md#operator-approval-re-arm-approvalrearm-01)
provides a separate, durable one-time allowance when retries were exhausted;
ordinary changed-input release continues to refund no executed attempt.

## Purpose

SAFETYSTOPOWNER-01 adds `refusal.repairable`: true for an explicit nonempty
audit `next` or the existing primary-change restoration repair. Synthetic
generic evidence requests remain non-repairable. The full refusal travels in
both closure snapshot projections. The unchanged hold still fences the hammer;
R05 closure recovery can spend one scoped PR-update attempt per head/refusal
key through the [existing recovery owner](ama-automated-recovery.md#budget-and-exhaustion).
Missing or exhausted repair ownership pages with that key instead of silently
skipping every wake. Legacy concrete `next` records remain eligible for repair.

After a hammer stops without merging, explicitly deterministic refusals wait
for an input change. Other stops become eligible for retry after a five-minute backoff,
subject to ordinary gates and existing per-head, series and lifetime caps. Holds
page once per head with the recorded predicate and recovery action. Daemon
failures do not create hammer holds. The producer and legacy compatibility
rules are defined in the [AMA audit contract](ama-audit.md).

## Files and shape

One atomically rewritten JSON object per `(repo, PR)` lives at
`<repo-slug>-pr-<number>.json`. The slug replaces every character outside
`A-Za-z0-9._-` with `-`, including `/`. Entries now carry `holdVersion: 1`; legacy entries remain readable.

| Field | Shape | Contract |
|---|---|---|
| `heads` | object keyed by head SHA | Cleared in full on an observed `currentHead` change. The writer defensively caps legacy or pre-seeded state at eight entries, newest `firstObservedAt` first. |
| `currentHead` | head SHA | GUARDREVERT-01 clears all prior head entries on an observed head change, including a force-push away and back. |
| `refusalGeneration` | integer | Monotonic generation for new holds; keeps process-local page debounce scoped to the current refusal. |
| `heads[sha].refusal` | optional object | `{ key, reasons, missingEvidence, next, awaitedInputs? }`; SHA-256 identity over repository, PR, head, sorted unique reasons and recursively key-sorted missing evidence, excluding legacy `migrationRenumberDiagnostics` and its migration-proof summary suffix. Optional proof read failures do not release a deterministic hold; current predicates expose those diagnostics beside `missingEvidence`. Repeated audit attempts with this same identity reuse the hold. |
| `heads[sha].refusalGeneration` | integer | Page generation for this hold. Persisted page receipts survive restart. A different refusal or a new stop after input release receives a new generation. |
| `heads[sha].stopKey` | string | Audit file head, attempt number (or array index), and attempt start/timestamp identify the latest observed stop. Legacy stops use this identity; structured deterministic refusals use `refusal.key` across attempts. |
| `heads[sha].predicate` | string | Recorded stop reason, normalized to one line and capped at 120 characters, or `reason-not-recorded`. |
| `heads[sha].mode` | optional `transient` or `companion` | Timed recovery instead of an input-change refusal. Deterministic entries retain their existing shape. |
| `heads[sha].reasons` | optional string array | Sorted transient stop predicates, retained for recovery audit. |
| `heads[sha].retryAfter` | optional ISO timestamp | Five minutes after first observation of a new transient stop; durable across restart. Upgrade release uses the upgrade observation time. |
| `heads[sha].firstObservedAt` | ISO timestamp | First closer observation of this stop. |
| `heads[sha].inputs` | object | Baseline `{ headSha, baseSha, mergeability, checks, review }`; comparable terminal audit head/base/mergeability readings take precedence, with first-observation or prior-release inputs filling unrecorded dimensions. SHA fields are strings or null; mergeability is `MERGEABLE`, `CONFLICTING`, or null. `checks` is a sorted, pipe-joined string of lowercase check identities and normalized latest states. `review` is the canonical closer review evidence fingerprint described below, never reconstructed from an eligibility trace. |
| `heads[sha].pagedAt` | ISO timestamp or null | Successful operator alert delivery. Carried forward for the same deterministic refusal, or subsequent legacy stops on the same head. |
| `heads[sha].releasedAt` | optional ISO timestamp | First release observation (changed inputs, timed backoff or upgrade). A released stop remains released across ticks and restarts. |
| `heads[sha].releasedBy` | optional string array | Release dimensions: `head`, `base`, `mergeability`, `checks`, `review`, `conflicting` (REMCONFLICT-01), `primary-change-evidence` (CAPROUTE-01), `hold-released` (HOLDRELEASE-01), `github-gate-cleared` (HAMUNKNOWN-02), `infrastructure-stop` (STOPHOLDINFRA-01), `ci-infrastructure-recovered` (CIBLOCKINFRA-01), `transient-stop-backoff`, `transient-stop-upgrade` (CLOSERSTOPTRANSIENT-01). |
| `heads[sha].releasedInputs` | optional inputs object | Inputs at release; used as the next stop's baseline if another hammer stops on this head. |

## Recovery and retention

CLOSERSTOPTRANSIENT-01 makes `DETERMINISTIC_STOP_REASONS` the allowlist:
all actionable reasons must be listed after packaging reasons are stripped.
Structured predicate reasons take precedence over generic outer wrappers such
as `predicate-not-eligible`; bare legacy stops use their recorded predicate.
The audited deterministic vocabulary is `primary-change-reverted`,
`primary-change-unknown`, `stale-review-head`, `verdict-not-eligible`,
`verdict-not-settled-success`, `protective-predecessor-malformed-trailer`,
`base-changed-file-overlap`, `blocking-findings-present`,
`blocking-findings-unknown`, `non-blocking-findings-present`,
`non-blocking-findings-unknown` and `review-currency-unproven`.
The five finding/review evidence reasons are added by this change.
`permanent-merge-rejection` (which includes auth and required-check errors),
`builder-token-merge-refused` and `protective-predecessor-open` are removed:
their causes can clear externally on the same head. CI, lane contention,
environment failures, unknown and mixed transient reasons are transient.
Legacy review-handoff and packaging exceptions below remain intact.

A transient hold returns `hammer-stop-transient-backoff` with `recoveryWait`
and a `retryAfter` deadline. Changed inputs and existing recovery probes can
release sooner; otherwise the next scheduled evaluation at or after the deadline
records `transient-stop-backoff` and releases. A new terminal stop starts a new
five-minute window on first observation, even when an unreleased transient hold
has the same predicate but a different `stopKey`. Only the same transient
`stopKey` reuses its deadline; repeat evaluation of an already released stop neither
re-arms its timer nor emits another release audit. Next-action projections carry
`deterministic: false`, preventing R07 from turning a transient stop into a
permanent automated stop. Ordinary launch/lease checks and retry/lifetime caps
remain authoritative; release refunds no executed attempt.

On upgrade, an unreleased entry without `retryAfter` whose recorded reasons
are all transient releases immediately with `transient-stop-upgrade`, clears
its old refusal and logs the predicate, reasons, stop key and release cause.
The persisted release prevents repeat upgrade grants across restarts. Cleanup
also retires orphaned transient-only state without audit history, returning
`none` so cleanup alone cannot widen admission. A different current stop gets
its own hold; deterministic holds remain unchanged. Ordinary timed and
input-change releases also log their stop reasons. Existing caps still bound
upgrade retry admission.

STOPHOLDINFRA-01 excludes dispatch packaging failures from deterministic
refusals and holds: `missing-dispatch-phase-scripts`,
`unrendered-dispatch-phase-scripts` and
`unrendered-dispatch-phase-script-placeholders`. These predicates describe
missing scratch scripts or unrendered dispatch paths, so fresh dispatch can
repair them without a PR input change. A new stop returns `none` without a
hold page. Only an unreleased persisted infrastructure hold releases, once, with
`releasedBy: ['infrastructure-stop']`, without another page, even if the audit
has since cleared. Without a current stop this cleanup returns `none`, so it
does not grant redispatch admission. Packaging failures leave unrelated
deterministic holds in force: audit selection looks past packaging stops and
deferrals to the earlier refusal, but never past success. If only packaging
audit history remains, an unreleased persisted deterministic refusal returns
`hold` without a state write or another page when inputs are unchanged, including
before ownerless recovery. Changed base, mergeability, checks or review inputs
release that refusal with `releasedAt`, `releasedBy` and `releasedInputs`.
Both synthetic hold and release results explicitly carry `hammerStop.deterministic: true`.
Closer preflight evaluates cleanup even when audit history is absent. Unknown
or transient predicates prevent classification as a pure infrastructure stop.
Mixed reasons strip packaging reasons from the computed deterministic refusal;
legacy mixed holds are not released as infrastructure. Already-released
infrastructure holds return `none` without rewriting state, whether the
packaging audit remains or has cleared. Release write failures are logged and
the in-memory decision still applies for that tick.
Release does not refund attempts; ordinary gates, leases,
the per-PR retry cap and lifetime ceiling still apply.

HAMUNKNOWN-02 re-evaluates `github-gate-not-green` and
`pr-mergeability-unknown` stops against each closer pass's fresh PR metadata.
An open PR on the exact held head with MERGEABLE mergeability and successful
external checks releases with `github-gate-cleared`, even when the stored
baseline was already green and MERGEABLE. Canonical `state: OPEN` metadata
does not require a synthetic `isOpen` flag; an explicit closed state or false
`isOpen` flag prevents this gate recovery. The shared CI classifier checks
configured required contexts and excludes only the caller's own status contexts;
empty, unreadable, red or pending rollups cannot prove recovery. Raw UNKNOWN
beside CLEAN also cannot prove recovery. Structured reasons containing findings
or primary-change refusals are not released by this GitHub gate probe.
Release persists before routing and paging and does not refund hammer attempts;
normal eligibility, retry caps and the lifetime ceiling still apply.

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
create a decision without a current stop. A packaging stop retains a persisted
deterministic refusal as described above. Known current SHA or mergeability
readings can release an unknown baseline; missing current SHA readings and `UNKNOWN` mergeability
cannot prove change. Checks use the canonical latest-run and own-status
exclusion helpers: only matching `StatusContext` entries (or legacy entries
with `context` and no type) are excluded. A same-name external `CheckRun`
remains an input. Missing/non-array rollups are represented as an empty string.

CAPROUTE-01 includes legacy `primary-change-unknown` stops and
`primary-change-read-failed` stops. On every closer evaluation of an open PR
with one of these stops on the live head, a read-only primary-change probe runs
before ordinary eligibility, including on CYCLECAPHAM-01 / CIBLOCKHAM-01
hammer-owner routes and stale-review heads that are not closer-authored.
While the answer remains unknown or unreadable, a deterministic unknown hold remains active; a transient read-failure hold can also release at its backoff deadline. Once
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
deadline across restarts. Other predicates retain immediate paging, with timed recovery stated for transient stops. A terminal
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
applies for that tick. An observed `currentHead` change clears the entire `heads`
map, so returning to a previously observed SHA establishes a fresh hold and page
generation. The writer's eight-head cap is a defensive bound for legacy or
pre-seeded state, not historical retention across head changes. There is no TTL.

GUARDREVERT-01 adds a stable `review` fingerprint to `inputs`: reviewed head,
verdict, remediation state, finding classifications/identities and the resolved
review-body version. Changed review evidence releases with `review`, including
a same-head review edit whose verdict/counts did not change. Structured
deterministic refusals run before every closer route; unlike legacy opaque
stops, a new audit attempt alone does not release or re-page them. A new refusal
or a new terminal stop following changed inputs starts a fresh page generation.
The page includes full missing evidence and a single `next` action. A read-only
probe can release a primary-reversal refusal through `primary-change-evidence`
when its authority becomes verifiable or its missing-evidence tuple changes.
Unchanged or unreadable authority retains the hold.


HAMNOREREVIEW-01 supersedes STOPHOLDREVIEW-01. Historical
`exact-head-review-required` and bare `stale-review-head` stops release with
`hammer-responsibility`, independent of review timestamps or new verdicts.
A real co-occurring refusal, including primary-change preservation, keeps its
hold. Ordinary dispatch leases and retry caps decide whether another hammer
can run; this release grants no merge authority.

Comparable terminal audit readings (rebased base, live head and mergeability)
override observed baselines, including holds created before this fix.
Audit mergeability from `githubGate`
or the eligibility trace is trimmed and uppercased before classification, just
like live PR metadata, so casing alone cannot release a hold. Eligibility trace
verdicts and finding summaries use a different representation from the closer's
review fingerprint and never override it. Review fingerprints come only from
first observation or a prior release; an unchanged review retains the hold and
pages once. The posting receipt above handles reviews that arrive before first
observation only for review-required stops, not `ci-not-green`. Unrecorded
dimensions retain their observed baseline; aggregate CI conclusions and
failed-check subsets cannot reconstruct a full check rollup. Release changes
ownership only: findings still route to remediation, and ordinary eligibility,
strict remediation policy, leases and retry caps remain in force.
