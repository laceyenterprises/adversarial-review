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

For closer passes, a confirmed merge records `status='completed'`. An unmerged
worker success, including `unverified-terminal-success`, records `failed`;
cancelled or superseded work records `cancelled`. This keeps time-to-merge
rollups from counting an unproven merge. `metadata_json.workerClass` holds the
logical AMA dispatch class, even when `reviewer_class` names a fallback harness.

## Claimed reviewer account

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
rows. The shared infrastructure claim cannot claim daemon-bounce failures.

## Launch and reattach identity

The `metadata_json` object keeps two different identifiers separate:

| Field | Contract |
|---|---|
| `launchRequestId` | Real worker-pool `launch_request_id` surfaced by the runtime adapter, or `null`. An adapter reattach/idempotency token must never be promoted into this field. |
| `reattachToken` | Adapter-owned session, request, or idempotency handle used to resume the reviewer runtime. It is not launch provenance. |
| `workerRunAttribution` | Durable resolution state for `worker_run_id`, described below. |
| `afhReviewerFallback` | Present only when AFH reviewer fallback rewrites the selected reviewer for this pass. The object records `fromReviewerModel`, `toReviewerModel`, `reason`, `lastResort`, `builderClass`, `primaryProvider`, `primaryState`, `primaryHardGrounded`, `primarySoftGrounded`, and the ordered `considered[]` candidate audit so the posted pass can be traced back to the grounding decision that changed reviewer identity. |
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
