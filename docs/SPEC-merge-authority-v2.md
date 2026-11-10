# SPEC — Merge Authority v2: Ground-Up Finalization Redesign

**Status:** v1.0 — MLR-04 approved without amendments; not activation approval.
MLR-06 implements the fold/executor contract with synthetic evidence; deployed
composition and organic promotion receipts remain separately required.
**Spec:** `merge-lane-rebuild@a0b63d32143a`, MLR-03, dependent on MLR-02.
**Scope:** the code-pr finalization port of
[SPEC-adversarial-review-v2-app-architecture.md](SPEC-adversarial-review-v2-app-architecture.md).
The [v1 freeze](../src/ama/FREEZE.md) remains bug-fix-only until v2 is promoted,
permitting live-PR unblocks only until operator-approved cutover.

## Change notes

2026-11-02 — MLR-03: replace Draft v0.1 with the five MLR invariants, subject
budget, owned recovery and conflict rules, load-aware deadlines, express delivery
and NXA read model. Section 7 dispositions all 61 MLR-02 requirements (58 gaps)
against this design. Section 6 proposes operator answers; MLR-04 decides them.
No runtime, persistent schema, routing, merge policy or deployment changes ship
with this documentation.

## 1. Why a redesign instead of another fix

The inherited failure families are phantom completion after a crash (HCM-01),
identity tied to an obsolete opening head (PR 603), review exhaustion deadlocking
a moved head (LAC-1559), an attestation consumer enabled before its producer,
absent required checks interpreted as green (AR-550), and stale-verdict merges.
MLR-02 adds ownerless waits, competing recovery actors, unresolved conflicts,
infrastructure kills charged as useful rounds, fixed read deadlines poisoning a
whole scan, and fixes that land without reaching the running review service.
These are synthetic failure classes here; private incident records stay in the
Agent OS requirements ledger.

The normative source inputs are Agent OS
`projects/merge-lane-rebuild/{SPEC.md,REQUIREMENTS.md,requirements.json}` at
`merge-lane-rebuild@a0b63d32143a`. MLR-02's captured evidence maps 34 contracts
and 61 requirements, with stable scenarios S-01 through S-61. Its `gap` flag
measures captured implementation coverage; this design does not clear those
flags. MLR-05 supplies synthetic simulator proof and MLR-06 implements the gaps.

Five invariants govern every decision and adapter:

1. **One owner:** every live subject/current head has exactly one accountable
   workflow owner, executable next action and finite deadline. Ownership changes
   are fenced handoffs, never parallel authority.
2. **Verified custody:** an agent owner requires a verified live launch and
   custody evidence. A row, old lease, PID or silent process alone is insufficient.
   Uncertain custody belongs to a reconciliation owner and blocks only its subject.
3. **Unknown is retryable:** failed reads, transient authentication/service
   errors, unknown mergeability, busy capacity, moved bases and budget/quota kills
   are observations with capped load-aware recovery, never terminal refusals or
   remediation-budget charges.
4. **Automatic exit:** every exhaustion, automated hold and escalation has an
   owned continuation and relevant re-arm on head, authenticated operator input
   or deciding-code/policy change. Re-arm re-evaluates evidence; it never erases
   spent work or releases an explicit operator hold without authorization.
5. **One decision function:** routing, dispatch, admission, rescue and merge
   consume the same folded decision. Success comes from authoritative PR state.
   An unavailable dependent remediation lane cannot authorize skipping findings.

## 2. Durable subject, events and budget

One canonical subject, one append-only ledger, one decision function. Subject
identity includes the exact repository/domain and PR identity; a fork or short
repository-name match is never equivalent. Identity can survive a head move;
merge authorization cannot be inherited from an old head.

The existing [finalization ledger data model](data-model/finalization-ledger.md)
and [migration](../migrations/20260717_finalization_ledger.sql) describe shipped
storage. The following semantic additions are requirements for MLR-06, not
existing event constructors or a schema migration in MLR-03:

