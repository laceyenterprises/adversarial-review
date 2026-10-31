# Reviewer passes

**Source of truth:** `migrations/20260518_reviewer_passes.sql`, `migrations/20260810_reviewer_passes_posted_review_freshness_index.sql`, `src/review-state.mjs`, `src/review-state-statements.mjs`, `src/review-state-db.mjs`, `src/reviewer-route-selection.mjs`, `src/reviewer-pass-tokens.mjs`, `src/reviewer-harness.mjs`, `src/ama/closer-pass-attempt.mjs`, `src/reviewer-pass-reaper.mjs`, `src/reviewer-spawn-settle.mjs`, `src/pollonce-phases.mjs`, `src/daemon-bounce-posted-review.mjs`, `src/orphan-post-reconcile.mjs`, and `src/follow-up-jobs.mjs`

## Ownership

- Store: `data/reviews.db`
- Tables: `reviewer_passes`, `reviewer_rate_limit_snapshots`
- Schema: `migrations/20260518_reviewer_passes.sql` plus later additive migrations
- Writers: `src/reviewer-pass-tokens.mjs`, `src/reviewer-pass-reaper.mjs`, `src/reviewer-spawn-settle.mjs`, `src/pollonce-phases.mjs`, `src/daemon-bounce-posted-review.mjs`, `src/orphan-post-reconcile.mjs`, `src/follow-up-jobs.mjs`
- Repair CLI: `scripts/backfill-reviewer-passes.mjs`; `bin/reconcile-posted-orphans.mjs` links posted review artifacts for reconciled `failed-orphan` rows

`reviewer_passes` is the durable record of each first-pass, remediation, and
closer review attempt. Its primary identity is `(repo, pr_number,
attempt_number, pass_kind)`. `worker_run_id` links a dispatched reviewer to the
session-ledger `worker_runs.run_id` when that attribution is available.

First-pass and rereview body capture also projects blocking and non-blocking
findings into [review finding records](review-findings.md). These observations
retain source pass attribution and link stored replies, overlapping commits and
hammer evidence without changing pass or review lifecycle states.

For closer passes, a confirmed merge records `status='completed'`. An unmerged
worker success, including `unverified-terminal-success`, records `failed`;
cancelled or superseded work records `cancelled`. This keeps time-to-merge
rollups from counting an unproven merge. `metadata_json.workerClass` holds the
logical AMA dispatch class, even when `reviewer_class` names a fallback harness.

## Delivery head wait marker

The delivery row's `reviewer_head_sha` is written together with `posted` by
claim-bound successful settlement. A missing reviewed head or mismatched claim
releases to `pending` at the current `revision_ref`, preserving attempts and
retry budgets and logging the reason. A replacement session is never released
by an older review's settlement.

Posted-orphan recovery takes the reviewed head from the GitHub review's
`commit_id`, falling back to the stored reviewer head only when GitHub omits it.
An empty stored head can therefore be healed by a matching reviewer-bot post
after the attempt's start. Recovery refuses posts when both heads are empty or
when a non-empty stored head conflicts with the GitHub head. The settlement CAS
matches the inspected session and prior head with null-safe equality, writes the
recovered non-empty head with `posted`, and supplies that head to recovered
follow-up queueing when the pass lacks its own head. No schema change is needed.

Discovery repairs legacy open `posted` rows with an empty reviewed head only
when `revision_ref` matches the live head. The status CAS requeues once, writes
`rereview_requested_at` and `rereview_reason=system-missing-reviewed-head:<head>`,
and logs the repair without changing attempt history or retry budgets. There
is no schema migration or new status value. Normal posted rows remain intact.
An existing exact-head `system-orphan-head-review` request retains its reason
and timestamp, so repair does not discard an already-authorized review intent.

`reviewed_prs.head_wait_started_at` is nullable ISO 8601 text, added
idempotently by `ensureReviewStateSchema` to both fresh and existing stores.
Existing rows retain `NULL`; no discovery timestamps are backfilled or changed.
`requestReviewRereview` stamps this field when an already-pending row moves to
another `revision_ref`. Same-head automatic polls retain the marker. A normal
review-cycle reset clears it and uses `rereview_requested_at` for the new wait;
an explicit same-head operator retrigger likewise clears it and stamps the
operator request time.

