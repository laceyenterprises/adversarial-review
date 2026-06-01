# Review Pipeline Health

`src/review-pipeline-health.mjs` reads the live `data/reviews.db` ledger plus
`data/follow-up-jobs/` and emits both Prometheus metrics and Sentinel-shaped
findings. The collector opens `reviews.db` read-only, never runs schema
convergence from the metrics path, and treats missing review-state tables or
columns as an empty snapshot instead of mutating the watcher-owned database.

Run locally:

```sh
npm run pipeline-health -- --prometheus
npm run pipeline-health -- --sentinel
```

The Grafana dashboard lives at
`observability/grafana/review-pipeline-health.json`.

## Metrics

- `review_pipeline_reviewer_attempts_total`: reviewer first-pass/rereview
  attempts by `status`, `failure_class`, and `pass_kind`. The Prometheus
  output declares this as a gauge because it is a windowed snapshot, not a
  cumulative counter.
- `review_pipeline_failed_attempts_distinct_prs`: distinct PR count contributing
  failed reviewer attempts by `failure_class` within the configured
  unknown-rate alert window. This drives the dashboard sub-panel that shows
  whether an unknown spike is one flapping PR or a cross-PR incident.
- `review_pipeline_health_collector_up`: 1 when the collector can open
  `reviews.db` read-only, 0 when the review-state ledger is missing or
  unreadable. Page on the specific unreadable-ledger Sentinel finding for the
  exists-but-unopenable case; keep any `collector_up == 0` page scoped to the
  missing-ledger case or downgrade it to avoid double-paging the same incident.
- `review_pipeline_first_pass_queue_depth`: open PRs waiting in
  `reviewed_prs.review_status='pending'`.
- `review_pipeline_first_pass_oldest_pending_age_seconds`: age of the oldest
  pending first-pass/rereview row.
- `review_pipeline_remediation_backlog_jobs`: follow-up job counts by queue
  state.
- `review_pipeline_remediation_oldest_pending_age_seconds`: age of the oldest
  pending remediation job.
- `review_pipeline_remediation_throughput_jobs`: terminal remediation jobs in
  the configured throughput window.
- `review_pipeline_merge_outcomes_total`: `reviewed_prs.pr_state` counts.
  The Prometheus output declares this as a gauge because rows can move between
  states.
- `review_pipeline_merge_stalled_jobs`: clean `review-settled` verdict jobs
  whose PR row remains open past the merge-stall tick threshold.
- `review_pipeline_sentinel_finding_active`: 1 when a finding code is currently
  firing, 0 after it clears.

## Sentinel Findings

| Code | Default threshold | Tier | Clears when |
|---|---:|---|---|
| `review:review_state_ledger_unreadable` | `reviews.db` exists but cannot be opened read-only | page | the collector can open `reviews.db` read-only again |
| `review:reviewer_death_rate_high` | failed reviewer attempts are >50% of completed+failed attempts over 1h, with at least 3 completed+failed attempts; `running` and `cancelled` are excluded from the denominator | page | the settled-attempt window falls below threshold or the minimum-attempt guard |
| `review:unknown_failure_rate_high` | unknown-classified failures are >30% of failures over 15m, with at least 5 failures and at least 2 distinct PRs contributing unknown failures | page | the failure window falls back to threshold or below, the sample floor is no longer met, or unknown failures collapse to fewer than 2 PRs |
| `review:queue_starvation` | oldest pending first-pass row is >30m old | page | no pending row exceeds the age threshold |
| `review:remediation_backlog` | `follow-up-jobs/pending` has >5 jobs | ticket | pending job count returns to threshold or below |
| `review:merge_stalled` | a `stopped:review-settled` job remains open for >3 watcher ticks | page | the PR is merged/closed or the settled job is no longer past threshold |

## Configuration

All thresholds are configurable through environment variables:

- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_REVIEWER_DEATH_RATE_WINDOW_MS`
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_REVIEWER_DEATH_RATE_THRESHOLD`
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_REVIEWER_DEATH_RATE_MIN_ATTEMPTS`
- `REVIEW_UNKNOWN_RATE_THRESHOLD`
- `REVIEW_UNKNOWN_RATE_WINDOW_MINUTES`
- `REVIEW_UNKNOWN_RATE_SAMPLE_FLOOR`
- `REVIEW_UNKNOWN_RATE_DISTINCT_PR_FLOOR`
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_QUEUE_STARVATION_MAX_AGE_MS`
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_REMEDIATION_BACKLOG_THRESHOLD`
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_MERGE_STALLED_MAX_TICKS`
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_TICK_INTERVAL_MS`
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_REMEDIATION_THROUGHPUT_WINDOW_MS`

Later ARP tracks can extend this collector by adding hq remediation and merge
dispatch ledgers to the same snapshot. The current version intentionally ships
against `reviews.db` and the existing follow-up queues so the next silent stall
is visible before those later signals arrive.
