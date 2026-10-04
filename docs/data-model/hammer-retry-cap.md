# Data Model - Hammer Retry Cap Ledger

**Owner:** AMA hammer dispatch retry and redrive caps
**Store:** `data/follow-up-jobs/hammer-retry-cap/`
**Source of truth:** `src/ama/hammer-retry-cap.mjs`
**Runtime surface:** `src/ama/dispatch-closer.mjs`, `src/ama/dead-hammer-rearm.mjs`, `src/ama-closure-orchestration.mjs`

## Purpose

`data/follow-up-jobs/hammer-retry-cap/` records per-PR hammer dispatch counts
for the AMA closer. The ledger bounds three related retry loops:

- per-series hammer dispatches for the same reviewed head;
- lifetime hammer dispatches for the PR across fresh-review resets;
- target-redrive hammer dispatches against the same live remediation target SHA
  across different reviewed-head job keys.

The file is keyed only by `(repo, PR)`, not by head SHA, so hammer-created head
churn cannot reset quota protection. Fresh adversarial reviews may reset the
per-series counter, but they do not reset the lifetime counter. Target-redrive
state resets only when the live remediation target SHA changes.

## Files

Directory: `data/follow-up-jobs/hammer-retry-cap/`

| File | Shape | Contract |
|---|---|---|
| `<repo-slug>-pr-<number>.json` | Hammer retry cap ledger | One current ledger per `(repo, PR)`. The repo slug replaces `/` with `__` and then strips unsafe filename characters. |

## Hammer Retry Cap Ledger

| Field | Shape | Contract |
|---|---|---|
| `schemaVersion` | number | Current value is `2`. Version `2` introduced the target-redrive fields: `targetRemediationSha`, `targetAttemptCount`, `targetSuppressed`, and `targetAlertedAt`. |
| `repo` | string | Repository full name, such as `owner/repo`. |
| `prNumber` | positive integer | Pull request number. |
| `jobKey` | string or null | Stable reviewed-head key for the current per-series counter. A changed known job key resets `attemptCount`, `dispatchHeads`, ordinary retry refunds, and the three per-series deferral fields below. Lifetime refund usage survives. |
| `attemptCount` | non-negative integer | Confirmed hammer dispatches in the current reviewed-head series. Dispatches increment only after launch succeeds. |
| `lifetimeAttemptCount` | non-negative integer | Confirmed hammer dispatches for the PR across all reviewed-head series, less bounded contention refunds (at most twelve for the entire PR). Missing legacy values are seeded from `attemptCount`; non-finite present values fail closed to the lifetime ceiling. |
| `targetRemediationSha` | string or null | Live PR head SHA targeted by HAM remediation. This may differ from `jobKey` when the review is stale and the exhausted-lane hammer runs against a newer head. |
| `targetAttemptCount` | non-negative integer | Confirmed hammer dispatches against `targetRemediationSha` across job keys. A changed known target SHA resets the count; missing legacy values are backfilled from `attemptCount` on suppression writes and from the evaluated target count on dispatch writes. |
| `retryable` | non-negative integer, optional | Dispatches refunded because the hammer exited `succeeded` without closing its PR (HAMBG-02), or its launch failed for an infrastructure reason and it pushed nothing (CLOSERREUSE-01). `attemptCount` and the matching `targetAttemptCount` go down by one, and `retryable` goes up by one. At most `HAMMER_EXITED_WITHOUT_CLOSE_RETRY_BUDGET` (1) per series. Belongs to the series: a fresh-review job-key change resets it, on a dispatch write and on a suppression write alike. Absent until the first refund. Not the same counter as the base-branch merge gate's `retryable` (HAMGATE-01, `data/merge-leases/`): the two live in different stores and have separate budgets. |
| `retryableLaunchRequestIds` | string array, optional | Launch request ids already refunded, so a launch observed on several ticks is refunded once. Last 10 kept; reset with `retryable`. |
| `deferralLaunches` | string array | Launch IDs observed parked on merge-lease contention or pending required checks in this review series. Dedupes refunds across ticks and against `retryableLaunchRequestIds`. Resets on a changed known job key because the certified reviewed-head queue changed. At twelve deferrals the queue expires. |
| `deferralStartedAt` | ISO-8601 string or null | First observed deferral in this series; anchors the six-hour queue deadline. Resets with the job key. |
| `deferralNextAt` | ISO-8601 string or null | Earliest resume time after the latest newly observed deferral; two-minute exponential backoff capped at thirty minutes. Resets with the job key. |
| `lifetimeDeferralRefundCount` | integer in 0..12 | Contention lifetime refunds consumed across all series. Never reset by a fresh review or suppression write. New ledgers start at zero. Missing or malformed legacy values are treated as twelve (refunds exhausted); only operator reconciliation can restore unproven refund capacity. |
| `dispatchHeads` | string array | Unique dispatched head SHAs observed in the current reviewed-head series. Resets on a fresh-review job-key change. |
| `lastDispatchedHeadSha` | string or null | Most recent head SHA used for a confirmed hammer dispatch. |
| `suppressed` | boolean | `true` once any cap has blocked hammer dispatch for the ledger's current state. |
| `lifetimeSuppressed` | boolean | `true` once the lifetime cap has blocked dispatch. This flag is not cleared by job-key changes. |
| `targetSuppressed` | boolean | `true` once the target-redrive cap has blocked dispatch for `targetRemediationSha`. A changed known target SHA clears stale target suppression. |
| `suppressionState` | string or null | Operator-visible suppression state. Values are `hammer-retry-cap-exhausted-needs-operator`, `hammer-lifetime-ceiling-reached-needs-operator`, or `hammer-target-redrive-cap-exhausted-needs-operator`. |
| `suppressedJobKey` | string or null | Job key associated with the suppression stamp. |
| `suppressedHeadSha` | string or null | Head SHA associated with the suppression stamp. |
| `suppressedAttemptCount` | non-negative integer or null | Per-series attempt count observed when suppression was stamped. |
| `alertedAt` | string or null | ISO-8601 timestamp for the operator alert covering per-series or lifetime suppression. Preserved across repeat suppression ticks. |
| `targetAlertedAt` | string or null | ISO-8601 timestamp for the operator alert covering target-redrive suppression. Reset when the target SHA changes. |
| `createdAt` | string or null | ISO-8601 timestamp from the first write when available. |
| `updatedAt` | string or null | ISO-8601 timestamp from the latest write when available. |