Admission reads `head_wait_started_at`, then `rereview_requested_at`, then
`reviewed_at`. The marker does not classify a pass as a re-review. In particular,
an unreviewed moved head still uses the 480-second first-pass bound rather than
the 900-second re-review bound. `reviewed_at` remains the original discovery
anchor used by TTM and latency reports.

## Draft accounting

`reviewed_prs.is_draft` is an integer boolean, defaulting to zero, added
idempotently by schema convergence. Subject discovery refreshes known draft
state before review admission; a draft does not enter the actionable queue.
Both depth lanes use the full first-pass plus requested re-review queue, with
separate budgets. The historical first-pass pager count is unchanged.

## Claimed reviewer account

ITP-12 records `metadata_json.reviewerAccountReceipt` for declared Claude/Codex
pools at pass start and completion, including quota skips and error settlement.
The shape matches `subjectContext.reviewerAccountReceipt` in
`reviewer-run-records.md`; its identity is the canonical reviewer role, independent
of the provider account. This is additive JSON metadata; no session-ledger or
SQLite/Postgres schema is edited. Missing historical receipts remain unknown.

The delivery row in `reviewed_prs` has nullable `codex_broker_provider`.
Schema convergence adds it to existing databases without rewriting old rows.
After each successful claim, `UPDATE_REVIEW_ROUTING_SQL` records `codex` or
`codex-corp` for a Codex reviewer, and `NULL` for other reviewer models. The
update requires the winning `reviewer_session_uuid` and `reviewing` status;
dispatch stops if that session no longer owns the row. Failed attempts retain
the account, subsequent claims overwrite it, and review-cycle resets clear it.

Route selection and quota-hold bypass read this field from the failed delivery
row. A primary quota failure permits a corporate attempt; corporate failures
retain the usual local quota hold and execution-fallback threshold, independent
of a stale fleet quota snapshot. `NULL` or absent attribution is interpreted as
legacy primary-account evidence. This field is separate from the runtime
record's `subjectContext.codexBrokerProvider`, which identifies the launched
child's broker request.

## Token and quota capture

Schema convergence in `src/review-state.mjs` adds `token_input` and
`token_output` to older pass tables, along with `token_reasoning` and
`token_tool_context`, and adds nullable `reasoning_effort`. Hosted reviews
write the model and effort actually passed to the harness when the posted body
is captured; remediation passes write their resolved values at launch.
`metadata_json.reviewerExecution` preserves the hosted harness attribution.
Antigravity substitutes a runtime-configured display token for CLI slugs and
records `runtime-display-token`; the registry/seed allowlist does not attest
that substituted token.
REMODELFALLBACK-01 adds its `modelSource` (`env-pin`, `registry`, `committed-seed`, or
`runtime-display-token`) for Claude, Gemini and both native/OAuth-recovered Codex
execution. Historical metadata may omit this field. Failed resolution carries
`modelSource=unresolved` on the retryable infrastructure error and log; it does
not invent a model or successful execution record.

REVIEWPROV-01 makes `reviewerExecution.harness` the runtime that executed the
review rather than the model family: `claude-code`, `codex`, `antigravity` or
`gemini-cli`. Historical rows carry `claude`, `codex` or `gemini`. An
Antigravity Gemini pass now records the thinking level in its agy display-name
model token (`Gemini 3.8 Flash (High)` gives `high`) as `reasoning_effort` and
`reviewerExecution.effort`, with `effortSource=model-display-name`; a display
name without a parenthesised level, and every Gemini CLI pass, keeps a null
effort with `effortSource=none`. The reviewer pass ceiling reads this effort,
and only `xhigh` changes it.

EFFORTTUNE-02 records `reviewerExecution.effortSource` for Claude and both
native and OAuth-recovered Codex passes, not only Gemini, so outcomes can be
compared by the effort that actually ran. The value is the resolver's reasoning
source: `env` (explicit pin), `registry`, `committed-seed`, `host-config`, or
`none`. A Codex OAuth recovery with no resolved effort sends the codex
reviewer default (`medium`) and records `transport-default`. The packaged
`codex-reviewer` seed default is now `medium`; the Claude and Gemini reviewer
seeds are unchanged. A governed registry level or explicit pin still wins.
Historical metadata may omit `effortSource`; `reasoning_effort` is unchanged.

