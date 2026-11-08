# SEV1 — Expired closer wake and missing reviewed head left a PR ownerless

- Report date: 2026-11-08
- Ticket: CLOSERWAKEEXPIRY-01
- Scope: hammer wake transport and AMA closer dispatch

## Impact

An open, conflicting PR had exhausted its comment-only review cycle. Its current
head came from a closer, and no reviewed head was available. Review could not
restart under the existing cycle budget, and neither closer recovery path
established an owner. Recovery ultimately required closing the PR and submitting
the change as a new PR. The supplied evidence establishes one affected PR;
fleet-wide incidence and the exact incident start time are unknown.

## Evidence and sequence

The anonymised recovery observation selected `dispatch-closer`. Its hammer wake
returned `duplicate` with `wake-already-recorded` for the same head and initial
attempt. The persisted admission deadline had passed about 8.5 hours earlier
without a closer starting. The AMA fallback then failed with
`amaAuditFilePath: headSha is required`. These are supplied observations, not
live measurements performed for this change.

Synthetic reproduction uses a PR with head `a` repeated 40 times, an exhausted
review cycle, conflicting mergeability and a null reviewed SHA. A separate wake
fixture advances its clock beyond the original five-minute admission window.
No production identifiers, worker records or credentials are required.

## Causes

The wake reservation treated a successfully delivered watcher notification as
permanent deduplication evidence. Delivery did not establish closer ownership,
but the requested record was never reconsidered when its admission deadline
expired. Repeating recovery therefore acknowledged an old notification without
creating new work.

AMA independently assumed every closer had a reviewed SHA. It used that value
for audit identity even though the wake carried the current head. Null review
provenance became an exception before fallback dispatch could acquire custody.
The combination exhausted all automatic owners while leaving the PR open.

## Correction

Expired wakes with complete evidence of absent or terminal closer ownership
reserve a deterministic successor attempt. Each successor preserves the old
record, links it through `supersedes`, and gets a fresh admission window.
Exclusive creation deduplicates simultaneous replacement requests. Live,
parked, quota-resuming, unresolved and unreadable launch evidence cannot prove
absence. The existing watcher remains the dispatch and merge authority.

AMA reconciles existing closer custody before refusing a new launch without
review provenance. A known current head returns `ama-reviewed-head-unavailable`;
missing both heads returns `ama-head-unavailable`. The closure-wait store
deduplicates an immediate alert identifying the PR/head and refusal reason.
Delivery errors stay structured and refund the alert reservation for retry.
The current head never substitutes for reviewed provenance or live-read metadata.

These changes do not restore review rounds or authorize a merge. Exact-head
review, findings remediation, strict mode, required checks, authoritative
terminal PR state, dispatch caps and lease admission keep their existing roles.
In particular, a terminal launch does not itself prove the PR merged.

## Regression evidence and limits

`test/hammer-wake-next-action.test.mjs` exercises expired absent/terminal owners,
fresh replacement deadlines, repeated expiry, concurrent callers, unexpired
deduplication, and live/unreadable descendant fences.
`test/ama-closer-dispatch-priority.test.mjs` exercises refusal with null review
provenance using snapshot/wake heads, preservation of pending/live/unreadable
custody, and named, deduplicated missing-head alerts.
Validation results are recorded in the
[change note](../changes/CLOSERWAKEEXPIRY-01.md).

Source validation is not a production recovery receipt. After ordinary
deployment, normal closure observation can confirm that an organically expired,
unacted wake produces a successor and then a closer receipt or named refusal.
No live dispatch, merge, reset, restart or ledger repair is part of this PR.
