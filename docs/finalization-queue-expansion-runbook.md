# Whole-lane queue expansion and legacy retirement

Owner: rollout operator. After the implementation PR merges and the canary has
explicit operator approval, Main Loop 6 transfers the second entire lane supplied
by private operator rollout inputs. Public examples use `example/review` / `main`.
Source publication and even a merged PR do not complete operator approval.
Workers publish the implementation PR and stop; they never activate, restart,
self-approve or record completion.

Follow the [canary walkthrough](finalization-queue-canary-runbook.md) and
[existing routing transfer procedure](RUNBOOK-ama-closure.md#per-lane-finalization-routing-mgq-08)
for preflight, fence/drain/reconcile, reviewed selector, registered system-service
bounce, organic observations and isolated rollback/reactivation. Preserve existing
shadow readiness, eligibility and the independent emergency execution brake.
Change exactly one lane record in `roles.adversarial.merge_authority.lane_routes`;
other repositories/bases retain their existing routes. No new configuration,
check, label, blocking probe or promotion gate is introduced.

## Runtime composition and writer inventory

Before deployment or a watcher bounce, inventory both configured and durable
`queue-v2` lanes, including existing canaries. Production does not install
`dispatchContext.queueCloser` automatically. Without that composition, **all**
closer remediation on an already migrated lane refuses with
`queue-closer-composition-unavailable`, including ordinary findings repair that
previously used a legacy prompt. Install the reviewed composition before the
bounce, or complete the existing operator-directed rollback procedure first;
do not remove a selector to bypass durable ownership. This source change does
not authorize a bounce or a lane change.

Before changing the selector, verify the installed runtime composition:

| Invocation | Queue lane behavior | Legacy/rollback behavior |
|---|---|---|
| `maybeDispatchAmaCloser` | Resolve durable route before legacy recovery. A complete handoff observed before the final dispatch recheck suppresses another closer, including after restart. Recheck under the existing per-PR dispatch single-flight after asynchronous reads; a later commit can still race launch. New remediation uses `templates/queue-closer-prompt.md`, with no rendered lease/CI/rebase/merge procedures. | Read-only route preflight avoids lane locks, schema convergence and writer intents on legacy lanes. Existing prompt, dispatch/closer leases, incident repair and merge procedures remain. |
| Closer completion | `createQueueCloserComposition` wraps the trusted handoff service, confirms the matching committed ack and requires idempotent resource release before returning success. Failed release retries the same ack. | Existing terminal/retry handoff remains; it is not a queue ack. |
| Clean daemon and certified closer recovery | Queue admission only. Read the actual stored full receipt/ack before reporting queued; no legacy lease, checks wait or merge click. | Existing daemon/hammer eligibility, reservation, bounded repair and merge paths remain. |
| Rendered legacy merge command | Existing route/issuance boundary refuses the old writer. Independently running old closers must also be drained, including their publication helpers and requests. | Existing entitled metered command is retained. |
| Queue owner / subject executor | Existing lane generation, operation intents, shared issuance lock, exact-head checks, expected-head merge and durable delivery remain sole merge execution authority. | Existing transfer/return acknowledgement protocol owns rollback. |

The composition root supplies `dispatchContext.queueCloser` from
`createQueueCloserComposition({rootDir, handoffService, handoffInstructions, releaseResources})`.
Migrated launches use the existing `branch-push` / `push` completion contract;
legacy launches retain `decision-only` / `terminal-audit`.
`handoffInstructions` names the installed sanctioned tool/surface for that run,
not an invented transport or a file of self-certified evidence. Its tool must
invoke this composition's `handoff()` with the dispatch's `routeGeneration`
and pass its caller's original absolute deadline to the existing bounded handoff service. Submission and resource release hold the existing lane issuance lock; stale
dispatch generations and rollback refuse submission. Resource release must be
idempotent and actually release the worker slot and closer lease. Never substitute
a no-op release. Queue admission callbacks must use the trusted clean/handoff
services; replies are independently joined to the actual store. Missing
composition refuses dispatch/enqueue without legacy fallback. These ports do not
install a production pump, tool endpoint, evidence reader, credentials or service.
Uncomposed migrated lanes stall through the existing escalation route and
require reviewed composition before deployment. Queue prompts render once after
scratch allocation; operator-composed instruction placeholders remain literal.
Missing prompt inputs return `queue-closer-prompt-input-missing`, release the
unsubmitted closer lease and remove unused scratch/prompt artifacts.

Legacy preflight reads the selector and, when present, the durable route through
a read-only SQLite handle. An absent DB/routing schema or a stable legacy route
proceeds without schema convergence, lane flock or writer journal. Configured or
durably migrated lanes and pending transitions enter the existing locked routing
boundary. Unreadable durable ownership returns `queue-closer-route-unavailable`;
it cannot safely be assumed legacy. A subsequent transfer can race this read,
so authoritative writer checks remain at the merge/publication boundaries.
Certified recovery always retains `withDaemonMergeReservation`, regardless of
the prepared route snapshot.

Remediation may edit, validate locally, adjudicate all findings and publish its
remediated head with entitled expected-old-head protection. Terminal adjudication
remains final without a new model judgement. Only the queue mechanically rebases,
waits remote CI and merges. Returned same-head entries owe fresh remediation and
admission; a historical ack cannot hide a return. A terminal/parked acknowledged
entry suppresses duplicate wakes that observe its ack. Handoff commits take the
lane flock, not the dispatcher's PR intent lock. An ack committed after the final
recheck can still race lease acquisition and HQ submission; this is not an atomic
handoff/launch fence. Remediation publication must retain expected-old-head
protection, and the operator must drain in-flight closers before transfer.

## Operator expansion procedure

1. Retain explicit canary approval and the complete canary evidence record.
   Verify the merged revision, actual installed adapters, running owner/build and
   writer census; a checkout or probe digest alone is insufficient.
2. Stop new legacy dispatch for the second whole lane using the existing drain
   mechanism. Inventory and drain every old closer, helper process tree and
   in-flight publication/merge request. Reconcile all outcomes, receipts and action
   intents. Invoke the existing transfer port with observed route generation and
   trusted drain/return adapters. Unknown drain or operation outcomes leave both
   routes fenced. Never infer quiescence from an expired lease or empty DB count.
3. After transfer, apply the single reviewed selector change. The named operator
   uses the registered runtime-owner/system-domain `scripts/os-restart.sh` path
   from the deployment procedure to bounce watcher/follow-up and affected queue
   services. Verify every loaded build/config, owner/fence, resolved producer/tool,
   identity and exclusive writer inventory after bounce. Workers never run this.
4. Observe organic clean and remediated entries. Retain exact-head admission,
   publication/check/base, merge and delivery receipts. Observe the actual worker
   slot and closer lease release after ack and before the first queue CI phase.
   Compare service time/sample counts, oldest ready age, arrivals, merges, returns
   and infrastructure waits with recorded operator tolerances. Do not promise that
   a serial queue exceeds arrival rate or manufacture production traffic/faults.
5. Rehearse ordered rollback/reactivation on isolated fake boundaries at the
   deployed build. For an operator-directed live rollback, first fence, drain and
   reconcile; retain all receipts/outbox/signatures and acknowledge each pending
   or parked entry once using stable `route-return:<entryId>` keys. Reverse only
   that lane's selector after proven transfer, then bounce/verify through the same
   registered path. For reactivation, drain legacy afresh and transfer with the
   new generation before forward selector/bounce/verification. No dual writers,
   lost/duplicate handoffs, merge or action are acceptable. A pending ack keeps
   both routes fenced. Retain legacy code/regression fixtures for one release
   cycle; deletion needs a separate reviewed change.
6. Retain the projection, receipt/process/resource observations, metrics, rehearsal
   transcript and explicit operator decision in the existing private rollout
   evidence location. Main Loop 6 records live outcomes; BS4 records approval only
   after explicit operator approval. Neither PR merge nor JSON grants approval.

Under the deployed runtime owner, from the deployed review-service checkout,
invoke through the existing load-aware supervisor with a 5-second nominal wait
and a finite 30-second ceiling:

```sh
node src/finalization/queue-probe.mjs --capability cutover --json
```

The probe uses existing SQLite/Git read patience (1 second nominal, 5 seconds
maximum, scaled once). No new polling is added. Do not scale freshness, owner
expiry or an already-scaled deadline. Maintain the private
[cutover observation artifact](data-model/finalization-queue-cutover.md) atomically
from actual observations; the command is read-only and cannot create it.

```jq
.capabilities.cutover.available == true and .runtime.build != null and
.rollout.expansion.route == "queue-v2" and
.rollout.expansion.legacyWriters == 0 and
.rollout.expansion.confirmedReceipts > 0 and
.rollout.expansion.closersReleasedBeforeCi == true
```

Inspect `status`, `pending`, every writer and closer observation, rejected
receipts, delivery backlog, metrics and denominators alongside this predicate.
Missing organic receipts, releases, process evidence or composed adapters is
pending. Read whole-lane status for backlog outside the sample. This is a
post-deploy observation assertion, not an automated promotion or blocking check.

## Offline source validation

The deterministic late-ack schedule was run against the unfixed dispatcher,
an intermediate implementation checking only before asynchronous reads, and the
final implementation rechecking under the existing per-PR dispatch single-flight.
Each used twenty independent disposable stores and fake dispatch/network boundaries.
Unfixed: 20/20 duplicate closer launches after ack. Intermediate: 20/20 duplicates.
Final: 20/20 consecutive confirmed acknowledgements, zero duplicate launches
**in that schedule**, where the ack commits before the final recheck. These
fixtures do not establish zero duplicates for commits after that recheck; that
remaining race is described above.
The final suite also verifies actual queue prompt dispatch without rendered legacy
procedures, enqueue-only daemon receipt confirmation, generation refusal,
in-flight legacy drain and lost rollback acknowledgement. Focused closer
regressions also verify legacy dispatch under a held lane flock with byte-identical
DB contents, no legacy writer-row growth, no schema creation on old installations,
structured unreadable-route refusal, literal instruction placeholders through
actual dispatch, and missing-input refusal with no launch or retained pending lease.
Sibling sites inspected:
clean daemon, certified closer recovery, shell merge boundary, subject executor,
validated handoff release, routing/owner issuance and receipt/outbox replay.

Read-only cutover fixtures include a receipt produced by the actual queue merge
service using disposable Git repositories and fake GitHub/identity/delivery calls.
They pin missing/stale/foreign/duplicate/late closer and runtime observations,
corrupt receipts and byte-identical store contents after the probe. Legacy
incident fixtures remain present and green. No source fixture establishes live
activation, organic evidence or operator approval.
