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
[watcher reload and growth assertion](https://github.com/laceyenterprises/agent-os/blob/main/modules/worker-pool/post-merge-actions/mlr-07-shadow.yaml).
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

## Review remediation

Live fact ingestion now compares the latest sourced fact before appending, with
transition keys that preserve changed values and returns to earlier values.
Poll timestamps do not grow the fact ledger or reset its anchors. The observer
reuses one app-root SQLite handle and caches ledger setup per connection.
Comparison telemetry remains per observation. Closure consumers supply configured
required contexts even without branch protection, unioning readable protection
contexts. Lightweight snapshots may omit domains; explicit failed/unknown or
incomplete refreshes of settled evidence still escalate. SQL and fallback report
coverage exclude synthetic live and queue rows, including the window-presence
condition. The ledger/shadow data-model docs, catalog and v2 spec describe these
contracts. Existing lifecycle declarations and smoke promises are unchanged;
the affected closure state projections remain byte-identical.

The final sandboxed run passed 396 targeted tests across nine files using
`node test/run-tests.mjs` (live ingestion, shadow store/report, next-action
adapters, closer/daemon next-action, shadow consumer, watcher claim loop and
closer lease finalization). This includes both borrowed and daemon-owned
connection schema-reuse regressions. Repository lint passed with zero errors
(152 existing warnings); scoped ESLint, `npm run typecheck:contracts`,
`node scripts/validate-data-model-catalog.mjs` (93 entries) and
`bash demo/research-finding-walkthrough.sh` passed. `git diff --check` passed.
No full local test suite or CI configuration change was made.

## CI fixture remediation

Summary: reproduced all five current-head CI failures in the canary/cutover
tests. Their positive fixtures supplied elapsed coverage but no sourced organic
terminal outcomes for MLR-04's approved volume criterion. A shared offline
fixture now supplies 50 distinct terminal subjects. Both suites also verify
that otherwise complete rollout evidence remains pending at 49 subjects.

Interface changes: none; production behavior, store shapes, operator policy,
state declarations and smoke promises are unchanged.

Verification: the bounded targeted runner passed 60 tests across
`finalization-queue-canary`, `finalization-queue-cutover`,
`finalization-live-shadow`, `finalization-shadow-report` and
`finalization-shadow-store`. `npm run lint` passed with zero errors and 152
existing warnings. `npm run typecheck:contracts`,
`node scripts/validate-data-model-catalog.mjs` (93 entries),
`bash demo/research-finding-walkthrough.sh` and `git diff --check` passed.
No full local suite or CI configuration change was made.
