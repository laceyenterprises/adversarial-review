# Merge Authority v2 — Executor Promotion Runbook

**Owner:** ARC-17 (Merge Authority v2 leased executor)
**Applies to:** `src/finalization/executor.mjs` (+ `executor-lease-store.mjs`,
`execution-surfaces.mjs`)
**Design:** `docs/SPEC-merge-authority-v2.md` §4–5.

The MA-v2 executor is the single leased worker that turns the pure
`eligible(fold(ledger), policy)` decision into a merge / remediation dispatch /
close. It **ships gated off**: `createFinalizationExecutor({ enabled: false })`
makes every `tick()` inert — no lease is taken, no ledger event is written, no
adapter is called. Promotion is an **operator action**, taken only after the
shadow gate clears. This runbook is that procedure.

> Frozen v1 merge authority (`src/ama/*`, `follow-up-merge-agent.mjs`, the
> daemon-clean path) keeps acting until — and only until — this executor is
> promoted. Do not disable v1 before step 4.

---

## 1. Gate criteria (must ALL hold before promotion)

The gate is the shadow-mode promotion verdict from ARC-16 (§5.3). Read it with:

```
adversarial-review finalization shadow-report --days 7 --json
```

Promote only when `promotable: true`, i.e. `blockers: []`. Each blocker maps to a
criterion that must be satisfied first:

| Criterion | Report field | Meaning |
|---|---|---|
| **Coverage window** | `coverage.enoughDays` | Shadow has run ≥ N days (default 7). |
| **Some traffic** | `shadowed > 0` | The window actually contains shadowed finalizations. |
| **Zero open divergences** | `openDivergences === 0` | Every `(v1, v2)` divergence in the window is dispositioned (classifier fingerprint or human override); only an `open` disposition blocks. Triage per `docs/finalization-shadow-divergence-triage.md`. |
| **Organic head-move seen** | `organicHeadMoves ≥ 1` | At least one real revision advance was observed in shadow — proof the per-revision fold behaved on a moving head. |
| **Exhaustion close seen** | `exhaustionCloses ≥ 1` | At least one budget-exhaustion close was observed — proof the land-on-exhaustion path was exercised. |

If `promotable: false`, **stop.** Do not promote on a red gate. Address the
listed blockers (usually: keep shadow running for more coverage, or triage the
open divergences) and re-check.

Record the passing report (the `--json` blob) in the promotion ticket as the
evidence of record.

---

## 2. Pre-promotion checklist

- [ ] Shadow report is `promotable: true` (§1), evidence attached to the ticket.
- [ ] Eligibility policy is validated at load: `consume_attestations` is only on
      when a producer is configured (`normalizePolicy` throws otherwise — this is
      the LHA-cutover guard, verify it does not throw on the target config).
- [ ] The merge seam is resolved for the target host: either the ARC-20
      adjudicate surface is wired, or the github-adapter local fallback binary is
      resolvable (`GHA_ADAPTER_BIN` / auto-discovery). With neither, a
      `finalize-now` fails closed to `escalate` — never a phantom merge.
- [ ] The ARC-22 identity/attestation surface is wired (or you have accepted
      local-mode token identity, in which case a missing surface is `ok: true`,
      `localMode: true`). An explicit attestation denial records terminal
      `escalated`; a surface exception fails only the current tick so transient
      infrastructure errors can be retried.
- [ ] The kill switch is reachable: `policy.autonomousExecutionDisabled = true`
      demonstrably intercepts a mutating decision (see §4).
- [ ] An operator with merge authority approves (this is not an automated flip).

---

## 3. Promotion (one flag, one bounce)

Promotion flips the executor's master gate from off to on. It is a single change:

1. Set the executor's `enabled` flag to `true` for the target domain
   (`createFinalizationExecutor({ enabled: true, ... })` in the daemon wiring).
2. Disable the corresponding frozen v1 actors by config (**step 4** of §5 in the
   design): v1 clean-path close + hammer dispatch for the promoted domain.