## Operational Contract

- Missing ledger files are treated as no prior attempts.
- Read or parse failures fail closed by returning a synthetic exhausted ledger;
  corrupt files must page the operator rather than silently resetting counts.
- The ledger counts confirmed hammer launches only. Interrupted pre-launch work
  does not create phantom attempts that need reclaiming.
- Ordinary exited-without-close/infrastructure refunds never touch
  `lifetimeAttemptCount`, and are refused once the series is suppressed or their
  budget is spent. Contention deferrals separately refund `attemptCount` and the
  matching `targetAttemptCount` once per charged launch, for up to twelve
  deferrals per series. They reduce `lifetimeAttemptCount` only while the
  PR-wide `lifetimeDeferralRefundCount` is below twelve, and increment that
  durable usage counter. Fresh reviews cannot replenish lifetime refunds, so
  the total launch ceiling is bounded by the normal lifetime ceiling plus twelve.
  Both refund paths refuse a launch already refunded by the other path.
- Per-series suppression can clear only when a known fresh reviewed-head job key
  arrives. Lifetime suppression survives fresh-review resets.
- Target-redrive suppression is scoped to the live target SHA. When the target
  SHA changes, target suppression and `targetAlertedAt` reset so a genuinely new
  target is not blocked by stale target state.
- Operator alerts are debounced by `alertedAt` and `targetAlertedAt`. A failed
  alert write leaves the relevant timestamp null so a later suppression tick can
  retry delivery.
- Ledger writes are atomic JSON rewrites. Operators may repair or clear a file,
  but malformed numeric counters fail closed rather than re-arming quota burn.
- The two refund kinds share one budget per series, and
  `retryableLaunchRequestIds` keeps either from refunding a launch twice. The
  infrastructure reasons (`src/ama/dead-hammer-rearm.mjs`) are the LRQ failure
  classes `oauth_access_token_revoked` and `adapter_boot_crash`, and
  `process_exited_after_progress` or `worker_killed` with the provider's API
  429 in the worker's own output. The first two are refunded only when the
  next dispatch resolves to a different harness class; otherwise the death
  stays charged (`infra-cause-persists`), keeping the refund for an exit that a
  re-dispatch could help. A 429 death is refunded without that check.

Deferral fields are preserved on suppression writes within a series. A changed
known job key clears only the series queue, including on suppression writes.
