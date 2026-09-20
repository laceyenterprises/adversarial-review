# Reviewer passes

**Source of truth:** `migrations/20260518_reviewer_passes.sql`, `migrations/20260810_reviewer_passes_posted_review_freshness_index.sql`, `src/reviewer-pass-tokens.mjs`, `src/reviewer-spawn-settle.mjs`, `src/pollonce-phases.mjs`, `src/orphan-post-reconcile.mjs`, and `src/follow-up-jobs.mjs`

## Ownership

- Store: `data/reviews.db`
- Table: `reviewer_passes`
- Schema: `migrations/20260518_reviewer_passes.sql` plus later additive migrations
- Writers: `src/reviewer-pass-tokens.mjs`, `src/reviewer-spawn-settle.mjs`, `src/pollonce-phases.mjs`, `src/orphan-post-reconcile.mjs`, `src/follow-up-jobs.mjs`
- Repair CLI: `scripts/backfill-reviewer-passes.mjs`; `bin/reconcile-posted-orphans.mjs` links posted review artifacts for reconciled `failed-orphan` rows

`reviewer_passes` is the durable record of each first-pass, remediation, and
closer review attempt. Its primary identity is `(repo, pr_number,
attempt_number, pass_kind)`. `worker_run_id` links a dispatched reviewer to the
session-ledger `worker_runs.run_id` when that attribution is available.

Rows with a non-empty `gh_comment_id` are genuine posted-review artifacts. The
watcher's review-freshness pager reads those rows through
`idx_reviewer_passes_posted_review_freshness`, a partial expression index over
`COALESCE(body_captured_at, ended_at)` normalized to fixed millisecond UTC. This
keeps rereview/remediation-cycle posts visible after `reviewed_prs.posted_at` is
reset while avoiding freshness scans over non-posted pass history.

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

## Launch and reattach identity

The `metadata_json` object keeps two different identifiers separate:

| Field | Contract |
|---|---|
| `launchRequestId` | Real worker-pool `launch_request_id` surfaced by the runtime adapter, or `null`. An adapter reattach/idempotency token must never be promoted into this field. |
| `reattachToken` | Adapter-owned session, request, or idempotency handle used to resume the reviewer runtime. It is not launch provenance. |
| `workerRunAttribution` | Durable resolution state for `worker_run_id`, described below. |
| `afhReviewerFallback` | Present only when AFH reviewer fallback rewrites the selected reviewer for this pass. The object records `fromReviewerModel`, `toReviewerModel`, `reason`, `lastResort`, `builderClass`, `primaryProvider`, `primaryState`, `primaryHardGrounded`, `primarySoftGrounded`, and the ordered `considered[]` candidate audit so the posted pass can be traced back to the grounding decision that changed reviewer identity. |
| `failureClass` | Present on failed terminal rows, including remediation pass rows finalized by `src/follow-up-jobs.mjs`. It records the bounded failure class used by health and recovery tooling, such as a worker failure code, stopped remediation code, or remediation recovery sentinel. |

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