| Fact family | Required information and fold effect |
|---|---|
| Revision / base advanced | Exact old/new head and base, source and immutable builder boundary; invalidate stale authorization, retain budget and provenance. |
| Verdict / checks / attestation recorded | Revision, producer, source reference, completeness and freshness; unknown is distinct from absent or negative. |
| Owner / custody / progress observed | Launch, branch/worktree holder, owner and route generations, durable progress, observation time and source; reconcile dead or uncertain custody. |
| Decision / deadline anchored | Subject/head, policy/code version, owner, action, reason, evidence refs, durable anchor, nominal/effective duration and ceiling. |
| Work dispatched / concluded | Stable operation/attempt identity, admission and start evidence, typed outcome, findings coverage, validation and publication receipts. |
| Budget consumed / exhausted | One deduplicated subject work identity and resulting cumulative consumption; stage is diagnostic only. |
| Worker killed / cancellation / transport unknown | Machine cause, actor, launch and operation references; reconcile effects, no automatic budget debit. |
| Operator input / dependency repaired | Authenticated principal and reason, affected hold/evidence fingerprint, policy/code or capability version; re-evaluate relevant decisions. |
| Finalized / closed observed | Authoritative PR state, exact merged revision when available, actual principal and source; terminal for PR execution. |
| Escalated / halted | Episode, cause, recovery owner, next action, deadline and delivery state; unresolved incident, not an ownerless terminal PR. |

`eligible(fold(events), policy, observation)` is pure and total. Clock and load
enter as explicit observations and anchored deadline data, never hidden I/O in
the fold. Replay of a prefix plus its tail equals replay of the whole ledger.
Every fact retains provenance; an unreadable or incomplete source cannot prove
absence. Unknown future safety-relevant semantics require owned refresh before
mutation, even when the storage reader can preserve the unknown event losslessly.

### One budget per subject

A single versioned subject budget bounds useful review/remediation cycles across
heads, stages, restarts and owners. It replaces series, lifetime, refund and
decision-reset counters. Stage allocations may schedule work within that budget;
they cannot create independent stop authorities. The three legacy exhaustion
sources (remediation-ledger rounds, completed reviewer rereviews and follow-up
`max-rounds-reached`) reconcile by stable work identity into that same budget;
closer dispatches are not review cycles and overlapping evidence counts once.

Consumption requires durable evidence of performed useful work and its typed
conclusion. Dispatch intent, admission deferral, clone reservation, self-cancel
before work, quota loss, budget kill, terminal-exit grace kill and infrastructure
read failure do not consume a round. A kill triggers effect reconciliation;
independently proven completed work may already have one debit, but the kill
adds none. Replayed receipts cannot debit twice. There is no refund sub-ledger.
Infrastructure retries remain bounded by owned deadline episodes and escalation,
so excluding them from work accounting cannot create an invisible infinite loop.

Exhaustion transfers the subject to final remediation and landing (§3), never
abandonment. A new builder head retains consumption and gets a current-head review
owner within remaining budget, or a final-remediation owner when exhausted.
Head, operator or code changes re-arm the decision, not the budget. Fresh-PR
recovery retains predecessor evidence and outstanding work rather than serving
as an unrecorded budget reset. An operator budget amendment is explicit,
versioned and audited; ordinary workers cannot grant it.

## 3. Decision policy, deadlines and read model

`Decision` retains `finalize-now`, `remediate`, `close`, `wait`, `halt` and
`escalate`, and must express review, conflict repair and custody reconciliation
as owned actions. Each non-terminal result carries subject/head, one owner,
next action, evidence and a deadline. This is a semantic contract; MLR-06 owns
the concrete typed vocabulary and adapter changes.

### Preserved merge policy

Strict mode remains on: address every blocking and non-blocking finding. Normal
convergence consumes a valid final re-review at the current head. Exhaustion
uses final remediation with schema-validated coverage of every outstanding
finding, followed by landing without another re-review requirement. An ack,
comment-only final round, process success or CI green alone proves neither
coverage nor merge. A completed comment-only final round follows the same
closure path without restarting review. Coverage impossible to establish selects
owned recovery and a page; it does not permit merging unaddressed findings.
Autonomous exhaustion never emits rejection; `close` requires authenticated
operator direction. Explicit operator holds and the kill switch remain binding.