REMODELFALLBACK-02 also preserves `modelSource=unresolved` for non-retryable
configuration refusals naming `host.observations.read`, without a seed warning.
Only retryable infrastructure failures permit seed defaults. Valid explicit pins
remain allowlist-validated with `env-pin` provenance. Native Codex and OAuth
Responses recovery share the selected model and source. After deployment, the
build manager reads `metadata_json.reviewerExecution.modelSource` on an organic
review, expecting `registry` with the grant present and no explicit pin.

For Claude, its `replySelection` records `candidateCount`, the one-based
`selectedCandidate`, `selectedType` (`result` or `assistant`), `laterCandidates`
set aside, and `contractValid`. The newest individual output passing
`validateReviewerReply` wins; if none passes, the latest result reaches the
existing rejection and forensic-capture path. Turns are never concatenated.
The final result still supplies invocation usage when an earlier reply wins.
Completion can replace `reviewer_model` with the
non-empty model reported by the usage source. A cancelled pass with incomplete
rollout evidence keeps its available counts and records
`metadata_json.tokenUsageState = 'partial'`.
For stamped hosted reviews, completion retains the model passed to the harness
even if a usage transcript names a different underlying model.
When ledger counts are authoritative, transcript model and quota details are
attached only if the transcript session key matches the ledger session key;
otherwise the configured reviewer model is retained.
Successful Claude reviewer JSON supplies usage directly, without a local
transcript scan. If JSON usage is absent or the Claude reviewer fails, local
fallback inspects only the project directory for that review's snapshot cwd
and transcript files modified since the attempt began. Codex reviewer rollout
capture remains inside its harness while the per-worker session home exists.
For successful bounded chunk reviews, `src/reviewer-harness.mjs` normalizes
each chunk's provider usage and sums the existing token and cost fields into
one pass. Provider totals are summed without adding overlapping component
buckets again. Missing usage on some chunks marks the aggregate partial;
missing usage on every chunk leaves usage absent for the existing fallback.

`token_total` preserves a provider-reported total when present. Without one,
Codex uses input + output because reasoning is included in output; Claude uses
input + output + cache read + cache write because its input bucket excludes
cache traffic and thinking is included in output; Gemini uses prompt input +
candidate output + thoughts + tool context. Other sources fall back to input +
output + reasoning. Cache and reasoning columns remain available for analysis
even when they overlap a provider total. Schema convergence does not recompute
historical `token_total` values or fill missing totals; prior provider totals
remain unchanged.

`reviewer_rate_limit_snapshots` stores Codex quota observations linked by
`pass_id` to `reviewer_passes`. Its 11 columns are `id` (autoincrement key),
`pass_id` (required foreign key), `observed_at` (required timestamp),
`limit_id`, `model`, `window_kind` (primary or secondary), `used_percent`,
`window_minutes`, `resets_at`, `plan_type`, and
`rate_limit_reached_type`. Completion inserts available observations with
`INSERT OR IGNORE` under `UNIQUE(pass_id, observed_at, limit_id, window_kind)`.
SQLite considers NULLs distinct for this key, so observations with a missing
`limit_id` or `window_kind` are not deduplicated by that constraint.

For same-pass Gemini quota fallback, the failed/skipped Gemini row remains
terminal. The base reviewer gets the next unused `attempt_number` from
`nextReviewerPassAttemptNumber` for the same PR and `pass_kind`; the logical
`reviewAttemptNumber` and claim session UUID remain unchanged. Review capture,
token evidence and completion all use the fallback's new ledger number and
actual model. Subsequent polls allocate beyond both rows normally.

Reviewer settlement writes `metadata_json.failureMessage` only for unsuccessful
passes; successful passes store `null` even when the runtime emits non-fatal
stderr notices. Failed passes retain the first available error, full stderr,
or stderr tail. Historical metadata is not rewritten.

