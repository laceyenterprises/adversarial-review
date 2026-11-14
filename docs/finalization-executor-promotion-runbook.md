# Merge Authority v2 — Executor Promotion Runbook

**Owner:** Merge Authority v2 runtime owner; Main Loop 6 owns promotion/rollback.
**Applies to:** `src/finalization/`.
**Design:** [approved v1.0 contract](SPEC-merge-authority-v2.md) §4–6.

## Promotion evidence

The executor remains gated off by default. MLR-04 approved at least 50 distinct
shadowed finalizations, including organic head-move and exhaustion examples,
every divergence dispositioned and no unresolved fold/evidence error. MLR-07
owns the live report. The historical ARC-16 day count and `shadowed > 0` result
are insufficient. Retain MGQ's separate at least 20 canary entries, both admission
types and rollback rehearsal. Synthetic replay supplies code evidence only.

MLR-08/09 use the existing [whole-lane canary procedure](finalization-queue-canary-runbook.md)
and [expansion/rollback procedure](finalization-queue-expansion-runbook.md).
A flag and bounce alone do not transfer authority. Operators must prove prior
writer drain, reconcile ambiguous operations, obtain stable acknowledgements,
then transfer the exact repository/base through MGQ-08. Retain v1 for one release
cycle; deletion requires its separate approval. No worker performs these actions.

## Composition and read-only activation evidence

Before a canary, the runtime owner verifies the deployed source contains the
reviewed implementation and the loaded watcher/consumer started from that build.
Observe actual build, effective route, fresh custody appends and organic consumer
progress read-only. Source merge and submodule float alone are not loaded-code
or activation evidence. Privileged deploy/restart/config changes belong to SRE.

The subject executor requires an authoritative lifecycle/head reader and the
existing lane routing adapter. Constructing an enabled executor without a
callable `liveSurface.read` throws a `TypeError` before any tick. Disabled
construction remains valid without that reader for the inert rollback path.
Queue and subject merge paths consult the same
workflow recovery decision; any new custody fact invalidates evaluated currency.
Unavailable identity/attestation remains owned retryable evidence. A merge reply
never settles the subject. Readback records actual principal/revision, and a
matching PMA plan-run/activation receipt permits `finalized`. Manual landing
retains delivery ownership without inflating autonomous throughput.

Compose custody recovery with exact-holder probing, complete durable WIP patch
storage, acknowledged successor handoff and the existing teardown. The adapter
records salvage before teardown, rechecks terminal custody after handoff, and
requires completed branch release. Held/failed or ambiguous release stays owned.
Do not use age, signal silence or PID death as takeover permission.

Compose `createWorkflowPageSurface` with the existing alert outbox/route. It
reuses the existing infrastructure event family and stable subject/episode key;
queued, inflight or failed is not acknowledged delivery. Retries retain that key.
Compose `createPostMergeDeliverySurface` with existing PMA/DAG admission and run
observation. Missing composition remains visible owned recovery and blocks
finalization. No new transport, daemon, routing selector or pager is introduced.

## Execution brake, replay and status

V2 consumes live owner evidence from the same canonical next-action snapshot
as v1. A live hammer or remediator selects `wait` / `monitor-agent`, with an
explicit `live-owner` reason and the owner's deadline. Verdict/check patience
does not preempt that owner. Lease expiry or a canonical terminal/refused owner
restores the ordinary decision immediately; waiting never moves the revision's
patience anchor. Holds, the execution brake and settled lifecycle evidence
retain precedence.

Organic shadow pairs include `live.ownerState` (liveness, actor, head, deadline,
canonical reason, decision key and evidence references). A live-owner decision
also includes `v2Decision.liveOwner`. Inspect these fields to distinguish owner
waits from verdict waits. This is observation evidence, with no disposition or
override change. Executor live-reader compositions can supply the same snapshot
as `ownerSnapshot`; it must match the subject, current head and tick time.
If a leased ledger read or execution fails, the deferred `refresh-evidence`
outcome retains that snapshot when recomputing its diagnostic decision, so a
known live owner remains a `wait` with `liveOwner` evidence.