Both paths use the shared check classifier in
[checks-summary.mjs](../src/checks-summary.mjs): latest runs, complete required
contexts, no empty-rollup green and no pending-latest-run green. The closer's
existing exclusion of its own adversarial-gate context remains the only scope
difference. Preserve configured branch-protection and CI-cost policy, including
advisory-default cost evidence and the existing blocking mode; this spec adds no
check, approval label or waiver. Expired patience never authorizes merge.

Attestation consumption requires a declared, working producer and revision-bound
proof. Creation-time title routing identifies the builder harness; it is not
identity or merge proof. Authorized signing and bump-PR producers must work,
with exact canonical repository matching. Historical build identity may be read
by PR after a head move, but verdict, checks, attestation and final coverage
remain bound to the candidate head. Carry requires the existing explicit proof
for the exact reviewed-to-current pair; ancestry or trailers alone are insufficient.

The execution brake intercepts every autonomous remote mutation, including
review/remediation dispatch, conflict publication, merge and PR close. Record
the interception and retain an observation/recovery owner. Routine incident
recovery does not halt the whole pipeline; unrelated subjects keep progressing.

### Conflict, unknown and re-arm

`CONFLICTING` and `DIRTY` select the same owned conflict state before a generic
CI wait can strand them. Its remediator performs merge-main, or follows the
existing authorized conflict-rebase decision when required. It preserves builder
changes, immutable original author boundary and hammer provenance across base
movement. Rebase/merge success is a new revision observation requiring fresh
candidate authorization; conflict repair admission itself grants no merge right.

Unknown facts select refresh/reconciliation, including credential renewal or
permitted cross-model fallback, never a stored final refusal. Respect builder /
reviewer separation in fallback. Decisions fingerprint the evidence and deciding
code/policy version. Relevant changes reopen automated stops and escalations
without another ad hoc cap. Explicit human holds stay held until authorized
release; head/code changes refresh their status but do not waive them. A held
subject still has a monitoring owner, next observation and deadline.

### Load-aware deadlines

Every new closure-path wait uses `loadAwareTimeoutMs` in Node or
`agent_os_core.load_timeout` in Python, with a finite ceiling. This includes
scans, per-subject reads, admission, retries, conflict repair, custody lookup,
worker outcome/grace observation, hold monitoring, escalation delivery and
post-merge handoff. Timeouts must distinguish known failure from unknown effect.

Scale nominal patience once at the durable episode anchor and persist nominal,
effective and ceiling values, load evidence and absolute deadline. Per-call waits
are clipped to remaining episode time, finite ceiling and platform timer limits.
Polling, replay, duplicate delivery and phase changes cannot slide that deadline.
Only a relevant durable state change can anchor a new episode; retain the prior
episode and page history. Expiry reconciles and escalates with an owner, never
proves a worker dead, a dispatch absent or a PR mergeable. One slow/failed read
must not poison all remaining subjects in a pass. Policy supplies durations;
MLR-05 exercises load multipliers ×1, ×3 and ×6 and the ceiling boundaries.

### NXA becomes the read model

The [NXA inventory](NEXT-ACTION-REASON-INVENTORY.md) supplies R00–R16 and R15
variants. Project the authoritative v2 decision to one status row per open PR:
state, verified owner/custody, next action, anchored load-aware deadline, overdue
age, reason, evidence refs, generation and freshness. Legacy fixed/unscaled
patience and null-deadline holds are compatibility observations, not v2 policy.

| NXA family | v2 owned continuation |
|---|---|
| R00, R16 and policy guard | Observation owner refreshes incomplete PR, policy, checks, verdict or attestation evidence. |
| R01 | Authoritative merged/closed settles PR execution; delivery owner retains post-merge work. |
| R02 | Operator-directed hold or disabled execution, monitored with bounded refresh and authorized release. |
| R03 | Verified agent continues; monitor verifies durable progress and custody. |
| R04 | Reconciliation owner resolves unknown/expired custody before any successor mutation. |
| R05 | Recovery owner preserves/repairs primary changes or resolves structural/identity evidence. Empty-diff fixtures never count as implementation completion. |
| R06 | Reconcile claimed merge receipt against live PR state. |
| R07, R08 | Retain spent subject budget; re-arm recoverable stops or continue final remediation. |
| R09, R10, R12, R14 | Owned CI/finding/final-push/conflict repair with validated completion. |
| R11 | Owned check/mergeability observation, with conflict taking precedence over generic waiting. |
| R13 and all R15 variants | Current-head review, final remediation or guarded merge from the shared decision; daemon refusal never creates an independent fallback policy. |

