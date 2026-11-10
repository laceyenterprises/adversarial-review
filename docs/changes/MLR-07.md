# MLR-07

## Summary

Compose live next-action snapshots and legacy results with the existing
finalization ledger, shadow recorder, divergence taxonomy and report. v1 keeps
acting; shadow writes only app-owned finalization evidence.

## Interface changes

All finalization events accept an optional idempotency key. Shadow records
retain live lane/outcome provenance and a replay key. The existing read model
adds `promotionGate` (approved MLR-04 distinct-terminal arithmetic, plus MGQ
coverage) and `shadow` row/subject/error counts. The Agent OS companion exposes
`hq merge-lane shadow report [--json]` by forwarding this service model.

## Deployment and completion

Both repository PRs are required, linked through managed publication.
Existing reintegration must observe every declared companion merged before
ticket completion. Publication alone is not merged or activated evidence.
Main Loop 6/SRE owns the committed
[watcher reload and growth assertion](../deployment/mlr-07-shadow.yaml).
No live route, config, watcher or deployment state is changed by this worker.

## Verification

`node --test <file>` passed 173 cases across 11 scoped files, each run
individually through `cwp_dispatch.worker_validation` with a 600-second bound.
These cover ingestion replay, fold-error escalation, required-set uncertainty,
bidirectional divergences, distinct-subject arithmetic, observation wiring,
next-action parity and watcher claim CAS. Scoped ESLint and
`npm run typecheck:contracts` passed. The Agent OS companion's scoped wrapper
tests passed 17 cases; Ruff and the existing shellcheck gate passed.
Exact files/commands and managed mirror results are in the PR acceptance evidence.
No ledger SQL or Postgres store is changed; existing app-owned SQLite APIs
remain authoritative.
