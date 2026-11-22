# REPAIROWNERSCOPE-01 — Repair owners must be visible to the review app

## Summary

The watcher reads a repair reservation's owner launch through the review app's
dispatch-read grant. The producer shows a launch only when its dispatch project
and repository match an operator grant entry exactly. Repair owners are
submitted under projects the grant did not name, so the key and launch-id reads
returned an empty, grant-filtered reply. An empty filtered reply cannot prove
absence, so the owner stayed `unknown`, no publication could bind, and the
reservation held the PR (`repair-reservation-owns-pr`) on every pass.

## What changed here

- `observeRepairOwner` offers the dispatch project named by the matched owner
  launch's own record (`project_ref`) and refuses an owner whose record
  contradicts a stored scope.
- `reconcileRepairOwner` records that project once, as `dispatchProjectRef`
  with `dispatchProjectDerivedAt`, for a legacy reservation whose owner resolved
  to `live` or `terminal`. An unresolved owner derives nothing. It keeps its
  existing overdue `repair-owner-unproven` escalation. Reads that fail stay
  `unknown`.
- `repairReservationOwnsPr` is the watcher's existing hold predicate, now a
  named export so tests can assert the gate releases at a published head.

New reservations record their scope at reservation through the helper's existing
ninth argument, which the dispatcher now supplies. The producer-side change
(echoing `project_ref` on a readable launch) and the grant declaration live in
the dispatcher's repository; an older producer omits the field and no scope is
derived.

## Composition with REPAIROWNERABSENT-01

That change certifies positive absence for a legacy unscoped conflict reservation
through a repository-only read. This change makes existing owners visible and
records a scope. Both edit `observeRepairOwner` and the reconcile mutation in
different statements: a derived scope turns a reservation into a scoped one, so
its absence is read through the scoped path.

## Verification

`test/repairownerscope-01.test.mjs` runs a fake producer that applies the
(project, repository) visibility rule behind the real dispatch-read client. It
covers a closer-only grant (owner unknown, never absent), a covering grant
(terminal and live), publication binding and gate release at a moved head,
one-time scope derivation, no derivation for an unresolved owner, failed reads,
and contradicting or malformed project records.
