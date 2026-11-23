# REPAIROWNERSCOPE-02 — An overdue repair owner names what releases it

## Summary

A repair reservation holds a PR's review gate until its owner launch publishes or
ends. The watcher reads that owner through the review app's dispatch-read grant.
An owner launched under a project the grant does not cover reads as `unknown`.
After ten minutes the existing overdue path (`repair-owner-unproven`) pages once
and projects operator custody. The page and next-action did not say which grant
was missing. An unscoped legacy reservation could not say anything more specific,
so its hold looked the same as any unreadable owner.

## What changed here

- `repairOwnerOperatorAction(epoch)` (new export) returns the action for an
  overdue unknown owner:
  - `grant-owner-dispatch-read`, with the project, when the reservation records
    a dispatch scope. The read the app lacks is exactly (that project, the PR's
    repository).
  - `establish-owner-dispatch-scope` when no scope is recorded. The owner launch
    is unreadable under every granted project. The operator must find that
    launch by its idempotency key and grant its (project, repository) pair. A
    fenced legacy or CWP conflict reservation can instead be retired with
    `bin/retire-legacy-repair.mjs`.
- The `repair-owner-unproven` page text appends that action. It names the
  project and repository for a recorded scope and never includes the owner key.
- Next-action's `R02-hold` row for `repair-owner-unproven` adds evidence refs
  `operator-action:<action>` and `repair-owner-scope:<project|unrecorded>`. TTM
  appends the action to its operator reason. Reason codes, rows, deadlines and the
  one-page-per-reservation deduplication are unchanged.

A scope is still recorded only from the owner record's own `project_ref`. The
dispatch producer authorizes a scoped read on that value alone, so a scope taken
from any other launch field would put the reservation on a read that can never
match.

## Unchanged behaviour, now covered by tests

Once the owner is readable and terminal at a moved head, a publication attested
by the owner or its retry records `publicationHead`, the gate releases on that
pass, and the next admission binds `reviewHead`. A terminal owner whose head
moved without its produced-head attestation retires custody
(`foreign-head-after-terminal`). An attestation that stays unproven keeps the
existing `repair-publication-unproven` safety fence.

## Verification

`test/repairownerscope-02.test.mjs` uses synthetic fixtures behind the real
dispatch-read client and closure-wait store. It covers a declared handoff-project
owner that escalates naming the exact pair and then resolves, an unscoped legacy
reservation that pages once at the deadline and names the action, and the two
terminal-owner releases.
