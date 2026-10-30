# Data Model - Watcher No-progress Lane

**Owner:** watcher posted-review dispatch fairness
**Store:** `data/watcher-no-progress-lane/`
**Source of truth:** `src/watcher-no-progress-lane.mjs`
**Runtime surface:** `src/posted-review-row.mjs`, `src/watcher-no-progress-lane.mjs`, `src/review-retry-exhaustion.mjs`, `src/pollonce-phases.mjs`, `src/operator-label-wake.mjs`

## Purpose

`data/watcher-no-progress-lane/` holds one JSON ledger per `(repo, PR)` for
posted-review subjects that keep being walked without any durable review-state
progress. The watcher uses the ledger to demote unchanged subjects onto a
bounded slow lane while still rechecking them on a capped cadence.

Same-head failed reviews also enter `operator-blocked` with fingerprint and
operator reason `review-retry-cap-exhausted` when unknown or review-population
retry budgets are spent, or the failure is not infrastructure-recoverable.
`parkExhaustedReview` retains SQLite failure evidence, sends one alert per head
and fingerprint, and logs persistence or delivery errors without aborting the
review loop.

The ledger is keyed by PR, with the current head stored inside the document. A
new head is treated as fresh evidence and is walked immediately.

## Files

Directory: `data/watcher-no-progress-lane/`

| File | Shape | Contract |
|---|---|---|
| `<repo>-pr-<number>.json` | No-progress lane ledger | Per-PR lane state for the current head. The repo slug is sanitized and `/` becomes `__`. |

## Ledger Shape

The current schema version is `1`.

Required fields:

| Field | Type | Contract |
|---|---|---|
| `schemaVersion` | number | Ledger schema version. |
| `repo` | string or null | Repository slug. |
| `prNumber` | number | Pull request number. |
| `headSha` | string or null | Head SHA for the series. A different head resets the lane. |
| `fingerprint` | string or null | Stable review-state fingerprint used to detect progress. |
| `decisionFingerprint` | string or null | Stable handler-decision fingerprint for the current head. Incomplete walks retain the handler fields but absorb the current-head stored daemon decline, including clearance, so failed output cannot repeatedly bypass backoff. |
| `decisionResets` | number | Count of decision-only resets or incomplete-walk decline changes consumed for the current head. A new head resets this to `0`; repeated decision changes are capped by the watcher so the lane cannot reset forever on decision churn. |
| `watcherGeneration` | object, optional | `buildIdentity` is a startup-captured SHA-256 of service source, bin, domains, prompts and package manifests. `configGeneration` hashes the canonical effective role-config values and watcher config. Startup migrates legacy records without a generation. Only hashes are persisted. |
| `generationResets` | number, optional | Cumulative count of startup generation resets for this PR, retained across walks. |
| `generationHistory` | array, optional | Last ten startup resets, retaining the prior generation, lane, no-progress/skip/decision-reset counters, first no-progress timestamp and reset timestamp. |
| `hammerRouteActive` | boolean, optional | Final-review hammer ownership keeps this head active regardless of unchanged review state. A subsequent operator hold clears it. |
| `nextAction` | object, optional | NXA-05 selected shared decision for this head, including action, actor, reason, deadline, evidence references, key and queue intent. Automatic stops and cap/deadline reports retain recovery ownership. Explicit operator hold alone selects the operator lane when this field is supplied. CLOSURERECOVERYEXEC-01: the pipeline-health `expiredNextActions` snapshot reads this field (read-only) and reports a non-`refresh` deadline that has passed, with its age. |
| `progressClass` | string | `self-resolving` or `operator-decision-required`. |
| `noProgressTicks` | number | Consecutive walked ticks with the same fingerprint. |
| `skippedTicks` | number | Deferred ticks counted toward the current backoff window. |
| `lane` | string | `active`, `slow`, or `operator-blocked`. |
| `operatorReason` | string, optional | Present only in the `operator-blocked` lane when the handler named why an operator is needed, for example `pr-is-draft` (COMMENTCLOSE-01). A named reason also selects that reason's operator-decision alert text. |
| `firstNoProgressAt` | string or null | First observed timestamp for the unchanged series. |
| `updatedAt` | string or null | Last ledger update timestamp. |
| `lastRunAt` | optional string or null | Last completed or timed-out handler walk. Skips and alert/event updates preserve it, including explicit null (no recorded walk). Only legacy ledgers without this field fall back to `updatedAt`; their first skip captures that fallback. |

Optional `stalledEvent` field:

| Field | Type | Contract |
|---|---|---|
| `emitted` | boolean | `false` means a stalled event was prepared but not yet acknowledged; the next eligible walk must retry. `true` suppresses duplicates for the same fingerprint. |
| `pendingSince` | string or null | Timestamp when the unacknowledged event was first recorded. |
| `emittedAt` | string or null | Timestamp written only after stalled-event emission succeeds. |
| `missingInput` | string | Missing input classification included in the event. |
| `producer` | object | Producer existence/reason/source included in the event. |
| `noProgressTicks` | number | No-progress count included in the event. |

## Operational Contract

- A current-head closer `deferred-by-drain` record, or a legacy transient
  record with an exit-6 drain-in-effect diagnostic, bypasses lane backoff only
  for 300 seconds after `updatedAt` (legacy fallback: `lastAttemptedAt`). A
  confirmed active closer status poll refreshes the hint. Missing, malformed,
  future or expired timestamps resume normal accounting, and the lane retires
  expired hints as `no-dispatch` / `drain-wait-ended` without needing closure
  to run. Either AMA kill switch retires hints too. Drain waits preserve all
  existing debt and do not charge counters. Other heads and refusals retain
  normal backoff. This lane never launches work itself.

