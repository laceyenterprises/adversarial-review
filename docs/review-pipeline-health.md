# Review Pipeline Health

`src/review-pipeline-health.mjs` reads the live `data/reviews.db` ledger plus
`data/follow-up-jobs/` and `data/cascade-state/`, then emits both Prometheus
metrics and Sentinel-shaped findings. The collector opens `reviews.db`
read-only, never runs schema convergence from the metrics path, and treats
missing review-state tables or columns as an empty snapshot instead of mutating
the watcher-owned database.

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
- `review_pipeline_reviewer_degradation_active`: active reviewer degradation
  count by `failure_class` and `state`. `provider-overloaded` appears as
  `transient-backoff` for HTTP 529/backend capacity signals, while
  `quota-exhausted` appears as `quota-hold` until the stored provider reset
  time or fallback window clears.
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
- `review_pipeline_stale_ama_closer_leases`: AMA closer leases in
  `pending`/`dispatched` with no terminal outcome past the age threshold.
- `review_pipeline_zombie_reviewer_passes`: `reviewer_passes` rows still
  `running` past the age threshold.
- `review_pipeline_round_budget_anomalies`: follow-up jobs whose remediation
  rounds exceed the risk-class budget, or final-pass jobs stuck
  `awaiting-rereview` after the budget is exhausted.
- `review_pipeline_launchd_service_up`: required local pipeline LaunchAgents
  loaded state. Host launchd checks are opt-in for the scheduled local
  diagnostic with `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS=1`.
- `review_pipeline_dispatch_spawn_failures`: recent dispatch daemon stderr
  lines matching closer/hammer spawn failure signals such as entitlement-auth,
  403 rate-limit, or exit 65.
- `review_pipeline_dag_autowalk_healthy`: dag-autowalk LaunchAgent last-exit
  and recent-log health.
- `review_pipeline_sentinel_finding_active`: 1 when a finding code is currently
  firing, 0 after it clears.

## Sentinel Findings

| Code | Default threshold | Tier | Clears when |
|---|---:|---|---|
| `review:review_state_ledger_unreadable` | `reviews.db` exists but cannot be opened read-only | page | the collector can open `reviews.db` read-only again |
| `review:reviewer_death_rate_high` | failed reviewer attempts are >50% of completed+failed attempts over 1h, with at least 3 completed+failed attempts; `running` and `cancelled` are excluded from the denominator | page | the settled-attempt window falls below threshold or the minimum-attempt guard |
| `review:unknown_failure_rate_high` | unknown-classified failures are >30% of failures over 15m, with at least 5 failures and at least 2 distinct PRs contributing unknown failures | page | the failure window falls back to threshold or below, the sample floor is no longer met, or unknown failures collapse to fewer than 2 PRs |
| `review:reviewer_degradation_active` | at least one PR is currently held by `provider-overloaded` transient backoff or `quota-exhausted` quota hold | page | no active provider-overload backoff or quota hold remains |
| `review:queue_starvation` | oldest pending first-pass row is >30m old | page | no pending row exceeds the age threshold |
| `review:remediation_backlog` | `follow-up-jobs/pending` has >5 jobs | ticket | pending job count returns to threshold or below |
| `review:merge_stalled` | a `stopped:review-settled` job remains open for >3 watcher ticks | page | the PR is merged/closed or the settled job is no longer past threshold |
| `review:ama_closer_lease_stale` | AMA closer lease is `pending`/`dispatched`, `terminalOutcome=null`, and older than 30m | page | the lease reaches terminal state or falls below the age threshold |
| `review:reviewer_pass_zombie` | `reviewer_passes.status='running'` row is older than 30m | page | no running reviewer pass exceeds the age threshold |
| `review:round_budget_anomaly` | remediation round count exceeds the risk-class budget, or a final-pass job remains `awaiting-rereview` after budget exhaustion | page | no follow-up job violates the risk-class round budget |
| `review:daemon_liveness` | required local pipeline LaunchAgent is not loaded | page | adversarial watcher, adversarial follow-up, and dispatch daemon labels are loaded |
| `review:dispatch_spawn_failures` | dispatch daemon stderr has recent closer/hammer spawn-failure signals over 1h | page | no matching recent dispatch daemon stderr lines remain |
| `review:dag_autowalk_launchd_unhealthy` | dag-autowalk is unloaded, last exit is non-zero, or logs are stale for >2h | page | dag-autowalk is loaded with a zero/unknown last exit and fresh logs |

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
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS`
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_AMA_CLOSER_LEASE_MAX_AGE_MS`
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_RUNNING_REVIEWER_PASS_MAX_AGE_MS`
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_DAG_AUTOWALK_MAX_LOG_AGE_MS`
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_DISPATCH_SPAWN_FAILURE_WINDOW_MS`
- `ADVERSARIAL_REVIEW_PIPELINE_HEALTH_LAUNCHD_TIMEOUT_MS`

Later ARP tracks can extend this collector by adding hq remediation and merge
dispatch ledgers to the same snapshot. The current version intentionally ships
against `reviews.db` and the existing follow-up queues so the next silent stall
is visible before those later signals arrive.
