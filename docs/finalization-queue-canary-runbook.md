# Whole-lane queue canary and recovery rehearsal

Owner: rollout operator. Applies to the v2 finalization port and the existing
per-lane routing selector. Source publication, deployment, observed capability,
and operator approval are separate milestones. A worker publishes the reviewed
implementation PR and stops. Only the named operator promotes, rolls back,
restarts system services or approves rollout. Retain frozen legacy execution
for one release cycle. Use the normal cross-model convergence path; no admin
merge for the gate-keeper.

This procedure extends the [executor promotion runbook](finalization-executor-promotion-runbook.md)
and [routing procedure](RUNBOOK-ama-closure.md#per-lane-finalization-routing-mgq-08).
Their shadow prerequisites, eligibility checks and emergency execution brake
remain in force. There is no new check, approval label or automated promotion
gate. The only routing setting is
`roles.adversarial.merge_authority.lane_routes`.

## Prepare a reviewable rollout record

Take the lane identity from private operator inputs. Public examples use only
`example/review` / `main`; never copy real rollout inputs into service artifacts.
Retain the rollout record, probe JSON, shadow report, receipts, process/request
inventory, service observations and isolated transcripts durably in the existing
operator evidence location. Record timestamps, observer identity and source refs
for every result, including failures and unknowns.

Before activation, the operator:

1. Verifies the merged service revision and required coordinated schema deployment.
   Inspect the real store/migrations and resolved adapters. Identify the actual
   runtime account, service domain, loaded process revision/build and cached
   config generation. A checkout SHA or probe digest alone does not identify an
   already-running watcher. Confirm current incident repairs independently.
2. Inventories installed clean-admission and remediated-handoff producers, queue
   consumer/pump, exact-head checks policy, entitled per-operation credential
   refresh, identity/attestation, merge, delivery, shadow and drain/reconciliation
   adapters. Record actual identities, source refs and process build. The MGQ-08
   routing boundary **does not install a live queue pump or these adapters**.
   Uncomposed production is pending: use the existing operator escalation route
   and obtain reviewed composition before a selector change.
3. Runs the existing `finalization shadow-report --days 7 --json`. Retain its
   coverage, organic head movement/exhaustion evidence and dispositions for both
   directions of divergence. Resolve blockers through the existing triage path;
   fixture results cannot replace organic shadow readiness.
4. Inspects whole-lane queue status, unresolved operations, pending deliveries,
   original patience/deadlines and existing legacy closer leases. Report stale
   deadlines, running-build/config mismatch, missing producer, live legacy writer
   or unknown identity **before activation**. Never infer drain from PID death,
   lease expiry, zero registered writers or an old-head read.
5. Establishes observation tolerances for service time, oldest ready age,
   arrivals versus merges/returns and infrastructure parking in the rollout
   record. Use measured capacity; serial execution does not promise to drain
   arrivals faster than checks complete. Tolerances are operator observations,
   not new runtime policy or configuration.

## Transfer, change selector and bounce

Use the runtime-owner `createLaneRoutingController.transfer` composition port,
not manual DB edits. Its inputs are the lane, observed `expectedGeneration`,
desired resolved config, trusted drain/reconciliation and return adapters, and
an absolute bounded deadline. It is not a standalone activation CLI.

1. Stop new legacy writers for the selected whole lane using the existing
   operator drain procedure. Inventory old binaries, independently running
   closers, shell helpers, process trees and remote requests. Other lanes retain
   their routes. Keep the reviewed desired selector unapplied during transfer.
2. The transfer takes the shared issuance lock, increments the route fence and
   parks the owner before awaiting drain. Prove quiescence and reconcile **every**
   registered/old writer and unresolved push/merge intent against authoritative
   remote state. Materialize successful publication or candidate-specific merge
   receipt and delivery intents before settlement. Unknown results retain a
   pending transition with both routes fenced. Escalate; never clear an intent,
   delete a lock or skip a return to force progress.
3. Once transfer succeeds, apply the one reviewed whole-lane selector change to
   `queue-v2`. A temporary cached-config/durable-route mismatch refuses writes.
   Do not use the emergency execution brake as the route selector.
4. Follow the existing registered **system-service** restart path: identify the
   actual runtime owner, system domain and registered entries via the deployment
   operator's `scripts/os-restart.sh` procedure, then have that operator bounce
   the affected watcher/follow-up services. Do not edit plists or substitute a
   user-domain restart. No worker runs this step.
5. Re-observe the loaded writer build, PID, owner/fence, config generation,
   effective executor and zero legacy inventory after the bounce. Verify the
   required producers and identity surfaces under that generation. Source
   deployment without these observations is pending. Resume organic admissions
   only after exclusive ownership is proven.

## Observe organic traffic

From the deployed review-service checkout **under its runtime owner**, invoke
through the existing load-aware bounded command supervisor (5 seconds nominal,
30 seconds finite ceiling):

```sh
node src/finalization/queue-probe.mjs --capability canary --json
```

The existing probe uses a 1-second nominal SQLite/Git read wait capped at 5
seconds, scaled once. No new polling or wait is added by the canary reader.
Do not scale owner expiry, observation freshness or an already-scaled deadline.
The command cannot write schema, claim a lane, flip a route or create evidence.
It is a post-deploy observation assertion, never a new blocking check.

The operator maintains the local observation artifact described in the
[data contract](data-model/finalization-queue-canary.md), preserving prior versions.
Without it, organic evidence is pending. Fresh process/inventory/producer/identity
observations last at most five minutes. Historical canary entry and rehearsal
records stay durable; refresh runtime evidence from actual observations.

Observe at least **20 unique actual queue entries**, including both zero-finding
and remediated admissions, over a declared window. Retain entry/ack IDs, immutable
source signatures/dispositions, original deadlines, publication proofs, exact
candidate/base checks, final decisions, merges/returns/parks and delivery receipts.
Record every admission and current outcome denominator, service sample count and
window duration. Keep missing evidence pending; never inject production traffic,
failures or synthetic pages to satisfy a count. Read whole-lane `queue status`
and individual `queue receipt` alongside sample metrics.

The ticket's observation predicate is:

```jq
.capabilities.canary.available == true and .runtime.build != null and
.rollout.canary.entries >= 20 and .rollout.canary.clean > 0 and
.rollout.canary.remediated > 0 and
.rollout.canary.recoveryComplete == true and
.rollout.canary.rollbackRehearsed == true
```

Also inspect `status`, `pending`, `preflight`, outcomes and pending delivery;
the predicate alone does not authorize promotion or certify process liveness.
Capability availability means the deployed read model/schema/adapters resolve,
not that rollout is complete. A test fixture cannot establish live success.

## Isolated recovery evidence

Run all faults against disposable stores/worktrees with fake GitHub, broker,
network and pager boundaries. Live observation uses organic traffic only.
For **each** ID below record `passed`, `failed` or `unknown`, timestamp, scenario,
expected invariant, actual outcome/denominator, tested runtime build and durable
transcript reference. Recovery/rollback results must match the observed build.
The projection requires one sourced isolated result per ID; missing/duplicate
or future results remain unknown. A total test count is insufficient.

| Recovery IDs | Expected outcome and existing focused fixture owner |
|---|---|
| `owner-restart`, `terminal-lease` | Preserve original phase/candidate/deadline; prove drain before takeover; terminal closer resources cannot block future work. `finalization-queue-owner`, `ama-closer-launch-liveness` tests. |
| `duplicate-wake`, `lost-ack` | One durable admission/ack and no duplicate closer; replay after commit/restart returns the same key. `finalization-queue-handoff`, `finalization-queue-admission` tests. |
| `external-push`, `base-advance` | Author updates survive expected-old-head protection; outside base movement invalidates readiness under original patience. `finalization-queue-rebase` and `finalization-queue-checks` tests. |
| `live-hold`, `unknown-labels` | Both park without mutation, recovery revalidates and joins tail. `finalization-queue-admission` tests. |
| `permission-denied` | Park with permission/author-notice diagnostics, no ambient credential fallback. `finalization-queue-rebase` tests. |
| `conflict`, `proof-failure` | Return to closer with retained source/proof; never repair content mechanically. `finalization-queue-rebase`, `finalization-queue-rebase-proof` tests. |
| `red-checks` | Completed red returns for repair; never merge green subset. `finalization-queue-checks` tests. |
| `missing-checks`, `hung-checks`, `unreadable-checks` | Park/release/page through the fake bus at the original deadline, no closer budget charge. `finalization-queue-checks`, `finalization-queue-check-transport` tests. |
| `token-expiry`, `refresh-outage` | Entitled refresh per operation, retain still-valid credentials on early refresh failure; bounded outage parking. `finalization-queue-check-transport` tests. |
| `ambiguous-push`, `ambiguous-merge` | Retain intent until proved drain and candidate-specific authoritative reconciliation; no duplicate remote mutation. `finalization-queue-rebase`, `finalization-queue-merge`, `finalization-queue-routing` tests. |
| `action-retry` | Stable-key delivery survives lost receipt/restart without another merge or action. `finalization-queue-merge` tests. |

## Rollback and reactivation

Rehearse the complete sequence in isolated fixtures before live cutover; retain
its transcript. The named operator later uses the same procedure for a reviewed
live rollback, observing organic traffic without deliberate live faults.

1. **Fence, drain, reconcile:** stop queue issuance under the shared transfer
   boundary; invalidate old owners before waiting. Prove all process/request
   quiescence; reconcile every push/merge and materialize receipts/delivery.
2. **Return and transfer:** retain source signatures, proofs, deadlines, terminal
   receipts and outbox. Return every unfinished **and parked** entry through the
   durable `route-return:<entryId>` key. Lost ack retries the same key after
   restart. No legacy ownership until every durable ack is present. A merged or
   closed subject stays terminal; no reviewer or closer is launched for it.
3. **Reverse selector, bounce, verify:** after transfer, reverse only this lane
   to `legacy`, use the registered system-service restart path, then verify new
   process/config/owner and no queue writer. Cached queue workers remain fenced.
4. **Reactivate:** inventory/drain legacy again, reconcile requests, use the new
   expected route generation for transfer, apply the reviewed queue selector,
   bounce and verify all writer/producer/identity surfaces again. Returned work
   follows normal fresh admission; never resurrect a terminal entry or reset
   patience by editing it.

Record the ordered `CANARY_ROLLBACK_STEPS` from the data contract and actual
no-overlap, lost/duplicate handoff and pending-return counts. A pending drain or
ack leaves both routes fenced and is an operator recovery result, never a reason
to enable both. In an incident requiring only a mutation stop, use the existing
emergency execution brake and its established operator procedure independently.

After the implementation PR merges, durable organic observations and the isolated
exercise ledger are reviewed by the named operator. Record explicit approval
through the existing rollout completion owner. Merging source or satisfying JSON
does not complete operator approval. This procedure installs no live consumer,
service restart, automated promotion or new CI/smoke action.
