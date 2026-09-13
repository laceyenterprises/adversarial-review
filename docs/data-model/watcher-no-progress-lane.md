# Data Model - Watcher No-progress Lane

**Owner:** watcher posted-review dispatch fairness
**Store:** `data/watcher-no-progress-lane/`
**Source of truth:** `src/watcher-no-progress-lane.mjs`
**Runtime surface:** `src/posted-review-row.mjs`, `src/watcher-no-progress-lane.mjs`

## Purpose

`data/watcher-no-progress-lane/` holds one JSON ledger per `(repo, PR)` for
posted-review subjects that keep being walked without any durable review-state
progress. The watcher uses the ledger to demote unchanged subjects onto a
bounded slow lane while still rechecking them on a capped cadence.

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
| `decisionFingerprint` | string or null | Stable handler-decision fingerprint for the current head. This is carried forward across silent walks so the next usable decision can detect decision-only changes without treating missing handler output as a new baseline. |
| `decisionResets` | number | Count of decision-only resets already honored for the current head. A new head resets this to `0`; repeated decision changes are capped by the watcher so the lane cannot reset forever on decision churn. |
| `progressClass` | string | `self-resolving` or `operator-decision-required`. |
| `noProgressTicks` | number | Consecutive walked ticks with the same fingerprint. |
| `skippedTicks` | number | Deferred ticks counted toward the current backoff window. |
| `lane` | string | `active`, `slow`, or `operator-blocked`. |
| `firstNoProgressAt` | string or null | First observed timestamp for the unchanged series. |
| `updatedAt` | string or null | Last ledger update timestamp. |

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

- The lane only changes how often a PR is re-walked; it never changes review,
  remediation, or merge eligibility decisions.
- Missing, unreadable, malformed, legacy, or head-mismatched ledgers fail open
  toward walking the PR.
- Review-state progress is keyed by `fingerprint`. A change in
  `decisionFingerprint` for the same `fingerprint` is a decision-only reset:
  it clears `noProgressTicks`, `firstNoProgressAt`, and any prepared or emitted
  `stalledEvent`, but it does not report durable review-state progress to the
  caller. The watcher records the reset separately via `decisionResets`.
- Decision-only resets are capped per head by the watcher's configured
  decision-reset cap. Once the cap is spent, later decision changes keep the
  current no-progress series and are logged instead of resetting the lane
  again.
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