Antigravity model refusals retain `failureClass: 'reviewer-model-unavailable'`
and `failureDetail: { refusedModel, availableModels }` in pass metadata, with
multiline subprocess stderr in the failure message. Immediate Gemini fallback
leaves the refused pass failed and gives the fallback a new ledger attempt
without charging the logical round. If fallback cannot run, the delivery row
settles as `failed` with the normal terminal attempt charge and is excluded
from automatic infrastructure recovery. Updating configuration alone does not
re-arm the same head: an operator retrigger or a new head is required.

For remediation passes, `attempt_number` is the next unused remediation
attempt for the PR (`MAX(attempt_number) + 1`), assigned when the worker is
spawned. It is monotonic across retries and is not the bounded remediation
round number. Older jobs without a stored worker pass attempt retain the
round-number fallback for terminal settlement.

For closer passes, `attempt_number` is the AMA dispatch record's `retryCount`
(1 when absent), and each launch is recorded once (`src/ama/closer-pass-attempt.mjs`).
If a terminal closer row for the same `metadata_json.launchRequestId` already
exists at any attempt, recording is a no-op. If the requested attempt belongs
to another launch, the pass is recorded at `MAX(attempt_number) + 1` for the
PR. The closer re-reconciles a terminal launch on every tick until it
re-dispatches, and before CLOSERREUSE-01 a second recording threw `refusing to
reuse terminal reviewer_passes row` and failed the closer decision.

Rows with a non-empty `gh_comment_id` are genuine posted-review artifacts. The
watcher's review-freshness pager reads those rows through
`idx_reviewer_passes_posted_review_freshness`, a partial expression index over
`COALESCE(body_captured_at, ended_at)` normalized to fixed millisecond UTC. This
keeps rereview/remediation-cycle posts visible after `reviewed_prs.posted_at` is
reset while avoiding freshness scans over non-posted pass history.

`idx_reviewer_passes_repo_started_at` on `(repo COLLATE NOCASE, started_at)` supports the
burst lease's scoped cost sum. Its query uses raw ISO and SQLite timestamp
ranges so the index can be used without applying string functions to every row.

## Posted-review settlement split

By default, a successful watcher review completes the `reviewer_passes` row
before the corresponding `reviewed_prs` row is settled to `posted`. When
`ADVERSARIAL_REVIEW_ADMISSION_SETTLEMENT_SPLIT` is enabled for a non-pipeline
domain, `src/pollonce-phases.mjs` installs a post-operation callback into
`src/reviewer-spawn-settle.mjs`. After the GitHub review post or post-failure
reconciliation reaches a durable result, that callback settles `reviewed_prs`
early. Reviewer-pool admission capacity is released only after the watcher has
also run the inline final-hammer handoff for that posted row; token-ledger
attribution, artifact writes, and final `reviewer_passes` completion can still
finish after the scarce pool slot is free.

During that split window, a review can be visible in `reviewed_prs` as posted
while its `reviewer_passes` row is still `status='running'`. The window is
intentionally feature-flagged and does not apply to pipeline-enabled domains
unless they explicitly wire an early-release callback. If the callback's
bookkeeping write fails, `spawnReviewer` logs the failure and leaves the row for
the caller's normal post-return settlement path; a posted review must not be
downgraded to a failed reviewer pass solely because the early callback failed.

## Daemon-bounce late-post recovery

`src/daemon-bounce-posted-review.mjs` links a verified exact-head GitHub review
to the first-pass or rereview row whose `metadata_json.reviewerSessionUuid`
matches the bounced delivery claim. It persists `body_md`, `verdict`,
`gh_comment_id`, and `body_captured_at`, completes the pass, and queues or
deduplicates the recovered review's follow-up before committing the delivery
row's posted transition. Missing or conflicting pass evidence and failed
handoffs roll back the SQLite transaction, retaining a retryable bounce claim.
If the file-backed job survives a rollback or daemon crash, the existing
review-keyed queue dedupe prevents duplicate remediation on retry. Later artifact
capture can fill attribution without needing the reaper to create the handoff.

Replacement dispatch uses a dedicated bounce CAS pinned to the original
session, start time, failure timestamp, and head on failed and pending delivery
rows. Nullable evidence uses exact NULL-safe equality, preserving ownership
while allowing incomplete claims to recover once. The shared infrastructure
claim cannot claim daemon-bounce failures.

## Launch and reattach identity