3. Bounce the watcher/daemon so both take effect together.

After the bounce, exactly one authority acts per subject: the leased executor.
v1 code is **retained for one release cycle** as the documented rollback.

---

## 4. Kill switch (fail-closed, audited)

The kill switch is orthogonal to promotion and always available on a promoted
executor. Setting `policy.autonomousExecutionDisabled = true`:

- Intercepts **every** mutating decision (`finalize-now`, `remediate`, `close`)
  **before any adapter is called** — no merge, no PR close, no worker dispatch,
  no commit or push proceeds.
- Preserves remediation idempotency: replaying a remediation round that is
  already recorded as dispatched remains a no-op skip rather than becoming a
  terminal escalation.
- Writes a **fail-closed audit row**: an `escalated` finalization ledger event
  whose reason is `kill switch: <decision> intercepted (autonomous execution
  disabled)`. This is durable and inspectable by folding the subject's ledger.
- Does **not** re-page: once a subject is terminal-`escalated`, a later tick
  re-reads the mark and does not append a duplicate (§3).

`eligible()` also gates mutating decisions to `escalate` when the switch is on,
so the interception is defense-in-depth: even a decision computed under a
different policy is re-checked at the executor's mutation boundary.

**To engage the kill switch in an incident:** set
`autonomousExecutionDisabled: true` and bounce. The executor stays live (leases,
folds, records) but performs zero mutations, and every would-be mutation leaves
an audit trail in the ledger.

---

## 5. Rollback (one flag)

To roll back to frozen v1:

1. Set the executor `enabled` flag back to `false` (inert; no lease, no writes).
2. Re-enable the v1 actors disabled in §3 step 2.
3. Bounce the watcher/daemon.

Because the ledger is append-only and the executor is idempotent (re-fold guard
+ `matchHeadCommit` + terminal short-circuit), rolling back and forward is safe:
a re-promoted executor folds the existing ledger and resumes; it never
double-merges a subject already marked `finalized`. A crash or ledger failure
after the remote merge but before that mark is also resumable: the local GitHub
adapter fallback recognizes structured `already merged` evidence only when it
names the decided revision, then the executor records the missing `finalized`
event. A revision mismatch or unstructured refusal remains a failed attempt.

If you need to stop mutations **without** ceding authority back to v1 (e.g. mid
investigation), prefer the **kill switch** (§4) over rollback — it keeps the v2
ledger authoritative and audited while pausing all execution.

## Queue owner storage observation (MGQ-01; no activation)

