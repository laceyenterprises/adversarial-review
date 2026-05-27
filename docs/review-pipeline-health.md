# Review Pipeline Health

`src/review-pipeline-health.mjs` reads the live `data/reviews.db` ledger plus
`data/follow-up-jobs/` and emits both Prometheus metrics and Sentinel-shaped
findings.

Run locally:

```sh
npm run pipeline-health -- --prometheus
npm run pipeline-health -- --sentinel
```

The Grafana dashboard lives at
`observability/grafana/review-pipeline-health.json`.

## Metrics

- `review_pipeline_reviewer_attempts_total`: reviewer first-pass/rereview
  attempts by `status`, `failure_class`, and `pass_kind`.
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
- `review_pipeline_merge_stalled_jobs`: clean `review-settled` verdict jobs
  whose PR row remains open past the merge-stall tick threshold.
- `review_pipeline_sentinel_finding_active`: 1 when a finding code is currently
  firing, 0 after it clears.

## Sentinel Findings

| Code | Default threshold | Tier | Clears when |
|---|---:|---|---|
| `review:reviewer_death_rate_high` | failed reviewer attempts are >50% of attempts over 1h, with at least 3 attempts | page | the window falls below threshold or the minimum-attempt guard |
| `review:queue_starvation` | oldest pending first-pass row is >30m old | page | no pending row exceeds the age threshold |
| `review:remediation_backlog` | `follow-up-jobs/pending` has >5 jobs | ticket | pending job count returns to threshold or below |
| `review:merge_stalled` | a `stopped:review-settled` job remains open for >3 watcher ticks | page | the PR is merged/closed or the settled job is no longer past threshold |

## Configuration

All thresholds are configurable through environment variables:

- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_REVIEWER_DEATH_RATE_WINDOW_MS`
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_REVIEWER_DEATH_RATE_THRESHOLD`
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_REVIEWER_DEATH_RATE_MIN_ATTEMPTS`
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_QUEUE_STARVATION_MAX_AGE_MS`
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_REMEDIATION_BACKLOG_THRESHOLD`
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_MERGE_STALLED_MAX_TICKS`
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_TICK_INTERVAL_MS`
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_REMEDIATION_THROUGHPUT_WINDOW_MS`

Later ARP tracks can extend this collector by adding hq remediation and merge
dispatch ledgers to the same snapshot. The current version intentionally ships
against `reviews.db` and the existing follow-up queues so the next silent stall
is visible before those later signals arrive.