For a completed remediator's independently recorded final push, v2 requests an
exact-head review when the job's round budget is spent, automatic re-review was
suppressed, and the head has no verdict. Hammer handoff workers, unproven pushes,
other heads and heads with verdicts retain their existing paths. Shadow reads
the local publication proof and stores `wait` / `request-reexact-review` with its
source reference; it never queues a review.

Compose the live subject executor with the app `rootDir` (which supplies
`createExactHeadReviewSurface`) or inject that surface as `reviewSurface`.
Its `inspect` reads the same completed-job proof used by shadow. Before issuing,
the leased executor refreshes authoritative lifecycle/head, verdict and owner
evidence and checks the ledger generation. The authoritative refresh includes
the decided revision and clips its read budget to the remaining workflow episode
time, with the shared one-millisecond minimum for recovery after expiry.
The surface rechecks publication proof and atomically preserves any newly
posted verdict at that head before
calling `requestReviewRereview` with a head-bound explicit receipt,
preserved budgets and the existing exact-head recovery reason. It neither
bumps nor refunds rounds. Unavailable composition stays owned and deferred.

The stable request ID is `final-remediator-review:<head>` within repo/PR
identity. Existing explicit-intent transactions coalesce requests from other
paths and retain replay receipts across restart and lost acknowledgements.
After acceptance the workflow selects `monitor-review`; an exact-head verdict
resumes normal eligibility. The existing watcher cancels pending intents on
head change or PR termination before admission. Shadow writes never reserve a
live request, so shadow-to-live transfer cannot spend the request prematurely.

The existing autonomous execution brake intercepts dispatch, conflict/custody
mutation, landing, close and PMA mutation. Observation/status continues. Explicit
operator holds require authenticated release; head/code changes do not waive them.
Automated escalation is a recoverable episode with one owner and deadline.
Acknowledged pages deduplicate; failed delivery retries. Useful-work identities
remain spent across heads, owners, restarts and re-arm. Kills add no round.

Deadlines carry nominal/effective/ceiling values and load evidence, sized once
through the shared primitive. Runtime patience starts at admission, never request.
Polls and replay cannot slide deadlines. `projectWorkflow` exposes overdue age,
owner/action, freshness, evidence and code/policy generation. Expiry selects owned
recovery/page and never proves a branch free or authorizes merging findings.

Replay reconciles unknown effects before issuance. Live merged/closed PR state
settles PR execution before any successor claim. Landing and delivery receipts
remain separate across restart/rollback; retaining a merge receipt never repeats
a merge merely to recover a missing delivery receipt.

Compose `recoverySurface.reconcile` to supply sourced operation readback.
A thrown merge, remediation-dispatch or close call, or an unsuccessful merge
reply, does not prove absence of its remote effect. The issued intent remains
unresolved until authoritative lifecycle or recovery evidence arrives; local
error handling must not manufacture an `absent` or `failed` receipt. Missing
recovery composition reports `recovery-capability-unavailable` and retains the
owner and deadline rather than retrying an uncertain mutation.

## Queue owner storage observation (MGQ-01; no activation)