Drain/capacity defer dispatch after selection, preserving owner and deadline.
A status projection cannot authorize mutation. Overdue pages use the existing
Sentinel/PRAGE route, deduplicated per episode, with status-row linkage; failed
transport is retried without consuming useful-work budget. Expose overdue count,
oldest overdue, ownerless minutes and green-to-merged latency. Dirty worktree
custody after terminal launch counts as ownerless until reconciled. A process
being alive does not prove that its dependent dispatch lane works. Retire the
separate NXA observer only when this projection and its consumers have migrated.

## 4. Executor and integration duties

The subject executor is the sole workflow decision writer. Existing MGQ
repository/base ownership serializes remote mutation within a lane; these are
different scopes, not competing authorities. Every mutation passes the same
issuance lock, owner/route generations, live-head guard and eligibility checks.
Use the existing [queue routing](../src/finalization/queue-routing.mjs), durable
handoffs and operation reconciliation; do not create another lease or rescue loop.

Before issuing an effect, re-fold and revalidate authoritative live state. A
changed head/generation discards the decision. Persist intent/idempotency before
issuance and reconcile unknown outcomes before retry. Timeout after applying a
control call is not proof that it failed. Structured already-merged evidence
must identify the guarded revision to complete that operation receipt; an
external merge at a different revision settles the PR as externally finalized,
not success of the stale operation. Closed/merged PRs receive terminal settlement
before claims and never dispatch another reviewer or closer.

Custody transfer requires complete live-launch and branch/worktree evidence,
stop/drain and reconciliation of unresolved operations. Age, lease expiry,
signal silence and PID death alone grant no takeover. Rescue cannot race a live
hammer; cancellation is a takeover signal requiring authenticated reconciliation,
dirty-work salvage and successor custody before release. Preserve uncommitted /
unpushed work and alert for owned manual recovery, rather than silently reaping
it after a successful process exit. Teardown retains distinct held, failed and
completed outcomes and exact holder evidence; caller argv is not a holder probe.
MLR-13 supplies custody event producers through the review service's boundary.

Adapters retain durable review/remediation artifacts, clean-base diff evidence,
primary-change preservation and finding-scoped reversal proof. This includes
opaque/renamed/generated outputs, finding-authorized dead-code cleanup and repair
dispatch; merge-main cannot erase the original builder boundary. Validation
receipts distinguish finding failures, infrastructure/fixture setup failures,
managed load deferral and reproduced main-baseline failures. Report the failed
operation and cause after a published phase, not just the last successful phase.

Runtime adapters own credential readability versus expiry, refresh and permitted
fallback. Use the declared interpreter and authoritative stores (including the
dedicated clone occupancy store); missing drivers or disabled reads mean unknown.
Remediator/reviewer admission remains bounded and fair; closer reserves cannot
starve the work required to remediate findings. An unavailable repair/recovery
capability selects owned escalation, never bypass. Config readers preserve scoped
unknown-key tolerance and supported-value parity across Python, Node and shell.
No schema-parity CI check is introduced by importing that historical scar.

Landing and delivery have separate receipts. Any merge principal, including a
manual or takeover merge, triggers the existing post-merge plan/DAG handoff
idempotently and gives it an explicit delivery owner. Record actual principal so
manual landing never inflates autonomous throughput. Scheduled stand-up, failed
activation reaction and last-good handling stay with existing deployment owners;
merged/fast-forwarded source is not loaded-code proof.

Review-service fixes carrying the existing `sev_fix` marker request the existing
express submodule-float path. Retain source, float and activation receipts and
page failed delivery through the existing route. Express delivery does not skip
review or merge policy, authorize worker restarts or treat a float as activation.
SRE/operator executes privileged deploy steps and verifies running build and
consumer health read-only. Review runtime must resolve deployed dependencies
without depending on CI-only packages.

## 5. Shadow, promotion and retirement

