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
  `running` past the health age threshold. The watcher poll timeout sweep
  separately fails parseably aged running rows after
  `reviewer.running_pass_timeout_seconds` with
  `failureClass='reviewer-timeout'` / `failureReason='running-pass-timeout'`
  and releases a still-matching `reviewed_prs.reviewing` claim through the
  transient `pending-upstream` timeout path. Matching prefers pass metadata
  `reviewerSessionUuid`; legacy pass rows missing that field can match by same
  head plus a pass start at or after the durable claim start.
- `review_pipeline_round_budget_anomalies`: follow-up jobs whose remediation
  rounds exceed the risk-class budget, or final-pass jobs stuck
  `awaiting-rereview` after the budget is exhausted.
- `review_pipeline_ttm_minutes`: median (`quantile="0.5"`) and p90
  (`quantile="0.9"`) open-to-merge duration over the 12h SEV1 measurement
  window.
- `review_pipeline_ttm_open_budget_breaches`: open PRs beyond the
  rounds-aware TTM budget (`base + review_rounds * per_round`).
- `review_pipeline_ttm_terminal_unmerged_stalls_12h`: terminal-but-unmerged
  stall events observed in the last 12h.
- `review_pipeline_ttm_terminal_unmerged_duration_minutes_12h`: max and total
  terminal-but-unmerged stall duration over the last 12h.
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

All findings below are ticket/digest diagnostics. The only adversarial-review
page is `adversarial_review.reviewer_stalled`: published reviews have stopped
past the freshness window while at least one open PR awaits first-pass review.
Its action headline is `Reviews stalled — restore reviewer dispatch`.

| Code | Default threshold | Tier | Clears when |
|---|---:|---|---|
| `review:review_state_ledger_unreadable` | `reviews.db` exists but cannot be opened read-only | ticket | the collector can open `reviews.db` read-only again |
| `review:reviewer_death_rate_high` | failed reviewer attempts are >50% of completed+failed attempts over 1h, with at least 3 completed+failed attempts; `running` and `cancelled` are excluded from the denominator | ticket | the settled-attempt window falls below threshold or the minimum-attempt guard |
| `review:unknown_failure_rate_high` | unknown-classified failures are >30% of failures over 15m, with at least 5 failures and at least 2 distinct PRs contributing unknown failures | ticket | the failure window falls back to threshold or below, the sample floor is no longer met, or unknown failures collapse to fewer than 2 PRs |
| `review:reviewer_degradation_active` | at least one PR is currently held by `provider-overloaded` transient backoff or `quota-exhausted` quota hold | ticket | no active provider-overload backoff or quota hold remains |
| `review:queue_starvation` | oldest pending first-pass row is >10m old | ticket | no pending row exceeds the age threshold |
| `review:malformed_pr_title` | one or more open PRs are recorded `review_status='malformed'` | ticket | malformed rows are recreated, explicitly recovered, or no longer open; known bot-authored prefixless PRs are routed to Argus with `review_status='argus-security-queued'` (ASR-04) and do not trigger this alert; neither do legacy `unroutable-bot-author` rows |
| `review:remediation_backlog` | `follow-up-jobs/pending` has >5 jobs | ticket | pending job count returns to threshold or below |
| `review:merge_stalled` | a `stopped:review-settled` job remains open for >3 watcher ticks | ticket | the PR is merged/closed or the settled job is no longer past threshold |
| `review:ttm_budget_breach` | open PR age exceeds `base + review_rounds * per_round` minutes | ticket | the PR merges/closes or falls back under the rounds-aware budget |
| `review:terminal_but_unmerged` | settled/clean PR remains open and unmerged past the terminal threshold | ticket | the PR merges/closes or no longer has a settled clean terminal signature |
| `review:daemon_merge_parked` | the AMA daemon clean-merge declined the same PR for the same reason for 3+ consecutive ticks (e.g. `worker-identity-unresolved`, `verdict-not-eligible`, `lease-not-held`) | ticket | the PR merges/closes, the daemon's decline reason changes, or the park is not refreshed for two pipeline-health ticks |
| `review:ama_closer_lease_stale` | AMA closer lease is `pending`/`dispatched`, `terminalOutcome=null`, and older than 30m | ticket | the lease reaches terminal state or falls below the age threshold |
| `review:reviewer_pass_zombie` | `reviewer_passes.status='running'` row is older than the zombie threshold (default 90m: reviewer-pass-reaper's `DEFAULT_RUNNING_PASS_TIMEOUT_SECONDS` of 3600s plus 50% grace, so the finding only fires once the reaper itself has failed) | ticket | no running reviewer pass exceeds the age threshold; the watcher timeout sweep should settle parseably aged rows as `failed` / `reviewer-timeout` |
| `review:stuck_retry_loop` | one or more open PRs remain `review_status='failed'` after infra auto-recovery exhausted its attempt cap (`infra_auto_recover_attempts` at/over the cap, default 3); when the dominant `failure_class` is `diff-too-large`, the failure is deterministic because GitHub refused to serve the PR diff | ticket | no open PR remains failed at/over the infra auto-recovery cap (the review reposts/succeeds, the oversized PR is split or otherwise reviewable by file list, or the PR merges/closes) |
| `review:round_budget_anomaly` | remediation round count exceeds the risk-class budget, or a final-pass job remains `awaiting-rereview` after budget exhaustion | ticket | no follow-up job violates the risk-class round budget |
| `review:daemon_liveness` | required local pipeline LaunchAgent is not loaded | ticket | adversarial watcher, adversarial follow-up, and dispatch daemon labels are loaded |
| `review:daemon_probe_failure` | required local pipeline LaunchAgent loaded state cannot be determined | ticket | launchctl probes can determine loaded state for adversarial watcher, adversarial follow-up, dispatch daemon, and dag-autowalk labels |
| `review:dispatch_spawn_failures` | dispatch daemon stderr has recent closer/hammer spawn-failure signals over 1h | ticket | no matching recent dispatch daemon stderr lines remain |
| `review:dag_autowalk_launchd_unhealthy` | dag-autowalk is unloaded, last exit is non-zero, or logs are stale for >2h | ticket | dag-autowalk is loaded with a zero/unknown last exit and fresh logs |

## Configuration

### Stuck retry-loop failure classes

The stuck retry-loop finding includes `details.dominantFailureClass`,
`details.byFailureClass`, and per-PR `failureClass` evidence. Operators should
branch on that class before retriggering reviews:

- `diff-too-large` means the reviewer could not fetch the PR diff because it
  exceeded GitHub's diff API cap. This is not reviewer auth, quota, or
  infrastructure degradation, and retriggering the same reviewer lane will fail
  the same way. Split the PR, make the changed file list reviewable, close the
  PR, or otherwise resolve the oversized diff condition. The finding clears once
  the affected open PRs no longer remain failed at/over the auto-recovery cap.
- Other dominant failure classes keep the generic exhausted-auto-recovery
  contract: investigate the reviewer lane for the dominant auth, quota, command,
  timeout, or upstream failure before retriggering the affected reviews.

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
