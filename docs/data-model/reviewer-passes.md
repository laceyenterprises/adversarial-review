# Reviewer passes

## Ownership

- Store: `data/reviews.db`
- Table: `reviewer_passes`
- Schema: `migrations/20260518_reviewer_passes.sql` plus later additive migrations
- Writers: `src/reviewer-pass-tokens.mjs`, `src/reviewer-spawn-settle.mjs`
- Repair CLI: `scripts/backfill-reviewer-passes.mjs`

`reviewer_passes` is the durable record of each first-pass, remediation, and
closer review attempt. Its primary identity is `(repo, pr_number,
attempt_number, pass_kind)`. `worker_run_id` links a dispatched reviewer to the
session-ledger `worker_runs.run_id` when that attribution is available.

## Launch and reattach identity

The `metadata_json` object keeps two different identifiers separate:

| Field | Contract |
|---|---|
| `launchRequestId` | Real worker-pool `launch_request_id` surfaced by the runtime adapter, or `null`. An adapter reattach/idempotency token must never be promoted into this field. |
| `reattachToken` | Adapter-owned session, request, or idempotency handle used to resume the reviewer runtime. It is not launch provenance. |
| `workerRunAttribution` | Durable resolution state for `worker_run_id`, described below. |

`workerRunAttribution.state` is one of:

- `resolved`: `workerRunId` was found; `retryable` is false.
- `pending`: a real `launchRequestId` exists but bounded settle-time lookup did
  not yet find its ledger row. `lookupAttempts`, a sanitized `lastError`, and
  `retryable: true` make the state repairable.
- `not-applicable`: no real launch ID was emitted (for example, a direct CLI
  reviewer); reattach identity remains separate and no worker-run repair is
  attempted.

Settle retries transient SQLite contention before recording `pending`.
`scripts/backfill-reviewer-passes.mjs` revisits only pending rows whose
`workerRunAttribution.launchRequestId` exactly matches the real
`metadata_json.launchRequestId`, then fills `worker_run_id` once the session
ledger exposes the matching run. This prevents a request-shaped reattach token
from contaminating launch attribution.