The `metadata_json` object keeps two different identifiers separate:

| Field | Contract |
|---|---|
| `launchRequestId` | Real worker-pool `launch_request_id` surfaced by the runtime adapter, or `null`. An adapter reattach/idempotency token must never be promoted into this field. |
| `reattachToken` | Adapter-owned session, request, or idempotency handle used to resume the reviewer runtime. It is not launch provenance. |
| `workerRunAttribution` | Durable resolution state for `worker_run_id`, described below. |
| `afhReviewerFallback` | Present only when AFH reviewer fallback rewrites the selected reviewer for this pass. The object records `fromReviewerModel`, `toReviewerModel`, `reason`, `lastResort`, `builderClass`, `primaryProvider`, `primaryState`, `primaryHardGrounded`, `primarySoftGrounded`, and the ordered `considered[]` candidate audit so the posted pass can be traced back to the grounding decision that changed reviewer identity. REVIEWERFLOOR-01 adds optional `reserveFloor: { reason, remainingPct, floorPct, source }` for measured personal Anthropic floor fallbacks. The stable reason is `personal-anthropic-reserve-floor`; measured capacity and effective threshold remain in `remainingPct` and `floorPct`. Older reasons embedded percentages and remain readable; old records omit this field. |
| `failureClass` | Present on failed or cancelled terminal remediation rows finalized by `src/follow-up-jobs.mjs` when a failure or stop code is available. It records the bounded failure class used by health and recovery tooling, such as a worker failure code, stopped remediation code, or remediation recovery sentinel. |
| `lastProgressAt` | Most recent persisted reviewer stream event, limited to one write per 30 seconds by `src/reviewer-pass-tokens.mjs`. |
| `heartbeatSupported` | `true` once a streamed reviewer has recorded progress. Together with `lastProgressAt`, selects heartbeat-aware reaper rules. |
| `changedLines` | Changed-line count used to calculate the scaled reviewer ceiling. |
| `reasoningEffort` | Resolved effort used with `changedLines` for the ceiling calculation. |
| `failureReason` | Reaper outcome: `reviewer-dead`, `reviewer-stalled`, `reviewer-ceiling`, or `running-pass-timeout-legacy` for passes without heartbeat support. |

The reaper skips sessions still settling in the watcher and live process groups.
It gives a completed run record five minutes to settle after its terminal
heartbeat. Streamed idle reaping starts after 1.5 times the configured idle
timeout plus 30 seconds; ceiling reaping starts ten minutes after the scaled
ceiling. These rules protect posting, throttling, and fallback phases that do
not emit model stream events. A matching review claim is released only when the
reaper can safely settle the pass.

`workerRunAttribution.state` is one of:

- `resolved`: `workerRunId` was found; `retryable` is false.
- `pending`: a real `launchRequestId` exists but bounded settle-time lookup did
  not yet find its ledger row. `lookupAttempts`, a sanitized `lastError`, and
  `retryable: true` make the state repairable.
- `not-applicable`: no real launch ID was emitted (for example, a direct CLI
  reviewer); reattach identity remains separate and no worker-run repair is
  attempted.

Settle never uses `reattachToken` as a launch-request lookup key. It may use the
token only as adapter-session evidence; that evidence cannot populate
`worker_run_id` unless it independently returns a real worker run identifier.
Settle retries transient SQLite contention before recording `pending`.
`scripts/backfill-reviewer-passes.mjs` revisits only pending rows whose
`workerRunAttribution.launchRequestId` exactly matches the real
`metadata_json.launchRequestId`, then fills `worker_run_id` once the session
ledger exposes the matching run. This prevents a request-shaped reattach token
from contaminating launch attribution.


`metadata_json.singleReview` records the applied single-review decision
(`applied`, `basis`, `stats`) before review execution or GitHub posting.
Transient SQLite locks are retried; a permanent persistence failure aborts
the pass before posting. Body capture also preserves the decision alongside
the verified GitHub artifact. Reviewer crash recovery prefers this pass-bound
evidence over the best-effort review-mode latency event. Older passes without
it still use the head-and-attempt-keyed event; neither source means normal rounds.

