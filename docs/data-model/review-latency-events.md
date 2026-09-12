# Review latency events

**Source of truth:** `migrations/20260911_review_latency_events.sql`, `src/review-state.mjs`, and `src/review-latency-report.mjs`

## Ownership

- Store: `data/reviews.db`
- Table: `review_latency_events`
- Schema: `migrations/20260911_review_latency_events.sql` plus the idempotent
  schema-convergence path in `src/review-state.mjs`
- Writer API: `recordReviewLatencyEvent` in `src/review-state.mjs`
- Readers: `src/review-latency-report.mjs` and `src/review-latency-cli.mjs`

`review_latency_events` is the durable explicit-event ledger for the review
latency report. It supplements events inferred from `reviewed_prs`,
`reviewer_passes`, and follow-up job files with operator- or runtime-recorded
timestamps for latency boundaries that do not otherwise have a canonical row.

Rows identify either a GitHub PR subject (`repo`, `pr_number`) or a generic
domain subject (`domain_id`, `subject_external_id`, `revision_ref`). The
`event_type` describes the boundary being recorded, while `stage` records the
owning subsystem for display and diagnosis. `recordReviewLatencyEvent` derives
the stage from the event type when callers do not pass one explicitly.

## Event contract

Valid event types are the fixed set accepted by `recordReviewLatencyEvent` and
reported by `collectReviewLatencyReport`:

- `pr_observed`
- `queue_eligible`
- `row_claimed`
- `reviewer_started`
- `reviewer_first_output`
- `reviewer_post_attempt`
- `reviewer_post_success`
- `reviewer_post_failure`
- `settlement_completed`
- `follow_up_created`
- `clean_verdict`
- `rereview_wake`
- `hammer_wake`
- `merge_completed`
- `deploy_observed`
- `smoke_result`

`at` is the event time used for latency calculations. `recorded_at` is the
database insert time and is diagnostic only. `source` and `source_ref` identify
where the event came from, `reason` stores a short human-readable explanation,
and `payload_json` stores structured details. The schema enforces
`json_valid(payload_json)` so readers can parse the payload without treating bad
JSON as a report-time data-quality problem.

## Idempotency and indexes

Callers that can provide a stable event identity should set
`idempotency_key`. The partial unique index
`review_latency_events_idempotency_unique` deduplicates by
`(event_type, idempotency_key)` while still allowing events without an
idempotency key.

`idx_review_latency_events_subject_at` supports per-PR timeline reads ordered by
event time. `idx_review_latency_events_type_at` supports type/window scans used
by latency reporting and route-state diagnostics.