MLR consumes MGQ-07 ingestion/read models, MGQ-08 whole-lane routing, MGQ-09
canary/rollback and MGQ-10 retirement. It creates no parallel promotion authority.
The existing [triage](finalization-shadow-divergence-triage.md),
[canary](finalization-queue-canary-runbook.md) and
[expansion/retirement](finalization-queue-expansion-runbook.md) procedures apply.
The original [executor promotion runbook](finalization-executor-promotion-runbook.md)
records the July implementation; its day-count gate and terminal escalation
semantics do not establish compliance with this proposed v1.0 contract. MLR-06/07
must reconcile implementation/readouts with the MLR-04 approved revision before
MLR rollout. Existing stricter safety/evidence requirements remain in force.

1. In shadow, ingest live facts and record v1 action versus v2 decision with
   source, revision, owner, deadline and policy/code version; only v1 mutates.
   Synthetic scenarios stay offline and cannot count as organic observations.
2. Disposition every divergence in either direction, with evidence and owner:
   v1 may be wrong. Persist fold errors and missing evidence as unresolved;
   neither counts as agreement. Recover unavailable ingestion without guessing.
3. MLR-04 approves/amends §6. MLR-07 computes the approved volume criterion;
   do not substitute the existing `shadowed > 0` or elapsed-day result for it.
   Missing organic examples remain pending evidence.
4. Main Loop 6 owns canary, promotion and rollback; BS4 owns launch/walk; SRE
   executes host steps under that owner. Require MGQ's at least 20 canary entries,
   clean and remediated coverage and rollback rehearsal, plus MLR's approved
   at least 50 shadowed finalizations with organic head-move and exhaustion
   examples and every divergence dispositioned. MLR-04 is the amendment authority.
5. Use whole-lane transfer with verified prior-writer drain, fenced operation
   reconciliation and acknowledgements before changing the selector. Preserve
   receipts and original deadlines on rollback/reactivation. A flag and bounce
   alone are not sufficient transfer proof. Verify actual running build, effective
   route and organic consumer progress read-only after the operator action.
6. Retain frozen v1 for one release cycle. Separate operator approval precedes
   deletion and contract-location rebinding. Missing deployed receipts are named
   dependencies, never evidence that cutover or retirement happened.

This PR authorizes no host action. Docs merge requires no restart, migration or
config flip. Later implementation promotion must declare its deployment and
read-only activation evidence under the existing operator procedures.

## 6. Approved operator answers (MLR-04)

| Question | Recommendation and evidence |
|---|---|
| Promotion window | Use at least **50 distinct shadowed finalizations**, including at least one organic head move and one exhaustion close-by-landing, with every divergence dispositioned and no unresolved fold/evidence error. Count terminal subject outcomes once, not polls or repeated decisions. MLR-02's head/exhaustion/replay scenarios explain the required examples; elapsed days alone cannot establish exercised volume. Retain MGQ's separate canary/rehearsal requirements (§5). |
| Escalation channel | **Page through the existing Sentinel/PRAGE route plus a durable status row**, with one page per episode, delivery acknowledgement/retry and an accountable recovery owner/deadline. MLR-02 R-17, R-35, R-36 and R-60 capture silent ownerless waits. Normal successful exhaustion landing appears in status/metrics; overdue or impossible coverage pages. No new pager, mandatory Linear ticket, CI gate or override label. |
| Ledger location | Keep **`data/reviews.db` in the review-service app store** as the authoritative finalization/queue ledger and reuse `finalization_shadow` for comparisons. Existing schema, leases, fenced issuance and MGQ receipts already share this failure domain. Session-ledger launch/custody facts arrive through an adapter with provenance; any later mirror is observational, never a second writer or availability prerequisite. This preserves standalone, token-free offline operation. |

MLR-04 approved these three recommendations without amendments. This design
approval does not authorize activation, lane transfer, restart or retirement.

## 7. MLR-02 requirement disposition and scenario traceability

All rows below are normative inheritance obligations. `R-nn` maps to `S-nn` in
Agent OS `projects/merge-lane-rebuild/requirements.json`; no private incidents,
operator quotes or recorded production fixtures are copied here. Each obligation
must receive synthetic implementation proof in MLR-05/06. A design disposition
is not a claim that a gap is implemented or that a captured regression citation
is complete.