- With a selected automated decision the head stays eligible for the next pass even after an overdue report. Confirmed drain observations preserve counters, fingerprint and first-progress clock; clearance does not erase pre-drain debt.

- The lane only changes how often a PR is re-walked; it never changes review,
  remediation, or merge eligibility decisions.
- An unresolved, unpaged hammer evidence stop uses a five-minute interval
  anchored to `lastRunAt`, even in the active lane. Skipped polls cannot move
  that deadline. The scheduler's wake priority and idle starvation floor
  respect its positive `retryAfterMs`. Paged or released stops resume ordinary
  tick backoff; a missing or different-head ledger admits an initial walk.
- An explicit null `lastRunAt` admits an initial evidence-stop walk without
  using a skip timestamp as the cadence anchor. If the review-row read fails,
  lane evaluation logs a warning and checks the live head's hammer audit
  without a reviewed-head fallback.
- Missing, unreadable, malformed, legacy, or head-mismatched ledgers fail open
  toward walking the PR.
- Review-state progress is keyed by `fingerprint`. A change in
  `decisionFingerprint` for the same `fingerprint` is a decision-only reset:
  it clears `noProgressTicks`, `firstNoProgressAt`, and any prepared or emitted
  `stalledEvent`, but it does not report durable review-state progress to the
  caller. The watcher records the reset separately via `decisionResets`.
- NOPROGRESSRESET-01: the decision fingerprint retains closure next-action
  `row`, `action` and `reason`, the returned daemon decline reason, and the
  current-head stored daemon park reason in distinct fields outside the bounded
  generic reason set. Closure's selected decision takes precedence over a
  top-level projection. Timestamps, counts and diagnostic text remain excluded.
  Before deferring a walk the gate compares the stored daemon decline against
  the recorded fingerprint; changed or cleared current-head evidence admits
  the next tick within the existing decision-reset cap. Other-head parks do
  not supply a decline reason. A completed walk records the fresh decision.
  Timed-out, errored and null-result walks absorb the stored decline into the
  prior fingerprint and charge a decision reset without forgiving scheduling
  debt. They preserve a usable prior review fingerprint and operator cadence;
  a reset's null fingerprint is replaced by the first failed walk's baseline.
  Resource/rate-limited walks use the gate's `observeDecision` hook for that
  baseline update without charging no-progress ticks or updating `lastRunAt`.
- On watcher startup, a different code identity or effective config generation
  resets each lane to `active`, clearing current-series counters, fingerprints,
  selected action and stall event. Operator-decision alert debounce survives:
  a deployment alone is not a changed blocker. Prior counters remain in
  `generationHistory`; `lastRunAt` remains the actual last walk. The same build
  and config leave ledger bytes and backoff unchanged. Legacy records migrate
  once. Identity hashing runs inside guarded startup, follows symlinked files
  and directories with cycle detection, and skips absent optional `bin`,
  `domains` and `prompts` roots. Unreadable source/manifests or symlink cycles
  log a startup warning and skip generation reset. Directory-list faults log
  and skip the reset; individual write faults log and leave that ledger's old
  backoff while other ledgers continue. The watcher still starts.
  No new config keys or backoff constants are introduced.
- A successful generation reset deliberately clears fingerprints. Formerly slow,
  unchanged self-resolving PRs therefore receive a new baseline walk plus up to
  `DEFAULT_NO_PROGRESS_LANE_CAP` unchanged walks (four total at the default cap
  of three) before demotion. The ordinary phase budget and concurrency ceiling
  still bound this post-deploy burst. See the closure runbook's scheduling notes.
- Decision-only resets are capped per head by the watcher's configured
  decision-reset cap. Once the cap is spent, later decision changes keep the
  current no-progress series and are logged instead of resetting the lane
  again.
- A fresh, attributable, current-head operator control-label event clears the
  whole per-PR ledger and operator-decision alert debounce state outside that
  decision-reset cap, even when the cap is spent. Discovery observes these
  events before label consumption and lane admission. This re-arms the alert:
  if the same head and fingerprint re-enter `operator-blocked`, the operator
  can receive the same decision alert again. A completed event receipt
  suppresses further resets for that event. See
  [Operator Label Wakes](operator-label-wakes.md) for the five accepted labels,
  receipt lifecycle, the 30-minute bound for new resets, and retention.
  `clearNoProgressLane` returns false if clearing alert debounce fails and
  preserves the lane ledger in that case.
- Stalled-event delivery is prepare-and-acknowledge. The watcher may persist
  `stalledEvent.emitted=false` before calling the event sink, but it flips the
  value to `true` only after the sink resolves successfully. A transient sink
  failure or process exit during delivery therefore retries on a later eligible
  walk without resetting `pendingSince`; the sink failure is logged locally and
  must not suppress operator-decision alert evaluation in the same watcher tick.
- Once `stalledEvent.emitted=true` is recorded for the same head and
  fingerprint, later unchanged ticks do not re-emit the stalled event.
- Merge and close cleanup removes the per-PR ledger once no future walk is
  possible.


NXA-07: successor selection belongs to `nextAction(snapshot)`. This store
retains execution/scheduling evidence and projects the selected action, actor,
reason, head, anchored deadline, decision key and queue intent. Diagnostic reason
text is not an eligibility registry. Automatic stops and unreadable evidence
retain recovery ownership; only explicit hold/draft/disabled intent selects the
operator. Existing durable attempt, lease, request and terminal fences remain.
