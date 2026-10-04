# Data Model - Operator Label Wakes

**Owner:** watcher operator-label wake observation
**Store:** `data/operator-label-wakes/`
**Source of truth:** `src/operator-label-wake.mjs`
**Runtime surface:** `src/pollonce-phases.mjs`, `src/adapters/operator/github-pr-label-controls/index.mjs`, `src/watcher-no-progress-lane.mjs`, `src/watcher-wake.mjs`

## Purpose

During PR discovery, `processReviewSubject` calls `observeOperatorLabelWakes`
before label consumption and no-progress lane admission. The observer accepts
present `merge-agent-requested`, `retrigger-review`, `retrigger-remediation`,
`address-all-findings`, and `operator-approved` labels only when the operator
adapter returns an applied, attributable event with an event ID, timestamp,
and revision matching the current head. Missing or stale evidence does not
clear the lane or request a wake.

Accepted events clear the whole per-PR no-progress ledger and operator-decision
alert debounce state, independently of the capped handler-decision resets.
The wake requests a prompt re-walk of that PR head; normal review, remediation,
and merge admission guards still apply. The wake itself does not consume the
label or authorize a dispatch. In particular, `address-all-findings` currently
has no watcher-side action consumer in this repo beyond this wake observer.

## Files and fields

Each receipt is `data/operator-label-wakes/<digest>.json`, where `digest` is the
hex SHA-256 of `JSON.stringify([repo, prNumber, control.eventId])`. The key uses
the event ID, not the label name or head; a fresh label application with a new
event ID gets a new receipt.

Receipts have no schema-version field. They contain `{ repo, prNumber, label,
...control, outcome }`, retaining the operator adapter's control evidence:

| Field | Type | Contract |
|---|---|---|
| `repo` | string | Repository slug used in the receipt key and wake. |
| `prNumber` | number | PR number used in the receipt key and wake. |
| `label` | string | One of the five labels listed above. |
| `applied` | boolean | `true` for accepted adapter evidence. |
| `observedRevisionRef` | string | Current head SHA at acceptance. |
| `actor` | string | Attributable label-event actor. |
| `eventId` | string | GitHub event ID or node ID; deduplication identity. |
| `observedAt` | string | Label-event timestamp, not receipt creation time. |
| `reason`, `roundCap` | string, number; optional | Additional control metadata if supplied by the adapter. |
| `codeScopedAt`, `codeScopeEventId`, `codeScopeEventKind` | string; optional | Adapter evidence for code-revision scope when present. |
| `outcome` | string | `reserved` or `requested`, as described below. |

## Lifecycle and recovery

1. The observer atomically creates a `reserved` receipt with exclusive
   creation (`overwrite: false`). An existing `requested` receipt suppresses
   the lane reset and wake for that event on subsequent ticks. Label-event
   observation still runs before the receipt check.
2. A new reservation or an existing reservation left by a crash clears the
   lane and alert debounce, then calls `requestWatcherWake` with the stable
   request ID `operator-label:<digest>` and reason
   `operator-label:<label>:<eventId>`.
3. Once the wake reports `requested: true`, the observer atomically rewrites
   the receipt to `outcome: requested`. This records a successful wake request,
   not watcher consumption or successful downstream work; wake transport
   consumption is documented in [Watcher Wake](watcher-wake.md).
4. A crash before completion leaves `reserved` intent for the next observation
   to retry with the same request ID. A reset, wake, or completion-write failure
   removes the receipt and propagates the error; discovery logs it and a later
   tick can retry while the label and current-head evidence remain valid.
   Existing receipts are read on the exclusive-create collision path; a read
   or parse failure propagates without deleting that receipt.

## Retention

Receipts are retained indefinitely. There is currently no TTL sweep or
merge/close receipt cleanup, so the directory grows with accepted label events
even after their PRs leave discovery. Keep receipts for open PRs: removing a
`requested` receipt allows the still-present event to clear the lane and
re-arm alerts again. Any manual archive/removal must be restricted to PRs
confirmed merged or closed and no longer discoverable; automated retention is
a follow-up improvement, not part of the current contract.
