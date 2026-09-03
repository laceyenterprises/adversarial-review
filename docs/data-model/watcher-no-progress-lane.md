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
- Stalled-event delivery is prepare-and-acknowledge. The watcher may persist
  `stalledEvent.emitted=false` before calling the event sink, but it flips the
  value to `true` only after the sink resolves successfully. A transient sink
  failure or process exit during delivery therefore retries on a later eligible
  walk instead of permanently suppressing the operator signal.
- Once `stalledEvent.emitted=true` is recorded for the same head and
  fingerprint, later unchanged ticks do not re-emit the stalled event.
- Merge and close cleanup removes the per-PR ledger once no future walk is
  possible.
