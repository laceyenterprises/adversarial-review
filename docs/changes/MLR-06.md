# MLR-06 — Owned finalization workflow

## Summary

Implement the approved unamended v1.0 fold/executor contract for
`merge-lane-rebuild@a0b63d32143a`. Custody recovery requires complete durable WIP,
acknowledged successor handoff and completed existing teardown. One useful-work
budget survives heads and owners; kills reconcile effects without another debit.
Conflict repair follows immutable builder/hammer provenance. Merge-main after
hammer permanently leaves primary-change evidence unknown.

## Interface changes

The existing append API gains sourced workflow facts for anchored capped
load-aware deadlines, useful-work identities, controls/readback, salvage,
landing/PMA delivery and acknowledged pages. `projectWorkflow` exposes the NXA
read model from that decision. Runtime deadlines start at admitted; unknown
admission, HCP bounce and ambiguous effects retain recovery ownership.

Both queue and subject executors distinguish landing from finalization. A
matching PMA run/activation receipt is required. New custody invalidates evaluated
merge currency. The existing strict all-findings policy, exact-head checks,
operator holds, execution brake, branch policy and cost policy remain binding.
Final-remediation completion additionally requires explicit validated coverage.

Frozen actors add only MGQ-08 boundary calls. The existing daemon clean merge
and closer already use the lane router; CAPREHEAD, closure recovery and follow-up
merge-agent now preflight ownership. Agent OS rescue admission and park auto-retry
retain their original command behind `legacy-pr-write.mjs`, which resolves the
live whole repository/base then uses the existing route/issuance lock. The rescue
bridge preflights queue ownership before entering existing guarded AR seams.
DAG merged-PR reconciliation remains observational; its rescue mutations consume
these same guarded entry points. No new route selector or live route changes.

## Failure modes preserved

Current-head authorization, no phantom success after a lost mutation reply,
no takeover from age/PID alone, salvage before holder release, no kill/refusal
budget charge, no skip of findings when repair is unavailable, and no merged-as-live
claim. Page retries use the existing durable outbox and episode key; enqueued is
not acknowledged. SQLite remains the app's authority, with no session-ledger SQL,
new schema, config key, CI check, label or gate.

The first HCP scar query timed out. A subsequent scoped HCP query was available
and returned no records; local `hq hardening for` queries resolved the hammer
liveness, current-head verdict, post-merge activation and authoritative-terminal
contracts with empty record arrays. The dispatch's injected historical evidence
was retained as regression guidance, including truthful bounded offline tests
and quiet load-timeout diagnostics.

## Verification

Scoped `node --test test/<name>.test.mjs` commands run one file at a time through
`python3 -m cwp_dispatch.worker_validation --repo-root . --timeout-seconds 600 --command …`.
Observed passing files: workflow (15), executor (18), eligibility (20), ledger
events (10), fold (9), store (9), regression fixtures (6), custody (8), legacy
actor (6), queue merge (33), routing (17), executor lease (6), shadow recorder
(8), shadow store (10), closure recovery (39), CAPREHEAD (59), follow-up merge
agent (249 passed, one skipped), and fast merge (47).

`node --test test/finalization-simulator.test.mjs` passes 20 tests: all 234
scenario/load combinations at x1/x3/x6 plus 4,680 seeded scenario executions.
It retains MLR-05's original failing baseline and independent known-bad-policy
oracle. Scoped ESLint reports zero errors (25 existing follow-up warnings);
`npm run typecheck:contracts` and
`bash demo/research-finding-walkthrough.sh` pass, including three byte-stable
offline transcript deliveries.

No session-ledger SQL or Postgres schema changes occur; SQLite app-store
round trips and routing are exercised directly. No full worker-pool, Sentinel,
main-catchup or PMV suite is run. Managed push/CI results and unavailable live
activation evidence are recorded separately in the PR.

## Deployment handoff

MLR-07 owns organic shadow evidence and MLR-08 owns operator-authorized deployment,
whole-lane canary and read-only activation receipts. SRE must verify deployed and
loaded build, fresh custody producer facts, working exact-holder/salvage/teardown,
PMA run/activation and existing pager composition plus organic consumer progress.
No worker restart, config flip, lane transfer or live fixture is performed here.
