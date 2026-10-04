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
clear the lane or request a wake. New receipts additionally require a parseable
`observedAt` no more than 30 minutes old and not in the future. Set
`ADVERSARIAL_OPERATOR_LABEL_WAKE_MAX_AGE_MS` to a positive millisecond window
to override this default; invalid values use the default. Existing reservations
continue recovery beyond the window. The bound prevents old persistent labels
from resetting a backlog after deploy or receipt loss; reapply an expired label
to create fresh intent. This age bound applies only to wake/reset observation,
not the existing label consumers' authorization rules.

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

1. The observer reads the event receipt. An existing `requested` receipt
   suppresses the reset and wake. New, recent events atomically create a
   `reserved` receipt with exclusive creation (`overwrite: false`). Receipts
   retain the same fields and outcomes; no store migration is required.
2. A reservation requests the wake **before** clearing the lane and alert
   debounce. Every attempt uses a new request ID
   `operator-label:<digest>:<attemptUUID>`; the reason retains
   `operator-label:<label>:<eventId>:<digest>` for audit. A wake failure leaves
   the lane and alert state untouched and retains the reservation for retry.
3. Once the wake reports `requested: true`, both reset operations must succeed
   before the receipt is atomically rewritten to `outcome: requested`. An
   alert-debounce clear failure prevents lane removal. The receipt records a
   successful request and reset, not watcher consumption or downstream work;
   wake transport consumption is documented in [Watcher Wake](watcher-wake.md).
4. A crash or reset/completion-write failure retains reserved intent. A retry
   gets a new wake ID so a watcher that consumed the previous attempt can
   consume the retry too. A crash after reset but before receipt completion
   can repeat the reset; the operations are idempotent. A malformed receipt
   logs a warning and recovers as reserved intent, overwriting it on successful
   completion. Other read/write failures remain errors, without deletion.
5. Each label is isolated: observation, receipt, wake, or reset failures log a
   warning for that label and do not prevent later labels from being processed.
   Discovery shares a per-PR/head/label promise cache with the retrigger
   consumers, including failed observations, for the duration of that pass.
   It still fetches present labels each tick to detect remove/reapply events
   with new event IDs; persistent cross-tick caching would hide those events.

## Retention

Receipts are retained indefinitely. There is currently no TTL sweep or
merge/close receipt cleanup, so the directory grows with accepted label events
even after their PRs leave discovery. Keep receipts for open PRs: removing a
`requested` receipt allows a still-recent present event to clear the lane and
re-arm alerts again. Any manual archive/removal must be restricted to PRs
confirmed merged or closed and no longer discoverable; automated retention is
a follow-up improvement, not part of the current contract.
