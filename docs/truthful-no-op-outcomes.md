# Truthful no-op outcomes (LVR-02)

Hammer and closer launches require a launch-bound terminal AMA audit;
remediators require a push. Early hammer failures write failed-without-merge
audits before returning, including fatal credential refresh, missing PR state
and pre-call refusal. A confirmed open PR without a terminal audit records
failed/no_work_done with its reason, preserving bounded retry refunds. Incident
body markers prioritize review and merge queues within existing protections;
daemon reservations and holders retain their semantics. See the
[operational contract](RUNBOOK-ama-closure.md#truthful-launch-outcomes-and-incident-scheduling-lvr-02).

Repeated unkeyed early-failure reports retain the first manual reason for the
repo/PR/head; keyed launches remain independent. Unreadable lease body snapshots
warn and fall back to ordinary priority; nested candidate bodies retain incident
priority when the live body is absent. Lifecycle states and smoke promises are unchanged.

The existing handoff smoke verifies launch-bound failure audits and no_work_done
classification with synthetic state. Focused offline tests in
`test/lvr-no-op-outcomes.test.mjs` cover early exits, redaction and launch flags;
queue and closer suites cover ordering, retry refunds and persisted failures.
After deployment, observe `lvr-02-review-required-outcome` passing once; pending
exit 75 means the deployed checkout has not adopted the contract. No live
worker dispatch, restart, configuration flip or new CI check is required.

LVR-02 deployment order: the companion App Contract endpoint must forward
`required_outcome` before deploying the review-service SDK consumer. Both SDK
and direct remediator transports then require push evidence. This uses the
existing endpoint and worker-pool outcome judgement; no new dispatcher or store
is introduced. Source changes authorize no service restart.

### Per-lane finalization routing and observation

`roles.adversarial.merge_authority.lane_routes` defaults to `[]` (legacy for every
absent repository/base). Strict records contain only `repository`, `base` and
`executor: legacy|queue-v2`; repositories fold case, short base refs preserve it,
and duplicate lanes fail. The existing autonomous execution brake stays separate.
The shared v2 resolver/issuance boundary covers clean-daemon, certified closer
inline merge and rendered hammer merge commands. A selector change cannot
transfer ownership without proved drain/reconciliation; rollback returns pending
entries once through durable handoff keys. The watcher hosts the queue consumer
and runs it only for a matching configured and durable queue route. Missing live
evidence or a missing adapter defers admission or parks the entry.

Use `adversarial-review finalization queue status --repo example/review --base main`
and `finalization queue receipt --repo example/review --pr 101` (both support
`--json`). `node src/finalization/queue-probe.mjs --capability routing --json`
remains the bounded read-only deployed capability observation.
Configuration overrides (`--config FILE`, then `AGENT_OS_CONFIG_PATH`) work even
when `--root DIR` has no module `config.yaml`; existing module/domain layering
still applies. Models expose real
route/config generation, observer and registered writer builds, owner/fence,
head/phase/positions/reasons, parking, receipts, pending delivery and lifecycle
metrics. Store/config failures are visible; absent organic evidence is pending.
Existing smoke promises are unchanged; this observation does not add a check or
promotion gate. See [the routing runbook](RUNBOOK-ama-closure.md#per-lane-finalization-routing-mgq-08)
for runtime-owner composition, registered service restart, transfer and rollback.

The v2 subject merge executor also requires the shared lane port when the cached
selector is empty. Missing lane composition refuses merge; an empty cached policy
cannot bypass a durable queue owner. Other domain finalizers are unchanged.
### Queue canary observations and operator rehearsal (MGQ-09)

`node src/finalization/queue-probe.mjs --capability canary --json` joins the real
queue store, resolved adapters and runtime build with privately supplied operator
observations. It reports unique organic entries by clean/remediated admission and
current outcome, metric denominators, each isolated recovery result and ordered
rollback/reactivation evidence. Fewer than 20 entries, either missing admission
type or an unknown recovery remains pending. Only the canary capability reads
and emits private canary evidence. Preflight requires fresh observations for
every deployed writer, including watcher and follow-up services; the route runtime
is only a last-writer hint and owner-generation churn is not process proof.
Preflight exposes stale process or entry deadlines, build/config mismatch, live
legacy writers, missing producers, identity uncertainty and existing shadow
readiness before activation.

The [canary walkthrough](finalization-queue-canary-runbook.md) covers whole-lane
fence/drain/reconcile/transfer, the reviewed selector change, registered
system-service bounce/verification, organic observation and reversible rollback.
The [observation contract](data-model/finalization-queue-canary.md) documents
`data/finalization-queue-canary.json`; the probe never writes it or the queue.
Fresh sourced process observations are necessary: observer bytes and historical
writer registration alone cannot prove a live process. Missing evidence is pending.
Focused offline fixtures use fake boundaries and disposable stores only. No new
smoke action, check or promotion gate is installed. Workers publish source PRs;
the named operator separately deploys, verifies installed composition, performs
rollout/rehearsal and explicitly approves durable evidence after merge.

### Lane-liveness evidence (LVR-05)

The existing pipeline-health JSON includes `laneLiveness` version 1. For the
Sentinel consumer, `node src/review-pipeline-health-cli.mjs --lane-liveness
--root <state-root> --hq-root <hq-root>` returns only that local, read-only
projection. This mode performs no reconciliation, host probe, network read or
write. It exports four lanes (hammer, daemon, remediation, review), waiting
items, last real event and at most five chronological outcomes. Missing inputs
are unavailable, never healthy zeros. It does not change review/merge authority,
head-binding, configuration, lifecycle states or existing smoke promises.

See [the health contract](review-pipeline-health.md#lane-liveness-evidence).

### Queue lane expansion and closer retirement (MGQ-10)

Resolved `queue-v2` lanes dispatch the ordinary hammer (MRQ-21). Its close
controller stops after publish and the exact-head audit, delivers a handoff bound
to repo, PR, head and review-proof digest through the installed handoff command,
and confirms the durable receipt and entry before recording a superseded
`queue-handoff-admitted` terminal audit. It never waits for CI, runs the merge
predicate or merges; the queue executor does. Wakes observing the durable ack before
the final dispatch recheck reuse it; an ack committed after that read can still
race launch. Returned work owes fresh admission. Clean daemon and certified closer
recovery only enqueue, confirming the actual stored receipt before reporting queued.
Hammer receipts retain the full finding inventory. If strict non-blocking
remediation is explicitly disabled, an unresolved advisory finding can be
recorded as deferred. Blocking findings still require exact-head evidence.
The watcher rechecks parked holds and permissions at one-minute intervals
within original patience and records deadline expiry without a GitHub read.
Other lanes and rollback retain existing legacy prompts and incident repair.
Legacy closer preflight reads config and durable routing without a lane lock,
schema migration or writer journal; unreadable durable routing refuses explicitly.
Before deployment/bounce, inventory already migrated lanes: without an installed
`dispatchContext.queueCloser.hammerHandoffCommand`, every closer remediation on
those lanes refuses with `queue-closer-composition-unavailable`, including findings repair.

`node src/finalization/queue-probe.mjs --capability cutover --json` reads actual
schema/adapters, route, private loaded writer/owner observations, confirmed
exact-head merge receipts and closer releases before first queue CI. Missing
organic or runtime evidence remains pending. Only the explicit cutover capability
reads expansion inputs. The [expansion walkthrough](finalization-queue-expansion-runbook.md)
and [observation contract](data-model/finalization-queue-cutover.md) describe
installed composition requirements, one reviewed lane selector change, operator
fence/drain/reconcile/system-service bounce, metrics, rollback and approval.
The lifecycle is remediation → durable acknowledgement → resources released;
failed acknowledgement/release cannot complete. Existing smoke promises stay;
no new smoke action or blocking check is added. Worker source tests are separate
from deployed observations. Only the operator activates or approves after merge;
retain legacy support for one release cycle.

HAMLANEWAIT-02: retryable merge deferrals release closer ownership as terminal with retryable-<reason> (lane-busy, merge-lease-timeout, required-checks-pending, pr-mergeability-unknown). The audit CLI writes the receipt under the existing owner snapshot fence. In-run lease retries retain ownership. Closure/rescue and bounded startup/periodic sweeps reconcile terminal launches before admission; live launches, retries, parked owners and unreadable evidence retain their existing semantics. Ordinary same-head daemon eligibility or hammer admission schedules the retry through existing backoff, attempt and lifetime caps; terminal lease reclamation and exclusive acquisition prevent duplicate retries. Orphan ownership probes a dispatched lease LRQ even without its dispatch projection. Startup/periodic sweeps defer ledger probes until 15 seconds after the latest lease timestamp (updatedAt, falling back to acquiredAt); missing timestamps remain probeable. No new lifecycle states, config keys, checks or smoke actions; deployment acceptance requires natural recovery observation. VERIFYHEADTRANSIENT-01: explicit infrastructure read outcomes in hammer-phase-outcome.mjs record deferred audits and retryable closer/merge release, including generation-fenced controller cleanup after confirmed drain. Completed matching launches refund the existing lease-wait accounting before ordinary same-head closer retry; each abort leaves series, target and lifetime charges unchanged. The existing retry wake retains a load-aware owner deadline and emits hammer_ended_without_merge with retryable true and phaseOutcome. Red checks, findings, conflicts, moved heads, cancellation and proven owner loss keep final accounting. Synthetic verifyheadtransient-01 and ama-hammer-retry-cap fixtures cover repeated aborts. No new state or smoke command. After deployment the build manager confirms express float and watcher restart; retain the first organic verify-head abort, owned retry wake/deadline and merge without operator action. CLOSERLAUNCHENV-01: launch-environment-read-unavailable and launch-environment-missing-legacy-dispatch reuse that explicit retry/refund path before controller spawn. After float, deploy and service bounce, the deployment owner retains natural-traffic evidence of zero identity-unconfirmed stops from transient reads, or a read-unavailable retry with owner, deadline and unchanged cap spend. Retryable startup failures emit no terminal-stop progress receipt; malformed activation and foreign identity retain final receipts. Synchronous dispatch-file retries run back-to-back without backoff, so fast failures defer to the ordinary closer retry.

HAMLANEWAIT-01: legacy closer lane writes wait for release notifications until
a fresh 60-second merge-attempt deadline after CI/lease waits. A bounded
`lane-busy` result remains deferred and retries with two-minute exponential
backoff capped at thirty minutes; the third same-head launch pages through the
durable closure-wait receipt. Contention retries proceed without charging
final-no-merge or automated-stop budgets. Real refusals and queue-v2 behavior retain their existing contracts.
Focused synthetic fixtures in `test/finalization-queue-routing.test.mjs`,
`test/finalization-queue-owner.test.mjs`, `test/hamunknown-02.test.mjs`,
`test/ama-hammer-retry-cap.test.mjs` and `test/pr-next-action.test.mjs` cover
wake, expiry, retry credit and stop behavior. Existing smoke promises are unchanged;
post-deploy observation is described in `docs/RUNBOOK-ama-closure.md`.

Strict shared-config module acceptance is covered by
`test/config-module-parity.test.mjs`. Python-owned module fields come from the
generated CFG schema (ONS-07), with Python's types, bounds and allowlists.
The parent repository's cross-reader tests exercise committed effective module
cascades against both readers. Session-ledger shorthand is normalized by its
existing consumer adapter before validation; node identity is supplied by that
layer, while its default remains owned by Python. The schema mirror does not
load a parent checkout or infer validation rules from input values. Its merged
schema is compiled once and frozen; each load receives independent mutable
default values. Composition rejects unknown annotations, missing typeless
parents and collisions with existing leaves, including nullable defaults.

Mirrored numeric minima are enforced, except that `__allow_zero: true` permits
zero as a disable value. Python enforces maxima only with `__enforce_max: true`;
the packaged mirror spells this `__enforceMax`. Bare mirror maxima are advisory,
while existing Node consumer schemas retain their hard maxima. Python's
`__enforce_min` and `__description` annotations are informational; a declared
minimum is always enforced. Schema `__alias_of` routes file-layer and CLI writes,
getters and resolution traces to the canonical owner, omits duplicate defaults,
and rejects conflicting alias/canonical values within one file. For example,
`worker_pool.merge_agent.failure_recovery_worker_class` resolves through
`roles.merge_agent_failure_recovery.worker_class` across the normal cascade.
These loader-contract details also belong in the parent Agent OS
`projects/cfg/LOADER-CONTRACT.md`; that superproject document is outside this
repository's remediation diff.

### Public launch observations

Launch status, retry descendants, capacity snapshots, exact idempotency receipts
and legacy ticket-window observations use the pinned SDK 0.9.0 dispatch lookup.
The OS authorizes every row using app receipts or explicit operator-owned
project/repository grants. Unavailable reads retain ownership holds; they never
fall back to SQLite, psql or OS files. Existing blocked-decision, cancellation,
rearm and authoritative merged/closed policy remains in the app.
See [the reader contract](producer-contract-readers.md#dispatch-lookup).


Dispatch lookup requires exactly `ADVERSARIAL_DISPATCH_READS_ENABLED=1`; code
defaults off in environments without it. The tracked watcher and follow-up
service templates carry the flag for those services. DOGREADSFLAG-02 delivers
closer activation separately through the Agent OS adapter's recorded launch
environment, across payload environment clearing. The controller checks the
record's own launch identity and uses its activation value for every mandatory
own-launch HCP read, ignoring later worker exports. Missing, malformed or
foreign records refuse startup; absent or non-`"1"` values remain disabled. That read uses the provisioned worker
token and needs no app grants; grants remain a separate operator step for
app-scoped lookups. Without grants, key, ticket and receipt lookups return
not-found, mapped to `dispatch absence scope unproven`, and retain ownership
holds. The runtime owner must verify the merged SDK release record, deploy the
producer, and run `npm ci` in this submodule before normal service deployment.
Service rollback removes the flag from both service templates and redeploys,
safely pausing service reads and retaining ownership holds. Closer rollback
reverts the reviewed Agent OS adapter activation policy for new launches;
changing service templates does not deactivate closer launch records. SDK 0.9.0
is byte-verified against merged producer `f37c7489439a8b53eafecb38870f75fe9f07fa57`;
runtime activation remains separate. Ordinary filtered empty lookups and missing
rows retain ownership. Only the validated LAC-2120 exact-selector producer proof
under a separate expiring operator entitlement can certify absence. See the
reader contract for proof validation and cancellation limits. Existing lifecycle
states, transitions and smoke promises are unchanged. Focused offline regressions run with:

```bash
node test/run-tests.mjs dispatch-read-client.test.mjs ama-pre-receipt-intent.test.mjs
```

Worker, process, session accounting and daemon/builder provenance now use SDK
0.9.0 through the same authorized lookup. The consumer collects bounded pages
and keeps ownership on failed, malformed, incomplete or grant-filtered empty
reads. Process identities and start timestamps are evidence; the OS process and
lease owners retain mutation authority. Session totals require every linked
launch to belong to the app grant, and unavailable usage stays unknown. Zero
cost remains zero. No worker-directory scan or ledger backend selection is used
by daemon identity or these usage readers.

Producer agent-os#9435 is merged/deployed at
`f37c7489439a8b53eafecb38870f75fe9f07fa57`; the pinned SDK 0.9.0 bytes match it.
Observation rollout requires the separate default-off env-only
`ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED=1`, after runtime-owner verification of
producer support, pinned install and exact project/repository grants. The already
enabled `ADVERSARIAL_DISPATCH_READS_ENABLED=1` own-launch HCP gate remains
independent. No template flag is changed or service restarted by this PR.
Disabled, unsupported or empty observation reads retain title-based cross-model
review intake with a persisted inconclusive finding, while authoritative merge
identity, leases and OS-selected usage remain unknown. Positive head attestations
remain usable independently; no private fallback is restored. Default PR
provenance identifies the opener; `builder_identity:true` is distinct and allows
later completions. Branch launch provenance is diagnostic-only when opener
evidence is missing, including under partial grants. Reroute awaits async
provenance; cold backfill registers once
before its synchronous reads and reports readiness failures before writes.
See [rollout and selector details](producer-contract-readers.md#worker-observations). Existing lifecycle states, transitions, current-head verdict checks,
merged/closed terminal handling and smoke promises are unchanged. Session usage
without an authorized launch link remains unavailable; workspace paths cannot
supply ownership. Run the offline consumer regressions with:

```bash
node test/run-tests.mjs worker-observation-client.test.mjs worker-observation-rollout.test.mjs watcher-claim-loop.test.mjs reviewer-pass-tokens.test.mjs recovery-reaper.test.mjs remorphan-01.test.mjs daemon-worker-identity-ledger-target.test.mjs
```

HOLDOWNER-01 adds observational ownership resolution to the TTM tracker. An open
tracked PR without an actionable review, live closer/remediator, bounded
machine-checkable hold or operator hold label becomes STUCK `ownerless` after
seven minutes. All STUCK kinds page once per head through the durable alert
outbox. The tracker uses the current timeline revision and resets cached review
suppression and ownerless grace on a head change, even before a reviewer-gate
observation. Legacy flags without stall reasons use the flag kind in alert text.
See [the ownership data contract](data-model/ttm-ownership.md).
Offline tracker, pipeline-health, watcher claim-loop and injected alert fixtures
verify ownership, deadline expiry, timer resets and lost-receipt dedup. Lifecycle
routing and existing smoke promises are unchanged; post-deploy observation uses
natural flags and receipts, with no forced stall or alert delivery test.

Synchronous observation reads reuse an already registered SDK app session
with matching connection identity, or an explicit existing session token. Synchronous read
timeout changes reuse the cached session receipt; another endpoint cannot borrow
the cached token. Cold sync reads remain unavailable until async registration.
Partial worker accounting remains marked partial through reviewer capture.