The repository/base owner foundation ships unconnected to either live writer.
Its additive migration and schema are documented in
[data-model/finalization-ledger.md](data-model/finalization-ledger.md#repositorybase-queue-mgq-01).
A subject lease alone is insufficient for lane serialization.

After normal reviewed deployment, the named operator uses the documented system
service owner and deployment/restart procedure in `DEPLOYMENT.md`. This slice
needs no service restart or route change: no owner loop has been wired yet. If
later composition changes a running watcher, the operator must drain it, use the
registered system-domain restart entry and prove the running build before routing.
Workers must not bounce services or create traffic to exercise ownership.

From the deployed checkout, under its runtime account, run this read-only probe
with the existing load-aware command supervisor (1-second nominal DB wait,
5-second finite DB ceiling; outer supervisor bounded to 30 seconds):

```sh
node src/finalization/queue-probe.mjs --capability owner --json
```

The owner observation requires explicit `--capability owner`; missing or unsupported
capabilities exit 2 without emitting observations.

Record `.capabilities.owner.available == true` and `.runtime.build != null`.
Availability is computed from exact deployed definitions of every table/index
named by the MGQ-01 baseline migration, DB readability/ownership and the resolved
local lock adapter. Later additive tables and indexes do not invalidate that
baseline; missing or changed baseline objects remain incompatible. The build is a digest
of the actual loaded queue module/schema bytes, not a release constant. Record
it with the deployment revision. It identifies the probe process; it does not
prove that an already-running watcher loaded those bytes.

`observations.lanes` shows persisted claims/generations/heartbeat/expiry/parking;
`unresolvedOperations` exposes ambiguous work. An empty lane list is valid
capability evidence with `organicOwnershipObserved=false`; organic execution
and watcher build/route evidence remain pending until later operator rollout.
The probe cannot create schema, claim/release a lane, write a lock file, call
GitHub, dispatch a worker or page. A missing/incompatible store or unresolved
owner adapter returns unavailable and exit 1 without manufacturing evidence.
This is an observation assertion, not a CI check or promotion gate.

Takeover must use the shared issuance lock and reconcile every unresolved
operation after proven stop/drain. Never delete a lock file or clear an intent
based on age/PID death. Unproven quiescence parks that lane for operator recovery;
other lanes remain independent. Retain events, intents, original deadlines and
receipts through recovery and eventual rollback. Production recovery adapters
and remote receipt verification are supplied by subsequent executor slices.

The operator must apply `migrations/20261023_finalization_queue.sql` through the
normal app-store migration procedure before expecting schema availability.
Deploying source alone may leave the probe unavailable; it never installs its
own schema. This additive migration creates no lane and changes no route.

Focused validation record (synthetic fixtures, no external services):

| Variant | Observed contention outcomes |
|---|---|
| Existing subject-only leases | 30/30 trials retained two subject holders on one repository/base. |
| First process-based lane implementation | 30/30 single persisted owner; 13/13 focused tests passed. |
| Recovery results and successor claim made atomic | 30/30 single owner; 67/68 tests passed, with one IPC assertion shape error corrected in the fixture. |
| Result currency and parked-event deduplication | 30/30 single owner; 76/76 focused and existing ledger/executor tests passed. |
| Final fixtures including concurrent readiness and probe CLI | 30/30 single owner; 79/79 tests passed across nine selected files. |

The final two process-based runs give 60 consecutive single-owner outcomes,
with DB outcome read-back on every trial and zero duplicates. Initial thread
fixtures produced no usable contention denominator: one hit its 150-second
bound and the next exposed the native lock addon's lack of Worker-thread
support. The fixtures now use independent foreground child processes and the
existing test runner, with a 120-second outer bound and command-local netguard.
No native addon or host installation was changed. Touched JavaScript lint and
`git diff --check` passed. The selected runner files are
`finalization-{lane-baseline,queue-owner,ledger-events,ledger-fold,ledger-store,executor-lease,executor,ledger-regression-fixtures,port}.test.mjs`.
Deployed runtime-owner probe results and organic ownership observations are
pending; local fixture availability is not deployment evidence.

## Durable handoff observation (MGQ-02; no activation)

Deploy source and apply `migrations/20261024_finalization_queue_handoff.sql`
after the MGQ-01 migration through the normal app-store migration procedure.
Opening the writable queue store also converges both additive migrations; the
read probe never migrates. This slice installs no lane route, evidence-reader
composition or owner loop and requires no service restart or config change.
Legacy closer execution remains acting.

Under the runtime account, from the deployed review-service checkout, use the
existing load-aware command supervisor with a 30-second finite outer bound:

```sh
node src/finalization/queue-probe.mjs --capability handoff --json
```

Record `.capabilities.handoff.available == true` and `.runtime.build != null`.
The probe checks deployed table definitions, ownership/readability and the
resolved durable receipt adapter, and hashes actual queue/handoff/boundary module
and migration bytes. DB read patience is 1 second nominal, scaled once with a
5-second finite ceiling and deadline clipping. It performs no network, signer,
dispatcher, pager, lane claim, lock-file write or migration. Its build identifies
the probe process; it does not establish an existing watcher's build or route.

`observations.handoff.acknowledgements` counts persisted validated receipts.
Zero is valid installed capability evidence with `organicHandoffObserved=false`;
live evidence-reader composition and organic receipts remain pending until later
operator routing/rollout. The capability explicitly reports composition required.
Missing/incompatible schema returns unavailable and exit 1; missing/unsupported
capability arguments exit 2. This observation is not a blocking check or promotion
gate. Never create lanes or synthetic submissions to manufacture evidence.

If later routing changes a running watcher, the operator must drain prior
writers, follow the registered system-domain restart entry and existing
promotion/rollback procedure, then record actual running build and route.
No worker restart, config flip, label, live comment or merge is authorized here.
Retain original handoffs/acks on rollback. Actual deployed runtime-owner probe
results and organic handoffs remain pending operator observation.

MGQ-02 synthetic validation record (no live services):

| Implementation stage | Observed result |
|---|---|
| Existing MGQ-01 storage-only acknowledgements | 20/20 admissions lacked a full validated handoff receipt; none established closer completion through the new boundary. |
| First handoff implementation | 38/47 focused tests passed; an INSERT placeholder-count error prevented receipt creation, including the first duplicate pair (0/1 successful pair). Corrected before publication. |
| Atomic receipt correction | 76/76 tests across four selected files; 20/20 duplicate-submitter process pairs produced one entry and identical ack. |
| Receipt consistency and deadline hardening | 81/81 tests; another 20/20 duplicate pairs succeeded. |
| Final source with signed reviewer binding | 82/82 tests; another 20/20 duplicate pairs succeeded, for 60 consecutive corrected outcomes with zero duplicate entries. Existing lane-owner trials also passed 30/30 in each corrected run. |

The independent-process fixture forces both submitters to observe receipt absence
before allowing either to commit. Each pair reads the resulting durable ack and
entry count back. A separate process exits after commit before sending a reply;
the parent reopens/replays its one ack. Existing queue-owner contention fixtures
remain selected, along with the unchanged legacy retry-helper and port tests.
Sibling boundaries inspected include low-level queue acknowledgement, mutation
issuance/replay, review currency and withdrawal preservation, and the legacy
retry helper. No legacy dispatch or ownership algorithm is changed.

## FIFO admission observation (MGQ-03; no activation)

Deploy source and apply `migrations/20261025_finalization_queue_admission.sql`
after the owner/handoff migrations through normal app-store migration. Writable
queue-store opening converges all three; the probe never migrates. There is no
route change, production activation or service restart required by this slice.

Under the deployed runtime owner in the deployed review-service checkout, run
through the existing load-aware command supervisor with a finite 30-second bound:

```sh
node src/finalization/queue-probe.mjs --capability admission --json
```

Record `.capabilities.admission.available == true`, `.runtime.build != null`,
the resolved adapter/schema, counts by clean/remediated/unvalidated source and
active/parked/terminal disposition, observed admissions and bounded receipt sample.
SQLite read patience remains 1 second nominal, scaled once and clipped to a
5-second ceiling. Schema comparison and receipt reads use the real deployed DB;
the probe validates at most 100 recent receipts. Expected receipt validation
failures and JSON syntax errors increment `invalidSampledReceipts` without
disabling admission availability; unexpected runtime or storage errors report
`admission-schema-or-adapter-unavailable`. Counts describe stored records,
not a whole-store provenance audit. The digest identifies probe code bytes,
not a running watcher's build or effective lane route. Missing organic observations
remain pending. Do not submit synthetic work, claim a lane or mutate state to
make this observation pass. Availability is not a blocking check or promotion gate.

Runtime reader composition and whole-lane routing belong to later slices.
For later promotion/rollback the operator drains prior writers and follows the
existing registered system-domain restart/verify procedure; record actual running
build, effective route and unresolved-operation reconciliation. Workers do not
restart services or change production config. Retain receipts and entry history
on rollback. Deployed probe and organic admission evidence remain pending.

Synthetic concurrency evidence: the unfixed store accepted 20/20 stale recovery
snapshots after a recover/hold phase cycle. The snapshot-CAS correction accepted
0/20 under the same reproduction. The first scoped suite passed 21/21, including
10 consecutive four-process mixed clean/remediated trials (one entry per admission)
and 20 consecutive late-recovery refusals across store reopen. Sibling sites
inspected: handoff acknowledgement, single-owner issuance, entry phase progress,
publication recovery and clean receipt replay. Original owner/handoff mechanisms
remain in place; the new live-read writer uses a fenced snapshot comparison.

Further intermediate validation passed 110/110 selected tests. A disposable
version of the snapshot-only implementation accepted 20/20 identical parked
observations after a same-timestamp phase cycle; the retained progress-version
correction rejected all 20/20 under the same reproduction. The final selected
suite passed 116/116, including the deployed CLI fixture, with 10 consecutive
mixed-source process trials and 20 consecutive asynchronous recovery refusals. Touched JavaScript lint, contract
typecheck and whitespace checks also passed. No live service was exercised.

## Mechanical rebase observation (MGQ-04; no activation)

Deploy through the existing review-service deployment path. This source change
adds no route, config key, service or migration. The three existing queue schema
migrations must already be present. Production promotion and any runtime-owner
system service restart remain operator work: identify the owner/domain and
restart entry through the existing `scripts/os-restart.sh` deployment procedure,
then verify the running watcher revision separately. Workers must not restart
services or manufacture queue activity.

From the deployed checkout as its runtime owner, use the existing load-aware
bounded supervisor to run:

```sh
node src/finalization/queue-probe.mjs --capability rebase --json
```

Require `.capabilities.rebase.available == true` and `.runtime.build != null`.
The probe opens the actual store read-only, checks the shipped queue schema and
receipt adapters, resolves the same default isolated Git/proof adapter as the
execution service, and reads the installed Git version with a nominal 1-second
wait capped at 5 seconds. It hashes the shipped runtime modules, including the
Git/proof code. This digest identifies the probe process bytes; record the actual
watcher build/route independently before promotion.

The bounded sample is ordered by publication observedAt, falling back to entry
updatedAt, with acknowledgement order used only to break ties.

Record prepared/published counts, the bounded recent observation sample, old
head, candidate, exact base and publication source references. The sample is at
most 100 entries and does not attest every historical proof. Empty publication
observations mean pending organic evidence. A missing store/schema/Git adapter
reports unavailable and performs no migration, claim, workspace creation,
fetch, push or lane mutation. Availability alone does not assert that the live
reader, per-operation credentials, recovery drain adapter or routing is composed.
The default adapter refuses network operations without an injected entitled
runner; it never borrows the runtime owner's ambient SSH credentials. The existing
execution brake remains a separate resolved finalization-policy input.

When organically available after a later authorized route promotion, observe a
disjoint-file publication with its original signed receipt, complete ordered
proof, leased old/new pair, source signatures, author notice delivery and durable
publication reference (Git-sourced on explicit push success, even during API
lag) and subsequent live observation. Same-file upstream edits remain
conservatively unprovable even when Git rebases without conflict. Recovery evidence must identify prior operation
stop/drain, authoritative remote head and unchanged candidate/base/deadline.
Never simulate crashes, holds or force-pushes against production for this probe.

For a parked permission entry, inspect the named author/operator notice intent
and actual repository/fork/rules rights. Revalidation/readmission belongs to the
existing admission service and rejoins the tail; a queue-published candidate is
re-proved against its immutable receipt before derived-head readmission, and a
retained candidate resumes through rebasing/publishing without recreation. Do not
edit the queue row. Explicit single-ref remote refusals settle not-applied; an
explicit drained push success settles without immediate API consistency.
Ambiguous operations require the existing explicit drain/reconciliation adapter;
lease expiry or an old-head read alone is insufficient. Keep isolated candidate
repositories until reconciliation and evidence retention permit operator cleanup.
Failed preparation removes its unreturned workspace; successful workspaces have
no automatic retention sweep. Crash orphans and duplicated full prior proofs/live
snapshots in progress events require retention/compaction follow-up before
production queue routing. The default synthetic committer is
`Queue Rebase <queue@example.invalid>`; it does not attest service identity.
Rollback retains receipts, proof, candidates and unresolved intents. No change to
the emergency execution brake or the existing smoke promises is part of this slice.

Source validation used only bounded offline fixtures and disposable stores/Git
repositories under the existing test runner and network guard. The seven selected
files passed 187/187 cases; after final isolation/source-signature hardening the
three touched suites passed 42/42, and the terminal-state refinement passed 25/25
executor cases. These runs cover 190 distinct cases across seven files. The
unsafe disposable force-push control overwrote author updates in 5/5 trials;
expected-old-head publication retained author updates in 10/10 consecutive
trials, and overlapping wakes issued one push in 5/5 consecutive trials. No
intermediate production concurrency implementation or production experiment was
used. Sibling owner/admission/handoff and original rebase-proof regressions stayed
green. Touched-file ESLint, contract typecheck, catalog and whitespace checks
passed. Deployed runtime-owner probe, actual watcher build, composed transports,
notice delivery and organic publication evidence remain pending operator work.


Recovery verifies every contiguous derivation from the admission head, including
prior workspaces, before accepting either the current candidate or its proven
expected old head. This includes a park after a second candidate was prepared
but before publication. A computed proof mismatch returns to the closer;
unavailable Git execution parks as infrastructure, and expired patience parks
before proof execution. Both already-published paths recheck live holds and
permissions before advancing to checks. Deterministic workspace, remote, runner
or deadline refusals before transport invocation settle `not-applied` with
`git:push-not-spawned`; failures after invocation still require authoritative
results or drain reconciliation. Ambient author/committer environment variables
and `EMAIL` are removed from local Git execution so replay retains the source
author and uses the synthetic committer.

### Checks and parking observation (MGQ-05; no activation)

After normal deployment, the runtime owner applies
`migrations/20261026_finalization_queue_checks.sql` through the existing app-store
migration procedure, after the three queue migrations. Writable queue-store
opening also converges these additive schemas; the read-only probe never does.
Use the existing documented runtime-owner/system-service deploy and restart
procedure when that operator authorizes deployment. This slice authorizes no
worker restart, route change, production fault injection or pager test.

From that deployed checkout, under its actual runtime owner and the existing
bounded load-aware supervisor (5 seconds nominal, 30 seconds maximum), run:

```sh
node src/finalization/queue-probe.mjs --capability checks --json
```

Require `capabilities.checks.available == true` and `runtime.build != null`.
Record the checkout/digest, resolved store adapter, schema, bounded exact-candidate
snapshots, original patience, parking causes, next reprobe and page enqueue
counts. The probe opens the real store read-only and verifies definitions against
the shipped migration in a disposable reference DB. Its digest identifies this
probe's code, not an already-running watcher's build. Empty snapshots/pages are
pending organic evidence, not a successful outage/recovery exercise. Missing
schema or adapters reports unavailable; never insert a lane to satisfy the probe.

The capability remains unwired. Future queue composition must supply the complete
existing required-policy reader, entitled per-operation credential environment,
live admission reader, Git derivation verifier, owner and existing Sentinel alert
bus. The check transport is GET-only; no check context is created or rerun. The
transport uses the shared GitHub request meter with its entitled credentials,
so pagination and credential retries remain subject to the existing read budget.
The required-set resolver never guesses from a green subset or unreadable protection.
An explicitly configured no-CI repository still needs its existing live proof.
Source fixture validation is not evidence that any of these production adapters
or routing is active.

During subsequent organic operation, inspect completed-red returns separately
from infrastructure parks. Verify that missing/hung/unreadable checks and auth
outages keep the original deadline, release the lane, enqueue one cause page and
consume no remediation budget. Observe recovery with a later ready entry ahead
of the recovered entry: proof/currency and fresh holds must pass before tail
readmission. After the original deadline, recovery grants only bounded
observations of a recovered published candidate, not fresh patience for CI or a
changed base. No merge is authorized by readmission or by this probe. Existing
smoke promises are unchanged; offline fixtures use fake GitHub/broker/pager and
disposable stores/Git repositories.

Offline concurrency measurements use ten consecutive overlapping reads against
one disposable published candidate. The deliberately unguarded waiter variant
(snapshot guard and store CAS removed) overwrote all 10 newer inconclusive
observations. The intermediate store-CAS-only variant rejected 10/10 late
responses; the complete snapshot-plus-store-CAS implementation also rejected
10/10, with zero overwritten observations. The production source was restored
after each experiment. Sibling admission and rebase services use the same
persisted snapshot/version discipline. Reprobe releases its temporary owner even
when recovery remains unavailable or rejoins behind a predecessor.

### Merge and receipt delivery observation (MGQ-06; no activation)

After normal deployment, the runtime owner applies
`migrations/20261027_finalization_queue_merge.sql` through the existing app-store
migration procedure, after the four earlier queue migrations. Writable
queue-store opening also converges it; the read-only probe never does. This
slice authorizes no worker restart, route change, merge, production fault
injection or pager test.

From the deployed checkout, under its actual runtime owner and the existing
bounded load-aware supervisor (5 seconds nominal, 30 seconds maximum), run:

```sh
node src/finalization/queue-probe.mjs --capability merge --json
```

Require `capabilities.merge.available == true` and `runtime.build != null`.
Record the checkout/digest, store adapter, schema, delivery kinds, receipt and
delivery counts, `pending`, `unresolvedMergeOperations`, recent receipts with the
attributed bot login and `recordedAt` (the authoritative `merge.mergedAt`),
and every pending delivery key with attempts and last
error. Zero receipts are pending organic evidence, not a merge exercise. A
non-zero `pending` after a lane advanced is the visible outbox backlog; retry it
through the composed service's `deliver()`, never by deleting rows. A non-zero
`unresolvedMergeOperations` means an ambiguous merge awaits drained owner
takeover; do not clear it by hand.

The capability remains unwired. Future composition must supply the live
admission reader (including `mergeCommitSha`, `mergedAt` and `mergedBy`), the
complete check reader, Git derivation verifier, a mandatory identity surface
that names the merging bot, the existing squash expected-head surface with
`recordReceipt: false` (the outbox owns accounting), the existing merge-action
and AMA audit delivery adapters with the deployment HQ root, the Sentinel page
adapter and an owner recovery adapter that proves drain before calling
`observeQueueMergeOperation`. The existing emergency brake stays independent and
intercepts both before the intent and under the issuance lock.

Offline concurrency measurements use a deterministic stale observer: observer B
passes the start checks and keeps serving a pre-merge live snapshot (a stale
read cache) while A merges, settles and pauses before recording. Three runs of
ten consecutive races each: the deliberately unguarded variant (decision
snapshot CAS, in-lock snapshot check and settled-merge guard removed) issued a
second merge in 30/30 races; the CAS-only variant and the settled-guard-only
variant each issued exactly one merge in 30/30; the complete implementation
issued exactly one merge in 30/30. A separate overlapping-finalize race is
already serialized by the MGQ-01 issuance lock and stayed 10/10 under every
variant. The production source was restored after each experiment.

### Queue shadow observation (MGQ-07; no activation)

After normal reviewed deployment, the runtime owner applies
`migrations/20261028_finalization_queue_shadow.sql` after the original
`20260718_finalization_shadow.sql` and existing queue migrations. Opening the
canonical writable shadow store also converges the additive unique index.
MGQ-08 owns live observation composition/routing. This slice exposes
`recordQueueShadow`, `shadowObserveQueue` and `resolveQueueShadowAdapter` through
the finalization port; it installs no daemon loop or route setting.

Composition supplies a read-only database to the resolved adapter, fresh
observed evidence or isolated synthetic replay, ledger events, the actual v1
action/provenance, observation time and consumer identity/build. The adapter
reads the entry, immutable admission receipt and lane events in one snapshot.
Only live evidence fields may be supplied over that durable read. The recorder
can append telemetry but has no execution/owner/pager ports. Its caller must
surface `persisted: false` through the existing escalation route. Do not call
queue execution, dispatch a closer or spend its budget to predict an outcome.

From the deployed checkout under its actual runtime owner, use the existing
load-aware command supervisor (5 seconds nominal, 30 seconds finite ceiling):

```sh
node src/finalization/queue-probe.mjs --capability shadow --json
```

Record `capabilities.shadow.available == true`, non-null `runtime.build`,
`shadow.mode == "observe"`, `shadow.noMutation`, counts and
`lastObservationUnknown`. Accept null `shadow.lastObservationAt` when
`shadow.organicEvidence == "pending"`; once organic observations exist, require
a non-null timestamp and record latest `shadow.consumer` identity/build.
The capability checks the real schema/indexes and resolves the read-only
receipt/lifecycle adapter. Missing organic observations remain pending; an
unknown latest pair needs triage even if a timestamp exists.
No synthetic traffic or lane mutation may manufacture acceptance evidence.
The last observation time is the latest unique persisted pair, not a heartbeat;
consumer metadata identifies the latest producer, not proof it is still running.
The probe digest identifies its loaded source bytes, not an existing watcher.

Use the existing `finalization shadow-report --days 7 --json` for differences,
operator dispositions and separate organic/synthetic metrics. Keep the existing
promotion criteria and explicit operator review. This probe is post-deployment
observation only, with no new check, blocking gate, smoke action or restart.
If later composition changes the watcher, the operator follows `DEPLOYMENT.md`
and the existing drain/system-service restart/loaded-build verification path;
workers do not perform that step.

## Whole-lane canary and reversible rehearsal (MGQ-09)

For queue lane rollout use the [canary procedure](finalization-queue-canary-runbook.md)
and its [observation data contract](data-model/finalization-queue-canary.md).
`node src/finalization/queue-probe.mjs --capability canary --json` is read-only;
it requires deployed schemas/adapters and sourced operator observations for
organic admissions, runtime readiness and isolated recovery results. Missing
organic evidence is pending. The existing shadow readiness criteria above remain
unchanged. Only the operator transfers ownership, applies a reviewed single-lane
selector, bounces/verifies registered system services and records approval.

## Migrated-lane closer retirement and expansion (MGQ-10)

The [expansion walkthrough](finalization-queue-expansion-runbook.md) documents
route-scoped remediation/publication/handoff/exit, enqueue-only daemon and
certified closer recovery, explicit trusted handoff/resource-release composition,
exclusive writer inventory and the bounded read-only `--capability cutover`
probe. Durable complete ack precedes mandatory idempotent closer/worker release;
only the queue waits CI/rebases/merges. Legacy and rollback retain existing paths
and incident fixtures for one release cycle. No lane is activated by this source
change. Missing composed adapters or organic release/receipt evidence is pending.
After prior canary approval, the named operator transfers one privately supplied
whole lane, changes one reviewed selector, bounces/verifies registered system
services, observes exact-head receipts and slot release before CI, rehearses
rollback/reactivation and records explicit approval. Worker publication and PR
merge do not complete operator approval. No new smoke/check or merge authority.

## Change notes

- [V2LIVEOWNER-01](changes/V2LIVEOWNER-01.md): v2 waits for a canonical live
  closer or remediator owner before remediation or patience escalation;
  shadow pairs retain the observed owner state.