The repository/base owner foundation ships unconnected to either live writer.
Its additive migration and schema are documented in
[data-model/finalization-ledger.md](data-model/finalization-ledger.md#repositorybase-queue-mgq-01).
A subject lease alone is insufficient for lane serialization.

After normal reviewed deployment, the named operator uses the documented system
service owner and deployment/restart procedure in `DEPLOYMENT.md`. This slice
needs no service restart or route change: no owner loop has been wired yet. If
later composition changes a running watcher, the operator must drain it, use the
registered system-domain restart entry and prove the running build before routing.
Workers must not bounce services or create traffic to exercise ownership.

From the deployed checkout, under its runtime account, run this read-only probe
with the existing load-aware command supervisor (1-second nominal DB wait,
5-second finite DB ceiling; outer supervisor bounded to 30 seconds):

```sh
node src/finalization/queue-probe.mjs --capability owner --json
```

The owner observation requires explicit `--capability owner`; missing or unsupported
capabilities exit 2 without emitting observations.

Record `.capabilities.owner.available == true` and `.runtime.build != null`.
Availability is computed from exact deployed definitions of every table/index
named by the MGQ-01 baseline migration, DB readability/ownership and the resolved
local lock adapter. Later additive tables and indexes do not invalidate that
baseline; missing or changed baseline objects remain incompatible. The build is a digest
of the actual loaded queue module/schema bytes, not a release constant. Record
it with the deployment revision. It identifies the probe process; it does not
prove that an already-running watcher loaded those bytes.

`observations.lanes` shows persisted claims/generations/heartbeat/expiry/parking;
`unresolvedOperations` exposes ambiguous work. An empty lane list is valid
capability evidence with `organicOwnershipObserved=false`; organic execution
and watcher build/route evidence remain pending until later operator rollout.
The probe cannot create schema, claim/release a lane, write a lock file, call
GitHub, dispatch a worker or page. A missing/incompatible store or unresolved
owner adapter returns unavailable and exit 1 without manufacturing evidence.
This is an observation assertion, not a CI check or promotion gate.

Takeover must use the shared issuance lock and reconcile every unresolved
operation after proven stop/drain. Never delete a lock file or clear an intent
based on age/PID death. Unproven quiescence parks that lane for operator recovery;
other lanes remain independent. Retain events, intents, original deadlines and
receipts through recovery and eventual rollback. Production recovery adapters
and remote receipt verification are supplied by subsequent executor slices.

The operator must apply `migrations/20261023_finalization_queue.sql` through the
normal app-store migration procedure before expecting schema availability.
Deploying source alone may leave the probe unavailable; it never installs its
own schema. This additive migration creates no lane and changes no route.

Focused validation record (synthetic fixtures, no external services):

| Variant | Observed contention outcomes |
|---|---|
| Existing subject-only leases | 30/30 trials retained two subject holders on one repository/base. |
| First process-based lane implementation | 30/30 single persisted owner; 13/13 focused tests passed. |
| Recovery results and successor claim made atomic | 30/30 single owner; 67/68 tests passed, with one IPC assertion shape error corrected in the fixture. |
| Result currency and parked-event deduplication | 30/30 single owner; 76/76 focused and existing ledger/executor tests passed. |
| Final fixtures including concurrent readiness and probe CLI | 30/30 single owner; 79/79 tests passed across nine selected files. |

The final two process-based runs give 60 consecutive single-owner outcomes,
with DB outcome read-back on every trial and zero duplicates. Initial thread
fixtures produced no usable contention denominator: one hit its 150-second
bound and the next exposed the native lock addon's lack of Worker-thread
support. The fixtures now use independent foreground child processes and the
existing test runner, with a 120-second outer bound and command-local netguard.
No native addon or host installation was changed. Touched JavaScript lint and
`git diff --check` passed. The selected runner files are
`finalization-{lane-baseline,queue-owner,ledger-events,ledger-fold,ledger-store,executor-lease,executor,ledger-regression-fixtures,port}.test.mjs`.
Deployed runtime-owner probe results and organic ownership observations are
pending; local fixture availability is not deployment evidence.

## Durable handoff observation (MGQ-02; no activation)

Deploy source and apply `migrations/20261024_finalization_queue_handoff.sql`
after the MGQ-01 migration through the normal app-store migration procedure.
Opening the writable queue store also converges both additive migrations; the
read probe never migrates. This slice installs no lane route, evidence-reader
composition or owner loop and requires no service restart or config change.
Legacy closer execution remains acting.

Under the runtime account, from the deployed review-service checkout, use the
existing load-aware command supervisor with a 30-second finite outer bound:

```sh
node src/finalization/queue-probe.mjs --capability handoff --json
```

Record `.capabilities.handoff.available == true` and `.runtime.build != null`.
The probe checks deployed table definitions, ownership/readability and the
resolved durable receipt adapter, and hashes actual queue/handoff/boundary module
and migration bytes. DB read patience is 1 second nominal, scaled once with a
5-second finite ceiling and deadline clipping. It performs no network, signer,
dispatcher, pager, lane claim, lock-file write or migration. Its build identifies
the probe process; it does not establish an existing watcher's build or route.

`observations.handoff.acknowledgements` counts persisted validated receipts.
Zero is valid installed capability evidence with `organicHandoffObserved=false`;
live evidence-reader composition and organic receipts remain pending until later
operator routing/rollout. The capability explicitly reports composition required.
Missing/incompatible schema returns unavailable and exit 1; missing/unsupported
capability arguments exit 2. This observation is not a blocking check or promotion
gate. Never create lanes or synthetic submissions to manufacture evidence.

If later routing changes a running watcher, the operator must drain prior
writers, follow the registered system-domain restart entry and existing
promotion/rollback procedure, then record actual running build and route.
No worker restart, config flip, label, live comment or merge is authorized here.
Retain original handoffs/acks on rollback. Actual deployed runtime-owner probe
results and organic handoffs remain pending operator observation.

MGQ-02 synthetic validation record (no live services):

| Implementation stage | Observed result |
|---|---|
| Existing MGQ-01 storage-only acknowledgements | 20/20 admissions lacked a full validated handoff receipt; none established closer completion through the new boundary. |
| First handoff implementation | 38/47 focused tests passed; an INSERT placeholder-count error prevented receipt creation, including the first duplicate pair (0/1 successful pair). Corrected before publication. |
| Atomic receipt correction | 76/76 tests across four selected files; 20/20 duplicate-submitter process pairs produced one entry and identical ack. |
| Receipt consistency and deadline hardening | 81/81 tests; another 20/20 duplicate pairs succeeded. |
| Final source with signed reviewer binding | 82/82 tests; another 20/20 duplicate pairs succeeded, for 60 consecutive corrected outcomes with zero duplicate entries. Existing lane-owner trials also passed 30/30 in each corrected run. |

The independent-process fixture forces both submitters to observe receipt absence
before allowing either to commit. Each pair reads the resulting durable ack and
entry count back. A separate process exits after commit before sending a reply;
the parent reopens/replays its one ack. Existing queue-owner contention fixtures
remain selected, along with the unchanged legacy retry-helper and port tests.
Sibling boundaries inspected include low-level queue acknowledgement, mutation
issuance/replay, review currency and withdrawal preservation, and the legacy
retry helper. No legacy dispatch or ownership algorithm is changed.

## FIFO admission observation (MGQ-03; no activation)

Deploy source and apply `migrations/20261025_finalization_queue_admission.sql`
after the owner/handoff migrations through normal app-store migration. Writable
queue-store opening converges all three; the probe never migrates. There is no
route change, production activation or service restart required by this slice.

Under the deployed runtime owner in the deployed review-service checkout, run
through the existing load-aware command supervisor with a finite 30-second bound:

```sh
node src/finalization/queue-probe.mjs --capability admission --json
```

Record `.capabilities.admission.available == true`, `.runtime.build != null`,
the resolved adapter/schema, counts by clean/remediated/unvalidated source and
active/parked/terminal disposition, observed admissions and bounded receipt sample.
SQLite read patience remains 1 second nominal, scaled once and clipped to a
5-second ceiling. Schema comparison and receipt reads use the real deployed DB;
the probe validates at most 100 recent receipts. Counts describe stored records,
not a whole-store provenance audit. The digest identifies probe code bytes,
not a running watcher's build or effective lane route. Missing organic observations
remain pending. Do not submit synthetic work, claim a lane or mutate state to
make this observation pass. Availability is not a blocking check or promotion gate.

Runtime reader composition and whole-lane routing belong to later slices.
For later promotion/rollback the operator drains prior writers and follows the
existing registered system-domain restart/verify procedure; record actual running
build, effective route and unresolved-operation reconciliation. Workers do not
restart services or change production config. Retain receipts and entry history
on rollback. Deployed probe and organic admission evidence remain pending.

Synthetic concurrency evidence: the unfixed store accepted 20/20 stale recovery
snapshots after a recover/hold phase cycle. The snapshot-CAS correction accepted
0/20 under the same reproduction. The first scoped suite passed 21/21, including
10 consecutive four-process mixed clean/remediated trials (one entry per admission)
and 20 consecutive late-recovery refusals across store reopen. Sibling sites
inspected: handoff acknowledgement, single-owner issuance, entry phase progress,
publication recovery and clean receipt replay. Original owner/handoff mechanisms
remain in place; the new live-read writer uses a fenced snapshot comparison.

Further intermediate validation passed 110/110 selected tests. A disposable
version of the snapshot-only implementation accepted 20/20 identical parked
observations after a same-timestamp phase cycle; the retained progress-version
correction rejected all 20/20 under the same reproduction. The final selected
suite passed 116/116, including the deployed CLI fixture, with 10 consecutive
mixed-source process trials and 20 consecutive asynchronous recovery refusals. Touched JavaScript lint, contract
typecheck and whitespace checks also passed. No live service was exercised.

## Mechanical rebase observation (MGQ-04; no activation)

Deploy through the existing review-service deployment path. This source change
adds no route, config key, service or migration. The three existing queue schema
migrations must already be present. Production promotion and any runtime-owner
system service restart remain operator work: identify the owner/domain and
restart entry through the existing `scripts/os-restart.sh` deployment procedure,
then verify the running watcher revision separately. Workers must not restart
services or manufacture queue activity.

From the deployed checkout as its runtime owner, use the existing load-aware
bounded supervisor to run:

```sh
node src/finalization/queue-probe.mjs --capability rebase --json
```

Require `.capabilities.rebase.available == true` and `.runtime.build != null`.
The probe opens the actual store read-only, checks the shipped queue schema and
receipt adapters, resolves the same default isolated Git/proof adapter as the
execution service, and reads the installed Git version with a nominal 1-second
wait capped at 5 seconds. It hashes the shipped runtime modules, including the
Git/proof code. This digest identifies the probe process bytes; record the actual
watcher build/route independently before promotion.

Record prepared/published counts, the bounded recent observation sample, old
head, candidate, exact base and publication source references. The sample is at
most 100 entries and does not attest every historical proof. Empty publication
observations mean pending organic evidence. A missing store/schema/Git adapter
reports unavailable and performs no migration, claim, workspace creation,
fetch, push or lane mutation. Availability alone does not assert that the live
reader, per-operation credentials, recovery drain adapter or routing is composed.
The default adapter refuses network operations without an injected entitled
runner; it never borrows the runtime owner's ambient SSH credentials. The existing
execution brake remains a separate resolved finalization-policy input.

When organically available after a later authorized route promotion, observe a
conflict-free publication with its original signed receipt, complete ordered
proof, leased old/new pair, source signatures, author notice delivery and durable
live publication observation. Recovery evidence must identify prior operation
stop/drain, authoritative remote head and unchanged candidate/base/deadline.
Never simulate crashes, holds or force-pushes against production for this probe.

For a parked permission entry, inspect the named author/operator notice intent
and actual repository/fork/rules rights. Revalidation/readmission belongs to the
existing admission service and rejoins the tail; do not edit the queue row.
Ambiguous operations require the existing explicit drain/reconciliation adapter;
lease expiry or an old-head read alone is insufficient. Keep isolated candidate
repositories until reconciliation and evidence retention permit operator cleanup.
Rollback retains receipts, proof, candidates and unresolved intents. No change to
the emergency execution brake or the existing smoke promises is part of this slice.

Source validation used only bounded offline fixtures and disposable stores/Git
repositories under the existing test runner and network guard. The seven selected
files passed 187/187 cases; after final isolation/source-signature hardening the
three touched suites passed 42/42, and the terminal-state refinement passed 25/25
executor cases. These runs cover 190 distinct cases across seven files. The
unsafe disposable force-push control overwrote author updates in 5/5 trials;
expected-old-head publication retained author updates in 10/10 consecutive
trials, and overlapping wakes issued one push in 5/5 consecutive trials. No
intermediate production concurrency implementation or production experiment was
used. Sibling owner/admission/handoff and original rebase-proof regressions stayed
green. Touched-file ESLint, contract typecheck, catalog and whitespace checks
passed. Deployed runtime-owner probe, actual watcher build, composed transports,
notice delivery and organic publication evidence remain pending operator work.
