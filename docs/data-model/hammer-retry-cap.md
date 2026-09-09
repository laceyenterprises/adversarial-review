# Data Model - Hammer Retry Cap Ledger

**Owner:** AMA hammer dispatch retry and redrive caps
**Store:** `data/follow-up-jobs/hammer-retry-cap/`
**Source of truth:** `src/ama/hammer-retry-cap.mjs`
**Runtime surface:** `src/ama/dispatch-closer.mjs`, `src/ama-closure-orchestration.mjs`

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
| `jobKey` | string or null | Stable reviewed-head key for the current per-series counter. A changed known job key resets `attemptCount` and `dispatchHeads`. |
| `attemptCount` | non-negative integer | Confirmed hammer dispatches in the current reviewed-head series. Dispatches increment only after launch succeeds. |
| `lifetimeAttemptCount` | non-negative integer | Confirmed hammer dispatches for the PR across all reviewed-head series. Missing legacy values are seeded from `attemptCount`; non-finite present values fail closed to the lifetime ceiling. |
| `targetRemediationSha` | string or null | Live PR head SHA targeted by HAM remediation. This may differ from `jobKey` when the review is stale and the exhausted-lane hammer runs against a newer head. |
| `targetAttemptCount` | non-negative integer | Confirmed hammer dispatches against `targetRemediationSha` across job keys. A changed known target SHA resets the count; missing legacy values are backfilled from `attemptCount` on suppression writes and from the evaluated target count on dispatch writes. |
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