| Requirement / scenario | Required v2 disposition | Rule |
|---|---|---|
| R-01 / S-01 | Preserve all-finding coverage and current-head final review; retain the final-remediation exception. | §3 preserved policy |
| R-02 / S-02 | Exhaustion gives final remediation and landing an owner. | §2 budget; §3 |
| R-03 / S-03 | Fix in motion, isolate failures by subject; retain explicit execution brake. | §1; §3 |
| R-04 / S-04 | All merge surfaces use the same authorization; no worker admin bypass. | §3; §4 |
| R-05 / S-05 | Do not race verified live autonomous custody. | §4 custody |
| R-06 / S-06 | No force-push during active remediation; route remediation work and verify merge before downstream dispatch. | §4 handoffs |
| R-07 / S-07 | Peer review precedes deployment; bounded pools and subject budget prevent runaway loops; plans retain delivery ownership. | §2; §4 |
| R-08 / S-08 | Bind verdict/authorization to current candidate with exact-pair carry proof only. | §2; §3 |
| R-09 / S-09 | Reconcile cancellation and branch holders with bounded owned recovery. | §4 custody |
| R-10 / S-10 | Transient credential checkout selects permitted model fallback without self-review. | §3 unknown; §4 |
| R-11 / S-11 | Cancellation carries authenticated actor and reconcilable outcome. | §4 custody |
| R-12 / S-12 | Subject budget replaces per-head/lifetime stops; authoritative terminal state stops redispatch. | §2; §4 |
| R-13 / S-13 | Runtime dependencies come from deployed source; existing recovery delivery stays owned. | §4 delivery |
| R-14 / S-14 | Complete latest-run CI and validation provenance distinguish real red/green from missing or false signals. | §3 checks; §4 |
| R-15 / S-15 | Clean-base diffs and current base evidence precede review/publication. | §4 adapters |
| R-16 / S-16 | Preserve cross-model routing, kernel parsing and revision-bound verdicts. | §3; §4 |
| R-17 / S-17 | Quota/resource outages retain owner, deadline and visible escalation. | §3 unknown/read model |
| R-18 / S-18 | Schema/read drift is unavailable evidence, fail-closed mutation with owned recovery. | §2; §3 |
| R-19 / S-19 | Scoped config reads tolerate sibling unknown keys without claiming missing safety evidence. | §3 unknown; §4 config |
| R-20 / S-20 | Authoritative terminal PR state settles execution; findings require remediation. | §3; §4 |
| R-21 / S-21 | Preserve supported config parity in three readers; proposed historical CI gate is not adopted. | §4 config |
| R-22 / S-22 | Terminal observation precedes claim/dispatch, including cache disagreement. | §4 effects |
| R-23 / S-23 | Durable progress and verified custody, not PID existence, justify agent ownership. | §1; §4 |
| R-24 / S-24 | Explicit fixture lifecycle cannot satisfy product completion or queue readiness. | §3 R05 |
| R-25 / S-25 | Credential access survives atomic rewrite; unreadable versus expired is typed; repair re-arms. | §3 unknown; §4 |
| R-26 / S-26 | Scheduled stand-up outcomes remain owned and recorded after merge. | §4 delivery |
| R-27 / S-27 | Activation failure stays degraded, cannot advance last-good, and receives bounded reaction/page. | §4 delivery |
| R-28 / S-28 | Preserve governance, required-check/protection policy and effective kill switch on all surfaces. | §3; §4 |
| R-29 / S-29 | Identity survives head move with exact repository provenance; authorization stays head-bound. | §2; §3 |
| R-30 / S-30 | Verified terminal holder release follows salvage and custody reconciliation. | §4 custody |
| R-31 / S-31 | Expiry/silence alone cannot reap live custody. | §3 deadlines; §4 |
| R-32 / S-32 | Attributed cancellation retries unknown/rejected transport and deduplicates alerts until acknowledged/terminal. | §2; §3; §4 |
| R-33 / S-33 | Harness-neutral adapters persist artifacts, recover leases and avoid per-PR evidence scraping. | §2; §4 |
| R-34 / S-34 | Stranded dirty/unpublished work receives preserved salvage, manual recovery owner and alert. | §4 custody |
| R-35 / S-35 | Exactly one verified owner, next action and capped load-aware deadline. | §1; §3 |
| R-36 / S-36 | Unknown reads retry per subject without consuming useful work. | §2; §3 |
| R-37 / S-37 | Relevant head/operator/code changes re-arm automated decisions while explicit holds remain binding. | §2; §3 |
| R-38 / S-38 | Exhausted moved heads receive current-head review or final remediation custody. | §2 budget |
| R-39 / S-39 | Completed comment-only final remediation continues to landing without re-review. | §3 preserved policy |
| R-40 / S-40 | DIRTY and CONFLICTING choose conflict ownership before generic CI wait. | §3 conflict |
| R-41 / S-41 | Budget/grace kill is a worker event; reconcile PR effects before any work debit. | §2 budget |
| R-42 / S-42 | Record failed operation/cause after publication and retain recovery custody. | §4 receipts |
| R-43 / S-43 | Preserve opaque, renamed, generated and author changes; finding-scoped reversal and authorized dead-code cleanup retain proof. | §3 conflict; §4 |
| R-44 / S-44 | Merge-main after hammer preserves immutable builder boundary/provenance. | §2; §3 conflict |
| R-45 / S-45 | Three exhaustion sources deduplicate into one subject budget; stages have no separate stop. | §2 budget |
| R-46 / S-46 | Canonical subject/harness/head identity, authorized signing and bump producers survive routing. | §3 attestation |
| R-47 / S-47 | Manual/takeover merge hands off post-merge work exactly once; failed activation stays degraded. | §4 delivery |
| R-48 / S-48 | Cancel during boot/dirty work requires salvage and successor custody before release. | §4 custody |
| R-49 / S-49 | Admission deferral and pre-work self-cancel do not consume useful cycles. | §2 budget |
| R-50 / S-50 | Rescue refuses duplicate mutation under live hammer; verified loss starts reconciliation. | §4 custody |
| R-51 / S-51 | Authenticated operator input alone grants waivers/releases; workers cannot self-authorize. | §3 holds |
| R-52 / S-52 | Fair dependent-lane admission preserves remediator capacity under closer pressure. | §3 deferral; §4 |
| R-53 / S-53 | Unknown control effects require authoritative readback before retry. | §4 effects |
| R-54 / S-54 | Declared interpreter, authoritative launch and dedicated occupancy store; unavailable never means absent. | §4 adapters |
| R-55 / S-55 | Held/failed/completed teardown and exact holder proof remain distinct. | §4 custody |
| R-56 / S-56 | Express float plus separate loaded-build/consumer activation proof. | §4 delivery |
| R-57 / S-57 | Dependent dispatch capability must work; process health alone is insufficient. | §3; §4 |
| R-58 / S-58 | Fixture/setup, load deferral and reproduced baseline failures retain typed evidence. | §4 validation |
| R-59 / S-59 | Actual principal/revision receipts separate manual and autonomous throughput. | §4 delivery |
| R-60 / S-60 | Every NXA row and variant projects one executable/external owner with recovery. | §3 read model |
| R-61 / S-61 | Crash replay reconciles guarded effects without phantom completion or duplicate dispatch. | §2; §4 |

R-08, R-22 and R-61 were captured as core-covered; their integration scenarios
still apply. All other rows remain implementation gaps until demonstrated. Every
new v1 live unblock, SRE takeover, fresh-PR reopen or manual PR update extends
the Agent OS requirements ledger with a scenario under the freeze contract.

## Per-lane execution routing implementation

The existing selector is `roles.adversarial.merge_authority.lane_routes`, with
strict `{repository, base, executor: legacy|queue-v2}` records; absent lanes
resolve legacy. [queue-routing.mjs](../src/finalization/queue-routing.mjs) owns
durable transfer and rollback; frozen-v1 sites retain thin boundary calls.
`finalization queue status|receipt|probe` exposes the existing read models.
Routing/schema availability alone proves neither a running composed consumer nor
production acceptance. See [RUNBOOK-ama-closure.md](RUNBOOK-ama-closure.md).
This design neither edits that selector nor authorizes an operator change.
