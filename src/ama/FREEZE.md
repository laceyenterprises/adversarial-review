# FREEZE — v1 merge authority accepts live-PR unblocks only

**Status:** FROZEN until operator-approved v2 cutover. The
`v1-working-snapshot` tag remains the historical rollback floor.

## Change notes

2026-11-02 — MLR-03: narrow bug-fix-only to fixes that unblock a live PR and
require each exception and manual recovery to enter the MLR requirements ledger
with a synthetic scenario. No new guard, check, label or runtime gate is added.

## What is frozen

`src/ama/*`, `src/follow-up-*.mjs` (including `follow-up-merge-agent.mjs`),
`src/pollonce-phases.mjs`, daemon clean-merge
and their Agent OS closure coupling remain v1: bug-fix-only, with no new capabilities.
Until cutover, a v1 fix is allowed
only when it unblocks an identified live PR. Record the blocked condition,
existing owner/next action, why this narrow repair is needed and its validation
in the repair PR. General hardening and new capabilities belong in the v2 port.
Add no cap, gate, lease, parked state or new actor-coordination rule to v1.

The [v2 spec v1.0](../../docs/SPEC-merge-authority-v2.md) inherits strict mode,
address-every-finding, exhaustion closes by landing, the kill switch and operator
holds. A live unblock cannot waive those policies. New closure-path deadlines
must use the shared load-aware primitive with a finite ceiling.

## Every exception teaches v2

Every allowed live-PR fix adds a requirement row and scenario to Agent OS
`projects/merge-lane-rebuild/requirements.json`, with its disposition reflected
in `REQUIREMENTS.md`. Record the invariant, contract/failure reference, v1
mechanism, v2 obligation and stable scenario identity; preserve existing evidence.
MLR-05/06 inherit and exercise the synthetic scenario. This is documentation and
review discipline, not a new CI check, freeze guard, pre-push gate or override
label.

SRE takeovers, fresh-PR reopens and manual PR updates each require a row and
scenario too, even when no v1 code changed. Capture lost custody, budget/head
history, dirty-work salvage and post-merge ownership as applicable. A reopening
must not hide exhausted work or erase predecessor findings. Keep private incident
evidence in the Agent OS ledger; this repository uses synthetic fixtures only.
A recovery is not complete evidence for v2 merely because the live PR landed.

## Cutover and rollback

Follow [spec §5](../../docs/SPEC-merge-authority-v2.md#5-shadow-promotion-and-retirement)
and the [whole-lane canary procedure](../../docs/finalization-queue-canary-runbook.md).
Shadow records v2 decisions while v1 acts; only approved transfer with verified
writer drain and effect reconciliation changes authority. Main Loop 6 owns
promotion/rollback, BS4 launch/walk and operator/SRE the privileged host steps.
Workers do not edit live config, routing, services or restarts.

`v1-working-snapshot` and `v1-maintenance` are the documented historical rollback
floor; [BASELINE-v1-snapshot.md](../../docs/BASELINE-v1-snapshot.md) records their
baseline. Retain v1 for one release cycle after promotion under the existing
[expansion/retirement procedure](../../docs/finalization-queue-expansion-runbook.md).
The freeze is not permission to resume v1 feature work at promotion: deletion
and contract-location rebinding follow separate operator approval. Retain receipts
and requirements history through rollback and retirement.
