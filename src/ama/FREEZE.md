# FREEZE — v1 merge authority is bug-fix-only

**Status:** FROZEN (bug-fix-only) as of the `v1-working-snapshot` tag.

This directory (`src/ama/*`), together with `src/follow-up-merge-agent.mjs` and
the daemon clean-merge path (`src/ama/daemon-merge.mjs`), is the **v1 merge
authority**. It is **frozen**: bug fixes only, **no new capabilities**, until
Merge Authority v2 is promoted out of shadow mode.

The freeze runs from the acceptance of the v2 finalization design until v2
cutover, per
[`docs/SPEC-merge-authority-v2.md`](../../docs/SPEC-merge-authority-v2.md)
(scope note, lines near the top: *"v1 merge authority (`src/ama/*`,
`follow-up-merge-agent.mjs`, daemon-clean path) is **frozen** — bug-fix-only,
no new capabilities — from the moment this design is accepted until v2 is
promoted."*).

## What "frozen" means here

- **Allowed:** fixes for correctness/SEV bugs in the existing v1 behavior
  (the failure family catalogued in `docs/SPEC-merge-authority-v2.md` §1).
- **Not allowed:** new merge-authority capabilities, new coordination rules
  between actors, or behavior changes that are not bug fixes. New capability
  work belongs in the v2 finalization port (Phase 3 of
  [`docs/SPEC-adversarial-review-v2-app-architecture.md`](../../docs/SPEC-adversarial-review-v2-app-architecture.md)),
  not here.

## Rollback floor

`v1-working-snapshot` (tag) and `v1-maintenance` (branch) are the documented
rollback floor for every later v2 phase gate. See
[`docs/BASELINE-v1-snapshot.md`](../../docs/BASELINE-v1-snapshot.md) for the
snapshot commit, the maintenance branch, and the green fixture-e2e baseline
recorded at the tag.

Merge Authority v2 is cut over via shadow mode (companion spec §5): v2 ingests
live events and logs decisions while frozen v1 keeps acting; promotion is
operator-approved after the shadow-diff gate. Only at v2 promotion does this
freeze lift.
