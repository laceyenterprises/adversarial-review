# Operational behaviors

LAC-2131: native Codex reviewer, discovery and direct remediation homes expose
OAuth through the CLI-supported file store and fail before provider requests
when the effective store is unavailable. Config isolation, broker refresh
ownership and retained remediation sessions remain intact; owned credentials
are cleaned on exit or terminal reconciliation. Offline tests include dummy
credentials against the deployed CLI and a supported file-store boundary.
See the [service-home contract](RUNBOOK-reviewer-workspace.md) and
[SEV2 RCA](postmortems/SEV2-LAC-2131-codex-service-home-auth-2026-10-30.md).
Source review/merge, parent pointer, deployment and organic remediation success
remain separate recovery proofs.

HUP-05N: reviewer, cli-direct discovery and local remediation CLI selection use
the installed `hq cli resolve --cli <name> --consumer review --json` protocol.
`HQ_BIN` selects the installed command. HUP-05 centrally owns explicit override,
managed-current and review legacy fallback precedence (`claude` is the registry
key for Claude Code). Unknown resolver outcomes prevent launch and receive one
load-aware retry. Exhausted resolution uses `cli-resolution-transient`: no seat
isolation or credential-outage accounting, PR-level backoff, and claim release
to `pending` below the five-consecutive-transient threshold before bounded
`pending-upstream` recovery. Invalid JSON diagnostics contain only byte/line
counts and a protocol-line presence flag. Each resolution
logs path, version and digest before execution. Codex auth, model catalog
and exec share the returned immutable path. See the
[resolver rollout contract](RUNBOOK-reviewer-workspace.md#managed-cli-resolution-hup-05n).
HUP-09 owns administrator deployment, service refresh/restart and the live
managed review consumer receipt with a real tool event; merge is source evidence.

LAC-2127: SQL-origin migration proofs can certify an ancestral filename/metadata
repair only after verifying every snapshot, monotonic declared revisions, exact
adjacent ancestry and base-identical predecessor operations. The immutable
PR9692 replay and negative boundaries remain offline. See the
[renumber contract](RUNBOOK-ama-closure.md#mechanical-migration-renumbers-migrenumberderived-01)
and [SEV3 RCA](postmortems/SEV3-LAC-2127-migration-metadata-repair-2026-10-29.md).
Lifecycle states and existing smoke promises are unchanged. Reviewed source
merge, normal deployment and organic queue recovery remain separate acceptance.

CLOSURELAGFALSE-01: closure-lag diagnostics record inline merges at the shared
merge boundary, preserve terminal entries against stale eligibility and backlog
observations, and check live PR state before an undelivered per-PR breach page.
Only newer OPEN evidence at a different known head re-arms a terminal entry.
SLOs, p95 accounting and existing smoke promises remain unchanged. See the
[closure-lag contract](data-model/ama-closure-lag.md). Offline fixtures
cover the transitions; deployed acceptance awaits read-only observation of
organic merges after normal deployment.

REMREPORTHUMAN-01: remediation reports reserve “Human intervention required”
for human-owned blockers and name CI, AMA closer or review pipeline owners for
informational waits. An explicit completed-remediation reply with only those
waits uses the existing audited closeout and completed transition; genuine
no-progress and refused-review stops retain their semantics. Synthetic
pr-comments and follow-up-remediation fixtures verify this behavior. Existing
smoke promises are unchanged; deployed observation awaits a natural round.

HOSTIDCACHE-01: host-owner reads cache success for the process lifetime and
retry transient failures within the caller budget. A transient closer read
defers to the next poll with its owner, lease and anchored deadline intact;
definitive refusals and merge gates remain enforced. See the
[host identity contract](RUNBOOK-ama-closure.md#host-identity-reads-hostidcache-01).
Offline fixtures prove source behavior; existing smoke promises are unchanged,
and natural runtime recovery awaits normal deployment. No restart is required.

HAMWORKPROGRESS-02: live R03 hammer custody also receives an operator inspection
handoff after thirty wall-clock minutes from the current dispatched lease's
acquisition or the current launch's durable request time, whichever is later,
independent of load-scaled execution budgets and renewed heartbeat
or decision timestamps. This is a progress-unverified notice, not a stalled or
terminal verdict: AR's ownership snapshot cannot certify active validation or
source writing. Execution remains owned; long validators, writers, WIP and
uncertain effects retain their lease and process custody. No cancel, signal,
lease release, successor dispatch or merge is authorized by this notice.
Complete current-head launch/retry evidence and matching acquisition/launch/holder
identity are required. Parked, suspended, unknown, non-merge and claimed retry
owners keep their existing path. The existing closure-wait store deduplicates one
notice per head/launch/acquisition across watcher restarts, retries failed delivery,
and reports await-operator without changing the shared execution decision.
Operators inspect outcome receipts and active work before using supported HQ
lifecycle controls. Source publication alone does not prove autonomous closure.

OWNERDEADLINE-01: every open PR needs one live owner with a next action and
an anchored deadline. Once that deadline is at least the existing ownerless
bound overdue, retained-route reasons and renewed review requests cannot prove
ownership. A current-head live process, live launch or fresh lease heartbeat
still fences recovery. The existing watchdog executes the selected successor
under its two-attempt cap, or pages once per head and missing transition with
its row, reason and deadline. Discovery checks local lane evidence before
admission or slow-lane deferral on every tick; checking the deadline adds no
GitHub calls. Legacy lane records select the shared refresh row from their
existing no-progress anchor. Recovery dispatch rechecks the live candidate.
Existing merge predicates, lease mutation rules and review admission remain
authoritative. Focused synthetic fixtures establish source behavior; existing
smoke promises are unchanged and natural deployed recovery remains unverified.
Discovery excludes enforced operator holds before lane reads. Any matching
dispatch-record SHA retains live ownership evidence. Scoped operator requests
keep their existing executor admission and safety/lease checks when overdue;
expired safety reconciliation still receives diagnostic paging.
Overdue review requests retain the once-per-head reservation and expose their
handoff receipt under the existing recovery attempt cap.

See the [deadline recovery contract](RUNBOOK-ama-closure.md#deadline-bound-ownership-ownerdeadline-01).

HOLDERPROOF-01: successful leased remediation, auth-recovery and finalization-queue
rewrites record compatible branch receipts in HQ dispatch storage, including
service workspaces without managed worker manifests. Receipt storage errors
preserve publication success and expose exact recovery tips; no push retry is
authorized by a missing receipt. See the [receipt contract](follow-up-runbook.md#successful-branch-rewrite-receipts-holderproof-01).
Existing lifecycle states, merge rules and smoke promises remain unchanged;
post-deploy verification observes natural receipts read-only.

HAMVALIDORPHAN-01: automatic review queues cannot orphan a hammer-validated
head. The watcher restores its last delivered review and evaluates ordinary
closure in the same poll. Shared rescue classification retains hammer ownership;
existing validation, leases, retry limits and escalation remain authoritative.
See the [recovery contract](RUNBOOK-ama-closure.md#hammer-head-without-a-live-closer-hamvalidorphan-01).
Offline regressions cover queued recovery and crashed-worker retry exhaustion;
read-only observation after normal deployment remains pending. Existing smoke
promises are unchanged.

LAC-2094: finite CLI result entrypoints allow pending stdout/stderr writes to
finish before exiting. Merge-lease `status`/`list` preserve the complete JSON
document and retained attempts on pipes, including slow consumers. See the
[output contract](RUNBOOK-ama-closure.md#cli-output-completion-lac-2094)
and [offline proof and sibling sweep](validation/cli-output-lifecycle.md).
This changes no persistent schema/model, lifecycle states/transitions or
declared smoke promises. Live recovery acceptance remains separate from source
publication. Run the focused regressions with:

```bash
node test/run-tests.mjs cli-output-lifecycle.test.mjs
```

### Recover a ledger/title builder mismatch (ROUTEPROV-01)

The watcher cross-checks the latest build completion for the PR and its LRQ before
selecting a reviewer. Builder identity survives head moves, including human
follow-up commits. Confirmed ledger provenance wins over the creation-time
title. It records `builder_class_mismatch` in `data/builder-routing/`; absent or
unconfigured provenance records `builder_class_inconclusive` and keeps title routing.
Failed ledger queries also record `builder_class_inconclusive`, but defer the PR's
claim before reviewer assignment or spawn so the next poll tick can retry.
Lookups use the configured session-ledger backend: SQLite is read through the
shared read-only adapter; Postgres URL DSNs use direct loopback port 5432. If that
rewrite is unavailable (including database-name-only and libpq keyword/value
targets), the adapter warns and uses the configured target. Each Postgres query
uses a read-only transaction and retries transient connection failures up to three
total attempts with 100/200ms backoff; permanent failures defer without retries.
The operator CLI retries transient `gh pr view` failures up to
three total attempts with bounded backoff before failing.

For an already-open mislabeled PR, preview from the deployed review-tool root:

```sh
node bin/reroute-builder-review.mjs --repo laceyenterprises/agent-os --pr 7418
```

After reviewing the confirmed mismatch, add `--apply --reason 'ROUTEPROV-01 recovery'`
to request an audited exact-head rereview. This preserves the title and all holds,
refuses terminal PRs and active reviewers, and does not increase remediation budget.
The normal watcher claim guards remain authoritative. Deploy and restart the
watcher before using recovery so it selects the reviewer from ledger provenance.

Follow-up workspace cleanup uses `retention.ephemeral.follow_up_workspaces_keep_hours`
(default 72), measured from the latest terminal timestamp. Pending and in-progress
ledger records protect a workspace even if an older terminal record remains.
Preserved `.resume-backup-<time>-<pid>` workspaces follow their owning job's retention.
The existing maintenance sweep moves eligible workspaces to trash for deletion.

Reviewer snapshot caches expire unused snapshots after seven days and evict least
recently used snapshots to keep each repo within 8 snapshots and 4 GiB of logical
file bytes. Registered environment knobs `ADVERSARIAL_REVIEWER_SNAPSHOT_MAX_COUNT`
and `ADVERSARIAL_REVIEWER_SNAPSHOT_MAX_GB` override these defaults (positive integers).
These settings do not extend the shared YAML schema. Current and live-PID-pinned
snapshots are protected; limits can temporarily be exceeded by active reviews or
one oversized current snapshot. Dead reviewer pins are ignored on the next cache
sweep. Cleanup runs when a reviewer prepares a snapshot for that repo.

### Oversized reviewer prompts

Reviewers size and try the raw diff first. On a typed size refusal, declared
generated paths and verified pure moves/splits can be replaced by a content-hashed
manifest before retrying; diffs below 64 KiB skip summarisation I/O. See
[large review diffs](review-large-diffs.md) for the base-pinned declaration
and detection rules. Posted reviews retain this manifest inside Summary, before
the canonical Verdict, and validate the complete payload before preservation.
Claude print-mode prompts travel on stdin, with explicit `--model`/`--effort`
flags. Before routing a full prompt, the reviewer checks both delivery and
context budgets. An oversized prompt stays with the selected cross-model
reviewer and is split into bounded chunks if no alternate route fits.
Every chunk must fit. File units that fit are reviewed intact; oversized files
are split by line, with elision only for lines that cannot fit alongside their
file and hunk headers. Elided additions produce synthetic blocking findings;
elided context and deletions produce non-blocking evidence notes. A hard ceiling or
chunk-cap failure after recovery records terminal `reviewer-chunk-budget-exceeded`
evidence and queues the existing `reviewer.oversized_agy_prompt` operator alert.
The size preflight throws `ReviewerPromptTooLargeError`. Initial size failures
(code 76) are retryable through the existing bounded infrastructure path.
After summarisation and chunking are exhausted, `reviewer.mjs` exits with
code 77 and preserves the refusal reason for the operator. Quoting
`[reviewer-prompt-too-large]` in model output or stderr does not select this
class. Transient chunk failures retain their normal retry classification and
do not send the terminal size alert. Chunked reviews sum available provider
usage (marked partial when some chunks omit usage), and rejected Codex chunks
use the same forensic writer as single-shot reviews.

Reviewer claims and process deadlines share `reviewer.ceiling_max_seconds`
(default 10800 seconds, three hours; environment alias
`AGENT_OS_REVIEWER_CEILING_MAX_SECONDS`). This absolute envelope applies after
load scaling and after composing chunk, fallback and posting budgets. Larger
explicit requests cannot bypass it. Persisted older claims are bounded from
their original start when selected and reconciled. When GitHub PR state is
unavailable, reattach preserves a valid persisted lease within that ceiling,
using the recorded or nominal timeout only when no valid expiry was persisted.
Model progress watchdogs
retain their first-output and rolling output/event evidence; their load-scaled
patience cannot exceed `reviewer.no_progress_timeout_ms` (default 15 minutes)
or the absolute envelope. With stdout-only progress enabled, diagnostic stderr
neither satisfies first-output detection nor resets rolling model progress,
including file-backed capture; OAuth fallback and proxy idle timers obey the
same bounds. Stdout-only evidence is selected for Claude/Codex and agy
stream-json. Native Gemini JSON and agy plain-print accept stderr progress
because their answer arrives on stdout at completion. Streamed model generation
reserves five minutes inside the absolute wrapper/claim ceiling for posting.
The proxy and OAuth transport accept an optional `env` record,
forwarded by their harness callers, for both default sizing and final clamping;
omitting it uses `process.env`. The agent-runtime adapter resolves the absolute
ceiling from `domainConfig.env` when supplied, otherwise `process.env`.
Lease creation/extension/read helpers and reattach also accept optional `env`
records and default to `process.env`.
Stalls use the existing session-fenced retry release, while typed
`github-budget-deferred` receipts retain their reset hold and budget-neutral
claim release. Reattach still verifies identity, exit and late posted reviews
before releasing an overdue live orphan.

GEMTIMEOUT-01: a Gemini claim starts with one load-scaled call budget plus
five minutes for preparation and posting (25 minutes at idle defaults). Once
its chunk plan exists, local IPC extends the parent's process timer and the
matching session's persisted timeout and lease to that plan plus process slack.
The load multiplier applies only to each requested call budget; neither composed deadlines
nor the aggregate cap are scaled again. LAC-2100 bounds each chunk to the smaller
of that requested budget and `floor((cap - 120000 - 300000) / chunks)` ms,
reserving two minutes of chunk slack and five minutes of process slack. Shares
are static; a fast chunk does not increase a later chunk's allocation. The
three-hour default replaces the former six-hour chunk cap: the observed six-chunk
fixture receives 1,730,000 ms per chunk instead of 3,530,000 ms.
`ADVERSARIAL_REVIEW_AGY_CHUNK_TIMEOUT_CAP_MS` can only lower the absolute envelope.
Raising `reviewer.ceiling_max_seconds` also raises the streamed sizing formula's
maximum, so it affects both families. Explicit
call allocations also clamp agy's print timeout to the smaller of its configured
value and the allocation minus 30 seconds, with a one-second CLI floor. Below
31 seconds the call abort timer remains authoritative. Preparation and retries
consume the call budget too. Plans retain `requestedPerChunkTimeoutMs`, unconstrained `requiredMs`, prompt bytes
and the allocated deadline in diagnostics. An envelope unable to fit even one
millisecond per chunk plus both slacks still refuses with exit 77 and a sized
`minimumCapMs`; source/prompt sizing must be corrected within existing limits.
Both process deadlines are bounded by the
smaller of the unscaled chunk cap and shared absolute reviewer ceiling
(three hours by default), and Node's timer limit. Deadlines stay
anchored to process start: preparation consumes the same five-minute reserve
as posting, so four minutes of preparation leaves about one minute for posting
when chunks exhaust the plan. Stale or terminal claims cannot be extended.
Offline regressions cover single/multiple chunks, maximum load, timer expiry,
lease fencing and orphan recovery:
`node test/run-tests.mjs reviewer-timeout.test.mjs reviewer-chunk-timeout.test.mjs reviewer-process-deadline.test.mjs process-group-spawn.test.mjs watcher-reviewer-pool.test.mjs`.
After deployment, naturally scheduled Gemini reviews should record a single-call
lease initially and a larger lease only when they build a larger chunk plan.
Detached reservations use persisted plan budgets only for Gemini, resolving both
candidate (`repoPath`/`prNumber`) and persisted (`repo`/`pr`) identities. Codex
and Claude reservations retain their streamed process ceiling even when an active
claim records the legacy 20-minute database timeout.

Environment overrides follow the existing `ADVERSARIAL_REVIEW_AGY_ARGV_MAX_BYTES`
mechanism (no shared configuration-schema keys):

- `ADVERSARIAL_REVIEW_<CLAUDE|CODEX|GEMINI>_CONTEXT_TOKENS`: prompt context
  allocation, default 150000 tokens, with 64 KiB reserved for runtime instructions.
- `ADVERSARIAL_REVIEW_BYTES_PER_TOKEN`: conservative code estimate, default 2.
- `ADVERSARIAL_REVIEW_<CLAUDE|CODEX|GEMINI>_DELIVERY_MAX_BYTES`: off-argv
  delivery limit, default 16 MiB. Antigravity keeps its existing argv budget.
- `ADVERSARIAL_REVIEW_LONG_LINE_MAX_BYTES`: minimum line size eligible for
  elision, default 32 KiB (minimum configurable value 1024 bytes), capped at
  one quarter of the chunk budget. A line that fits is always reviewed in full,
  regardless of this threshold. Markers retain up to 1024 bytes at each end,
  original byte length, and SHA-256. Review bodies block only on elided additions;
  head-keyed metadata, including diff-line kind, is saved under `data/review-elisions/`.
- `ADVERSARIAL_REVIEW_CHUNK_HARD_MAX_BYTES`: diff plus extra-context ceiling,
  default 8 MiB, measured after generated/move summarisation and before line elision.
  This bounds preprocessing work even for a single generated line; content
  above it remains a terminal size refusal with a `shrink-diff` PR-update owner.
  `ADVERSARIAL_REVIEW_AGY_CHUNK_MAX_CHUNKS` bounds all chunked reviews (default 20).

Set context allocations to the deployed model's supported input budget after
reserving space for tools and output. Every `hosted-reviewer-selection` event
logs the checked model, full prompt bytes, and resolved budget, including
prompts that fit. A new PR head or operator retrigger is
required after a terminal size failure; lease recovery does not retry it.
SIZEOWNER-02 records a `shrink-diff` next action once per failed head in
`data/review-size-actions/` and dispatches a PR update through `hq dispatch --pr`
using the builder class from the title prefix. Its brief preserves behaviour,
requests compression/removal of generated diff content with any deferred work
left to an operator, and requires a normal push without force-pushing. The existing oversized alert now
includes the size facts, next action and dispatch receipt (or unconfirmed error).
File sizes are UTF-8 diff contributions, including headers, for the ten largest
changed files. A new head follows ordinary review admission. The terminal
failure CAS fences the dispatched head and session; stale settlement cannot
fail a replacement claim. Reservations survive ambiguous dispatch results and
prevent a second worker for that head. Across all heads, two durable reservations
per PR is the lifetime ceiling, including legacy and unconfirmed submissions;
ceiling exhaustion records `shrink-diff-ceiling-exhausted` and still alerts.
The transport retries transient errors at most three times under the same
idempotency key and one-minute budget; definite refusals return immediately.
Exhausted/unconfirmed reservations require operator reconciliation, not automatic
later-pass resubmission. Size diagnostics print last and bound each path to 128
characters; the HQ adapter reads the dispatch stderr through the public file seam
and carries head-bound facts in its result. Briefs mark paths as untrusted data.
Reviewer reservation/admission capacity is released after terminal settlement,
before awaiting the handoff; the per-head dispatch lease remains held. The
pool-disabled poll still awaits this bounded handoff. Same-head claim mismatches
log the still-current row without mutating a replacement claim; direct reviewer
invocations retain their own alert. Existing lifecycle states and smoke promises
are unchanged. After normal deployment, observe organic size failures read-only
for a capped handoff, receipt and enriched alert; no synthetic live dispatch is
authorized. See
[the size-action record contract](data-model/review-size-actions.md).
Exhausted non-infrastructure failures create a durable, head-keyed decision in
`data/review-failure-decisions/`. This is an informational failure record; it
does not consume choices or change the gate. Use the existing retrigger,
operator risk approval, or hold/closure controls to act on the failure. The
operator-decision alert outbox carries the record and deduplicates by its ID
and blocker-series ID. Clearing the no-progress lane starts a fresh series
and allows another page on the same head; the current failure reason is
refreshed in the record. The green fail-open gate displays the record ID;
this record does not authorize automatic merge. Record and elision-evidence
writes are best-effort and cannot suppress a page or fail a completed review.
A new head still re-arms review through the existing REVIEWSTALL-01 policy.


## Producer-owned evidence readers

PRM-06 centralizes quota, broker, launch-status, dispatch and publication envelope
interpretation against pinned producer types and captured examples. Account
holds and reviewer-route logs identify the producer and exact unavailable field;
AMA audits retain the same diagnostics in `harnessResolution.diagnostics`.
Account order, thresholds and retry authority stay unchanged. Both routers use
SDK normalization through an explicit weekly-only admission policy. Unusable
weekly evidence holds current floors even when the SDK can measure a short
window. Floors without `weeklyMeasurementReason` retain their legacy fallback.
The [reader contract](producer-contract-readers.md#weekly-evidence-and-admission-policy)
records the evidence/admission truth table and public export fixture refresh.

## Search configuration mirror (SPE-01)

`services.hcp.search` is inert metadata in this reader, with every provider
disabled and local budgets unset by default. Search policy is strict in both
`loadConfig` and `loadConfigRuntime`, including local overrides. Deploy the
updated Node reader before publishing new search keys in shared configuration.
Provider `operation_limits` maps replace whole prior-layer declarations; `{}`
clears inherited limits. See the [search configuration runbook](RUNBOOK-search-config.md)
for rollout order, provenance and the companion superproject contract obligation.
No persistent store, lifecycle state or declared smoke promise changes here.

## Exact absence recovery (LAC-2120)

The [recovery contract](dispatch-absence-recovery.md) permits empty key or
ticket evidence only with an exact, expiring operator entitlement and matching
canonical producer proof. Ordinary filtered/partial/unreadable reads stay held.
Existing states, locking, receipt adoption and retry accounting are unchanged.
Focused SDK/intent tests and the producer's authenticated packaged-SDK/native
settlement composition verify this on demand. Existing smoke promises remain
unchanged; deployment/loaded generations and organic recovery need independent
operator evidence. No live activation, grants or settlement are part of this PR.


## Review receipts through the public OS boundary

Review completion, execution-verdict, DAG liveness and hardening-context reads
now use the pinned app SDK 0.10.0. The compatibility adapter exports keep their
existing policy-facing names, and no longer resolve ledger paths, credentials
or SQL transports. Review-owned SQLite databases remain application state.

Completion reads accept repo/PR/head/signal selectors and collect every bounded
page. Launch-scoped public reads retain all companion receipts. Partial or failed
reads cannot establish absence or delivery. Authoritative live merged/closed
state, exact-head review, and all required companion deliveries remain separate
requirements. Capture-read scope denial or unavailability enters the existing
missing-capture reconciliation path, with `merge-capture-read-scope-denied` or
`merge-capture-read-unavailable` diagnostics; it does not stop closer admission
or hammer startup. Independent evidence-dependent work retains its own holds.

The operator-provisioned app entitlement keeps existing `dispatch_reads` grants.
DAG liveness uses the producer's operator-provisioned `dag_reads` entitlement;
hardening context needs `hardening_reads: true`. These are producer-owned grants,
not caller configuration or registration claims. The existing worker-observation
rollout switch also covers these review observations. No shared config changes.

Live-pack checks map allowed, not-live, scope-denied and unavailable reads
explicitly. A not-live answer proceeds. A denied or unavailable answer holds only
the PR touching that plan, with the plan ID and read outcome in its finding.
Unknown outcomes remain unavailable; unrelated PRs do not read a plan or inherit
a global refusal. Existing own-pack, gate-stamp and operator-waiver rules apply.

The closer and rendered hammer use SDK `recordMergeSignal` through
`hq build-completions record-merge`. A remote merge followed by capture failure
retains its accepted remote outcome for reconciliation; empty/skipped capture
is an error. Hammer capture forwards its inherited launch ID (`HQ_LAUNCH_REQUEST_ID`,
then `AGENT_OS_WORKER_LRQ_ID` or `LAUNCH_REQUEST_ID`), `HQ_TICKET_REF`, and
`WORKER_CLASS` (default `hammer`) as SDK provenance. It honors `HQ_BIN` and
passes the environment, including `HQ_WORKER_RUN_ID`, to the owner command.
Repository-level producer-evidence reads with no PR selector retain an undefined
PR number in empty results. Advisory remediator routing uses SDK `readRemediatorProposal`
through `hq osg remediator-proposal`. Neither command grants merge authority.
The reconciliation and accounting-backfill CLIs reject obsolete ledger-source
flags. No SQL, OS-file or internal-module fallback is available on failure.

After both coordinated changes are reviewed and deployed, the runtime owner must
hydrate the pinned SDK, provision the narrow grants, and activate the producer
before the watcher/follow-up services and reused hammer clients. Confirm actual
loaded builds and an organic bounded lookup; do not infer activation from merge.
Existing lifecycle states and smoke promises remain unchanged. The added
producer/backend and SDK tests run on demand, with synthetic external boundaries.

## Opener identity read retries (IDENTITYREAD503-01)

IDENTITYREAD503-01: the daemon's opener provenance read retries transient
dispatch failures within a single load-aware 8-second nominal budget per
selector (three attempts, 100/200ms backoff). Exhausted reads retain
`identity-read-transient` in the worker-identity decline so ordinary snapshot
refresh can retry the same head. Empty or ambiguous provenance, disabled reads
and scope denial remain fail-closed. Focused synthetic fixtures in
`test/daemon-worker-identity-ledger-target.test.mjs` and
`test/daemon-next-action.test.mjs` cover 503 recovery, persistent failure,
timeout budgets and unchanged absence/ambiguity refusal. Existing lifecycle
states and smoke promises remain unchanged. After normal deployment, the
runtime owner can observe natural same-head recovery read-only; no live worker
verification or config flip is part of this change. See the closure runbook's
worker-identity section for the retry contract.

## No-progress lane resets (NOPROGRESSRESET-01)

The posted-review lane fingerprints closure next-action row/action/reason and
returned/current-head stored daemon declines. A changed stored decline is checked
before skipping a tick; decision resets retain the existing per-head cap. On
startup a new watcher code identity or effective config generation resets stale
backoff to active, preserving prior counters for telemetry. The same build,
config and cause preserve the existing backoff constants and cadence. See the
[lane data contract](data-model/watcher-no-progress-lane.md).
Incomplete walks absorb changed stored declines without clearing scheduling debt;
resource-limited walks update only that decision evidence. Startup identity and
reset I/O failures warn and preserve old backoff so the watcher can boot.
Generation resets preserve operator alert debounce. The bounded post-deploy
baseline-plus-cap burst is documented in the closure runbook's scheduling notes.

Focused offline `test/watcher-poll-starvation.test.mjs` fixtures verify cause,
build/config and legacy resets, incomplete-walk admission, reset I/O failures,
alert debounce, lazy identity and symlink hashing, plus unchanged backoff.
After normal deployment,
the runtime owner observes organic generation stamps and subsequent lane walks.
Existing smoke promises remain; no forced restart or live state change is part
of this validation, and no new smoke step, config key or CI check is added.

### Conflict-owner review routing (REBASECURRENCY-01)

REBASECURRENCY-01: conflict-owner-review-route reads reviews.db in a read-only transaction without schema migration, retaining better-sqlite3 defaults of deferred BEGIN and a 5000ms busy timeout. Repository and commit SHA comparisons ignore case; the result preserves the requested head spelling. A current-head reviewing row (or missing reviewer head while reviewing) defers; any delivered review verdict or legacy posted row selects the existing AMA watcher route. A PR without delivered review retains PR-update. Missing DB, schema or reader is unavailable evidence, never unreviewed. This is routing evidence only: the watcher owns dispatch selection, rate caps, hammer limits and leases. Authenticated hammer rebase provenance continues to preserve review currency; the proofs and merge safety core are unchanged. Offline synthetic fixtures certify routing and currency; no new smoke command or live verification action.

`node bin/conflict-owner-review-route.mjs --root-dir <review-service-root> --repo <owner/name> --pr <number> --head-sha <sha>` returns `review-in-flight`, `hammer`, or `pr-update`, bound to the requested head. Failure exits nonzero with the unavailable notice and underlying argument or database error on stderr, and emits no routing JSON. The caller requests `bin/watcher-wake.mjs` for the hammer route; this read API does not dispatch or write review state. Deploy this reader before its worker-pool caller.

### Findings-batch dispatch budget (FINDINGSPROVLEAK-01)

Findings preparation and publication each use the shared load-aware timeout with
900 seconds nominal and no shorter helper ceiling. Dispatch provisions before
returning its receipt; measured provisioning up to 496 seconds must survive the
caller's budget. Failed initial submissions increment the durable
`finding_batches.batch_attempts`; after three failures, submission stops and
terminal/absent keyed launch evidence releases the batch through the existing
per-finding requeue/exhaustion audit. Errored batches without a launch receipt
also become release candidates after the batch timeout (default 24 hours).
An empty keyed receipt for a recorded launch additionally requires its exact
ledger launch and retry descendants to be present and terminal.
Missing or unreadable exact-launch evidence holds custody. Overdue holds and
retryable dispatch failures report `needs-operator`.
An unresolved blocked decision also retains its batch beyond the timeout.
Before dispatching a publisher for prepared work blocked on publication, the
collector uses the supported decision supersession API to verify pushed retained
work and release its branch without an answer or continuation. It stores the
bound release receipt in the batch row and rechecks keyed launch custody.
A completed handoff may replace a spent pre-handoff intent once after its old
deadline and grace; the new intent preserves the old submission and retains
the ordinary single retry. It cannot renew its own spent retry. Existing
automated smoke commands are unchanged; after both components deploy, observe
the next natural handoff and publisher receipts read-only.
Each pass logs open findings and stuck batch reasons/counts/oldest ages.
The batch idempotency key, publication fence and settlement evidence remain
authoritative. Tests use synthetic dispatch receipts.

GATECAPBASE-01: merge-lease refusal budgets are scoped to the current PR head
and observed base. Base advances, server rebase conflicts, lane-busy and lease
contention are recorded as retryable; planned CI/local-validation yields also
refund provisional charges. A changed head/base starts a fresh budget. At the
cap, refreshed conflicting heads return to the hammer conflict procedure;
other admissible heads reach the existing durable closure page path. Closing
status names recovery as next actor, without requiring an operator reset.
Offline merge-lease, cap-recovery and rendered hammer fixtures certify these
transitions. After normal deployment, the runtime owner may observe organic
retry reasons and owner/page receipts read-only; no forced conflict, live page
test, config flip or new smoke command is required.


## Dead dispatch submitters (CLOSERDISPATCHDEAD-01)

Scoped project/repository selectors use the existing paired grant and require
canonical absence before retiring dead submissions. Asynchronous lease
abandonment reconciles the intent in the same pass. SIGTERM/SIGINT synchronously
mark background submissions `dispatch-interrupted` before exit; these retain
leases and artifacts until receipt adoption or conclusive no-launch proof.
Live owners and once-only launch/refund fences remain authoritative. See the
[recovery contract](dispatch-absence-recovery.md) for fields, deployment order and offline evidence.
Existing smoke promises remain; no live operation is part of validation.


### Public dispatch metadata and logical logs

The client uses the pinned 0.12.0 SDK to request producer-owned dispatch files
by authorized launch/run identity. Closer discovery, teardown identity, daemon
owner identity, controller activation provenance and runtime stdout consume
public projections. Partial publication, changed slot identity, unavailable
transport and truncated output retain custody; none enables a native-file
fallback or authorizes merge. Existing merged/closed handling and exact-head
review authority remain unchanged.

Workspace discovery requires the separately granted
`worker.workspaces.observe` capability; Git checkout discovery uses the existing
`hq repo list --json` inventory. Host diagnostic, registry, deploy and admission
observations require `host.observations.read`; audit requests also require
launch scope. Managed CI is verified by its owner for the exact repository and
commit, without a worker-directory scan. App policy still chooses models,
interprets diagnostics and owns cleanup and merge decisions.

App-owned review databases, reply artifacts, audit receipts and workspace
records keep their existing storage and retention rules, including historical
HQ namespaces. They are not OS-owned dispatch metadata. The app's roster cache
contains prior public observations and labels its cached source explicitly.

Activation requires the merged producer, installed SDK and complete narrow
grants before a reviewed client reload. For this coordinated SDK release, the
existing artifact provenance gate remains a hold until the producer merges.
Then copy the exact merged artifact, verify its digest and update the consumer
producer record with the authoritative merge commit, following the SDK
coordinated-release procedure. Do not substitute a candidate revision.


PR #1583 public-evidence remediation: ambiguous reused worker slots and incomplete
repository inventories retain custody. Unavailable deploy evidence leaves ordinary
reviewer failures charged; only positive freeze or explicitly unreadable producer
state pauses them. Managed-CI trusts the producer verifier plus exact repo/head
binding. Offline regressions cover these cases; smoke promises are unchanged.
Unknown original-worker and closer custody retains ownership, with durable
per-head escalation after the load-scaled closure-wait bound. Registered name-only
checkout inventory supports local recovery after URL identity and real-path
containment checks; incomplete worktree inventories still cannot authorize reaping.
Runtime owner acceptance must check producer inventory/grants before activation.
See [rollout limits](RUNBOOK-ama-closure.md#public-evidence-rollout-limits-pr-1583).


## Bounded OS observation export (DOG-15)

`src/review-observations.mjs` is the review-store owner's read-only export for
public OS clients. The CLI adapter accepts OS-supplied roots, exact repository
lists and selectors on stdin; apps call the authorized OS API, never this CLI
or database directly. It imports the existing read-only opener without a daemon
singleton, reconciliation, schema migration, provider call or GitHub request.

`passes` pages retain producer timestamps, statuses and failure metadata;
`reviews` pages join the highest completed pass ID and nullable closeout fields,
matching repository names without case sensitivity across the three tables.
A later failed/running pass cannot replace a completed review. Missing optional
columns produce NULL values; missing pass identity columns suppress the join.
Both are listed in `missing_fields`. A confirmed absent store is
`review_store`, distinct from an unreadable dependency. Pages are limited to
100, offsets to 10000, with exact repository filtering before pagination.
Only `passes` accepts `since` and `ended_since`; malformed or unsupported
selectors fail as `invalid review selector` before the store is opened.
A complete page conveys neither global absence nor mutation authority.

The export changes no durable state machine, merge eligibility, terminal-PR
rules or HCP-outage hold. Deploy the coordinated OS endpoint and consumer after
both PRs converge; the one-shot adapter loads the deployed owner code each read.
No daemon bounce or host activation was performed as validation. Offline
producer coverage: `node --test test/review-observations.test.mjs`.

PENDINGCLAIM-01: the watcher uses one failure-shape expression for classification
and bounded unknown, population, infrastructure and daemon-bounce retry claims.
Same-head lease-released `pending` failures remain retryable within their existing
budgets. Moved heads retain fresh-review attempt reset; exhausted unknown failures
still park. Released session evidence remains available for late-post
reconciliation. PENDINGCLAIM-02: a refused claim with unchanged status, session
and failure time logs `claim-shape-mismatch branch=<name> status=<status>` only
for snapshots targeted by the selected CAS. Plain pending permits moved heads;
token refresh fences the captured snapshot head. Claim-race logs preserve the
fixed `state). Skipping.` suffix, with `snapshot_status` before the explanation.
This adds no gate, state, transition or alert. The synthetic offline regression is
`test/watcher-pending-failure-claim.test.mjs`. Existing smoke promises remain;
post-deployment acceptance is read-only observation of natural retry progress,
with no restart or forced failure.
The infrastructure claim fences the exact classified failure message; JavaScript
alone decides recoverability. The invariant enumerates the classifier's exported
recovery classes in both shapes and refuses changed message snapshots.


CLAUDESTEERON-01: the packaged Python module schema recognizes
`worker_pool.dispatch.claude_batch_steer_enabled` as a strict boolean with a
false default. Shared tracked config may activate it; local overrides and the
`HQ_CLAUDE_BATCH_STEER` / canonical
`AGENT_OS_WORKER_POOL_DISPATCH_CLAUDE_BATCH_STEER_ENABLED` environment override
use the normal cascade. The Claude adapter owns launch eligibility, nested
sandbox exclusions and rollback; the review service only accepts the key.
Deploy this schema compatibility change before the companion Agent OS config
activation. No reviewer lifecycle, journal or smoke promise changes.

RESCUEHOSTID-01: watcher and rescue share app-contract dispatch-read context bootstrap with the existing review app credential and both read switches. Connection-scoped sync host/launch reads reuse that session; setup failure returns a named nonzero rescue result before dispatch work. Fresh-process synthetic endpoint and named-failure fixtures establish source behavior. Deploy the review-service companion before the Agent OS bridge, then SRE retains an authorized dispatch-closer rescue --apply receipt containing a closer LRQ. Existing lifecycle states and automated smoke promises are unchanged. This task authorizes no live rescue, dispatch, lease/config mutation or restart. See `post-merge-verify.json` and the rescue/closure runbook.

APPROVALREARM-01: a refusal's explicitly awaited operator approval re-arms a
capped closer once for the same head. Its durable retry-ledger receipt is
consumed by the next confirmed launch; another refusal remains capped.
Unrelated labels grant nothing, and merge gates still verify authorization.
Retry admission accepts unverified label presence. Awaited approvals upgrade
legacy transient stops to deterministic holds with a new paging generation;
confirmed charges consume grants under the ledger lock regardless of clock
precision, and a subsequent refusal emits one fresh cap alert.
Offline `operator-approval-rearm`, `ama-hammer-retry-cap`, `pr-next-action` and
`closer-next-action` fixtures cover the contract. After normal deployment,
SRE observes the next organic approval producing a closer launch with
`operator-approval-applied`, without a manual step. See the
[operator runbook](RUNBOOK-ama-closure.md#awaited-operator-approval-after-exhausted-retries-approvalrearm-01).

## Explicit re-review dispatch (RETRIGGERDEDUP-01)

An accepted `retrigger-review`, rescue `rereview`, or remediation request
records a durable exact-head intent. A priority request permits one fresh review
even when the head already has a completed review, subject to existing rereview
ceilings, reviewer claims and head leases. Worker completion receipts follow
ordinary deduplication and ceilings. Automatic closure handoffs and same-head
restorations settle those receipts under the matching row transaction; the
asynchronous cycle-cap route rechecks its row snapshot after ownership reads.
Implicit repeats remain deduplicated.
Intents survive restart and admission holds regardless of age. The load-scaled
waiting threshold, **900 seconds nominal**, produces one informational notice,
never an expiry. Ceiling, head-change and terminal-PR refusals receive a visible
explanation. A positively unstarted launch returns only its own consumed intent
under the session CAS without charging an attempt. A fresh review records an
observed live-pack waiver in its body. Queued/running requests dismiss strictly
superseded configured bot reviews after live verification. Successful checks
are memoized per request/head in a bounded process-local cache; unchanged live
probes and failed dismissal retries run at most once per five minutes. New
requests, changed discovery heads, eviction and restart permit fresh checks.

Deploy with the normal watcher restart. The disposable refusal smoke and
targeted watcher tests cover this lifecycle. SRE then retains the next organic
unchanged-head request's receipt surviving admission holds and eventually
dispatching, plus its `explicit re-review intent consumed` log or visible
head/terminal/ceiling refusal. No worker
live action is needed. See [the state machine](STATE-MACHINE.md) and
[store contract](data-model/explicit-review-intents.md).

### MES-01 strict configuration mirror

The generated CFG schema carries the Agent OS MES keys (ONS-07) and
`test/config-mes.test.mjs` exercises the shared synthetic key vectors. Defaults
are shadow mode, enforcement false per kind and kill switch false. The
`mes.tier_policy` string references the Agent OS module fragment; this reader
resolves configuration only and neither reads nor applies the policy. No review
or remediation resolver hook changes in MES-01. Deploy this companion before the
Agent OS config defaults; any service restart is an operator action. Existing
review lifecycle states and smoke promises are unchanged.

### Custody compression config parity

TRANSCRIPTCOMPRESS-01 mirrors core's optional
`retention.ephemeral.token_transcripts_compression_enabled` (boolean, default
true) and `token_transcripts_compress_after_days` (integer, default 7, minimum
1). This is schema parity only; the existing Agent OS maintenance owner performs
compression. Shared local overlays remain tolerant of unknown sibling keys.
Deploy this reader before activating these keys in core's checked-in config.

Hammer terminal merge evidence is documented in
[the closure runbook](RUNBOOK-ama-closure.md#hammer-terminal-outcome-evidence).
The ledger receipt distinguishes a proven merge by this run from remediation,
refusal, cancellation and unknown exits; process success alone proves no merge.

CLOSERGATES-01 conflict observations count each head once in the run ledger.
Non-final reports preserve repair work without terminal AMA state; final
reports exit 65 until three distinct heads permit `conflict-repair-exhausted`.
Definitive predicate-input refusals emit `terminal-stop`. Closure-resume SHA
evidence ignores case and stores lowercase heads. Offline
`test/closergates-01.test.mjs` covers these paths; existing lifecycle states,
merge predicates and smoke commands remain unchanged.