A same-pass Gemini quota fallback creates a fresh runtime session UUID and spawn
token as well as a new ledger attempt after a terminal Gemini pass. Before
starting it, the watcher atomically transfers the existing `reviewed_prs` claim
from the original UUID to the fallback UUID and persists the effective reviewer
and broker. Logical review/remediation round counters are unchanged; recovery
uses the fallback reviewer identity if the watcher restarts before settlement.

## Recovered follow-up subject metadata (REMEDBRANCH-01)

Watcher reviewer passes preserve `metadata_json.branch` (the PR head ref) and
`metadata_json.builderTag` (the original title prefix) at start and settlement.
The agent-runtime run record carries the same fields in `subjectContext`.
The pass reaper forwards them into follow-up creation; historical missing
branches use the bounded live PR lookup and pending branch-resolution hold
documented in [follow-up jobs](follow-up-jobs.md#branch-and-publication-contract-remedbranch-01).

## Review execution attribution (ITP-13)

`metadata_json.reviewerAttribution` is the version-1 common read projection
from `src/reviewer-attribution.mjs`. It contains canonical role `identity`,
`family`, fixed HCP `reviewerSubject`, nullable `tokenAccountId`, `brokerProvider`,
`holderRef`, `selectionReason`, `evidenceGeneration`, `attemptRef`, `leaseRef`
and `leaseGeneration`. Missing historical account evidence is `null`; an old
holder proves only its holder and review references. Explicit recorded broker
providers survive without inferring a primary account. It contains no credential
bytes, paths or email. Original account/holder receipts remain alongside it.

Native spawn persists its projection in the pass before launch. Gemini binds
its holder in runtime context; body capture, terminal settlement or recovery
then adds that projection to the matching pass. Body capture carries it alongside execution model/effort and verified artifact
metadata. Captured-body and pending-post retries keep the original projection,
never the retrying process's account. Reattach adds the projection only to passes
with the same repo, PR and `reviewerSessionUuid`; a metadata compare-and-swap
preserves concurrent writers. It never rewrites run records or historic signatures.
Recovery reuses a validated run-record projection before consulting legacy raw
receipts, and refuses same-family attribution before writing pass metadata.
Integer evidence and lease generations are non-negative, including initial zero.
A recorded same-family builder/reviewer pair becomes `failed-orphan` before
posted-review recovery; the live process continues to hold its account lease.

Body backfill uses the shared App/PAT aliases, requires a matching commit when
the pass has a head, and preserves the legacy class-as-builder interpretation
when `reviewer_model` is absent. It adds only a projection from existing receipt
metadata, leaving original metadata and review body bytes intact. A concurrent
body/metadata change refuses the stale update and requires a retry. These are
local SQLite metadata changes; the companion session-ledger schema and its
SQLite/Postgres migrations are unchanged.

DOG-10 worker observations preserve `usage_partial` as token capture `partial`,
feeding the existing partial token-usage metadata state without rewriting
measured zero/null counts. No new store field or lifecycle state is introduced.

Observation capture is staged separately through the default-off env-only
`ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED` gate. Disabled or inconclusive public
reads retain unknown OS usage, never fabricated zero or a log/transcript substitute.
The backfill CLI prepares one registered SDK session before synchronous loops;
registration failure stops before pass writes. Programmatic synchronous callers
must prepare the session first. Historical backfill forwards explicit
`adapterSessionKey`/`sessionKeys` from worker/job metadata and skips session
observation when neither is present. Workspace paths grant no lookup authority.
Valid observed sessions outside the accounting window return
`no-session-in-window`, preserving the distinction from unavailable observation.
No persistent field or status changes.

Builder routing uses its existing `data/builder-routing/<repo>-<pr>-<head>.json`
audit: `builder_class_inconclusive` records unavailable or successful-empty
provenance while retaining the title-based review route. These app-owned findings
are review intake observations, never certified worker absence or merge identity.


REVIEWPROV-01 final remediation: Antigravity display-name suffixes contribute
thinking effort only for low, medium, high or xhigh (case-normalized). Release
qualifiers such as Preview, Exp 1206 or Thinking are not reasoning levels and
remain null. An incomplete execution object stamps an unknown harness; model
family/display names never fill an absent runtime identity. Existing null effort
renders n/a, with unchanged verdict headings, persistence fields and lifecycle.
