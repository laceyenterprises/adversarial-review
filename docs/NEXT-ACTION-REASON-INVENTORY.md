# Shared next action: decision rows and adapter inventory (NXA-07)

Spec: `pr-next-action@c216a174c80e`. Module: [`src/pr-next-action.mjs`](../src/pr-next-action.mjs).
Consumer seam (adapters, evidence builders, lazy hook): [`src/pr-next-action-consumer.mjs`](../src/pr-next-action-consumer.mjs).
Shadow: [`src/pr-next-action-shadow.mjs`](../src/pr-next-action-shadow.mjs).
Rollout report: [`bin/next-action-disagreements.mjs`](../bin/next-action-disagreements.mjs).

This page is **design documentation, not an enforced registry**. Nothing reads
it. A new legacy reason needs no entry here, and no code refuses an unknown
reason: the adapter passes unknown reasons through unchanged and the shadow logs
the disagreement.

## Status

NXA-07 completes source adoption after NXA-03 through NXA-06. `nextAction`
is the only successor policy. Wake, remediation closeout, closer, daemon,
rescue, automated recovery and no-progress consumers project its immutable
snapshot/decision pair. `closure-owner.mjs` contains only compatibility output
projection. Historical reason translation remains observational telemetry.

New diagnostic reason text requires no registration and cannot authorize or
refuse a dispatch. Source rollback uses revision `4d06237c`; no permanent
alternate policy remains. Organic rollout evidence is still operator/SRE work;
no offline fixture or source adoption claims that acceptance.

## Contract

`nextAction(snapshot)` is pure and total. It reads no clock, environment, file,
process or network, and it returns exactly one frozen decision:

| Field | Meaning |
|---|---|
| `action` | `wait-for-CI`, `review`, `remediate`, `hammer`, `daemon-merge`, `operator-hold`, `done` |
| `actor` | `ci`, `watcher`, `reviewer`, `remediator`, `hammer`, `daemon`, `closure-recovery`, `operator`, `none` |
| `reason` | row-family reason (tables below) |
| `deadline` | `{ at, anchoredAt, anchorSource, class, budgetMs }`; `null` only for `done` and `operator-hold` |
| `head` | observed PR head |
| `round` | next remediation round, where known (`remediate` only) |
| `evidenceRefs` | every source's `name:state[:sourceRef]` plus row-specific references |
| `decisionKey` | sha256 of subject, head, action, actor, reason, round, attempt and anchor |
| `row`, `queue`, `attempt`, `generation`, `passId` | diagnostics: table row, `{ intent, deferredBy }`, launch attempt, pass identity |

A decision grants ownership only. Every executor still revalidates exact-head
eligibility, provenance, HCP attestation, required checks, protection policy,
identity rules and shared lease fencing before mutating anything. Repair
admission (red CI or DIRTY needing a hammer) is not merge permission.

`wait-for-CI` is also the observe action: `actor: watcher` with a refresh reason
means an owned snapshot refresh.

## Ordered rows

When the evidence a row's guard depends on is unknown, the row does not fall
through to a later, more permissive row. It returns the owned refresh (`R16`) or
the ownership reconciliation (`R04`). Unknown evidence is never treated as absent.

| Row | Condition (first match wins) | action / actor / reason | Deadline class |
|---|---|---|---|
| R00 | PR state or head unreadable | wait-for-CI / watcher / `pr-unknown` | refresh 60 s |
| R01 | PR confirmed MERGED / CLOSED | done / none / `merged`, `closed` | none |
| R02 | explicit hold label (human or unknown provenance), draft, `autonomousMergeExecutionEnabled=false` | operator-hold / operator / `hold-label`, `draft`, `merge-execution-disabled` | none |
| R03 | live owner: non-terminal or parked launch for this head; in-progress remediation job; live reviewer; in-flight lease within its window | hammer\|remediate\|review / owner / `live-owner` | owner's lease/heartbeat deadline |
| R04 | leases unreadable; launch unreadable while this head's lease references it; unreadable retry descendants; in-flight lease past its window. Launch recovery re-reads up to three times with 100/200 ms backoff inside five seconds; unreadable skipped wakes remain retryable. Expiry alone cannot prove absence. | hammer / closure-recovery / `ownership-unreadable`, `lease-expired` | recovery 5 min |
| R04→R05 guard | execution policy missing, unreadable or without a boolean execution switch; established owners and ownership reconciliation above retain precedence | wait-for-CI / watcher / `policy-unknown` | refresh 60 s |
| R05 | empty diff; primary-change reverted/unknown, unreadable or other; deterministic safety refusal | hammer / closure-recovery / `empty-diff-close`, `primary-change-unreadable`, `safety-refusal`; hammer / hammer / `primary-change-repair`; refresh / `structural-restriction-pending` | recovery or admission |
| R06 | merge receipt for this head while the PR is observed open | daemon-merge\|hammer / closure-recovery / `merge-receipt-unconfirmed` | recovery 5 min |
| R07 | current deterministic automatic stop fingerprint (a strictly newer eligible exact-head review may proceed only to daemon merge, recording `stop-superseded-by-exact-head-review` in refs); automation-applied hold label; retry cap exhausted on this head; lifetime cap; hammer's final no-merge on this head | hammer / closure-recovery / `automated-stop`, `retry-exhausted`, `lifetime-exhausted`, `hammer-final-no-merge` | recovery 5 min |
| R08 | terminal no-merge (including exit zero) with readable retry evidence and retry remaining; after recovery expiry, a terminal lease also returns a historically validated head to hammer without re-review | hammer / hammer / `retry-no-merge` (attempt + 1) | admission 5 min |
| R09 | failed CI (any non-success terminal state) or runner-less failure | remediate / remediator / `ci-red` (round with a live PR job, posted current-head findings awaiting job creation before admission expiry, or completed non-final pushed-head closeout awaiting CI admission); hammer / hammer / `ci-red-clean-verdict` (clean verdict, terminal job without pending admission or expired missing-job wait), `ci-red-final`, `ci-runnerless`; refresh `rounds-unknown` | admission |
| R10 | mergeable CONFLICTING or mergeStateStatus DIRTY | hammer / hammer / `conflict-rebase` | admission |
| R11 | checks pending (an empty rollup fails closed as pending) or mergeability UNKNOWN | wait-for-CI / ci / `checks-pending`, `mergeability-unknown` | observer (pending-gate bound), anchored at the latest check transition |
| R12 | proven suppressed final-round push at this head | hammer / hammer / `suppressed-final-push` | admission |
| R13 | existing head-scoped approval under the daemon actor validator; invalid attestation; head-bound closer rereview decision before the historical review ceiling; no current-head verdict without semantic or attested carry; review ceiling | daemon-merge / daemon / `clean-exact-head`; review / reviewer / `attestation-invalid`, `exact-head-review`, `stale-verdict`, `handed-to-review`; hammer / hammer / `review-ceiling` | admission |
| R14 | findings (or unknown finding state) on the current/carried head | remediate / remediator / `review-findings` (round); hammer / hammer / `review-findings-final` | admission |
| R15-daemon-repair | existing qualified daemon repair admission, exact head, clean proof, green and MERGEABLE | hammer / hammer / `retry-no-merge`; existing caps and earlier policy rows still apply | admission |
| R15 | clean verdict (strict mode honoured) or exact-pair validated terminal-head proof, green, MERGEABLE, attestation not unknown | daemon-merge / daemon / `clean-exact-head`, `carried-clean-head` | admission |
| R16 | anything else (also used by the policy guard above) | wait-for-CI / watcher / `snapshot-refresh`, `checks-unknown`, `attestation-unknown`, `reviews-unknown`, `verdict-unknown`, `policy-unknown` | refresh 60 s |

Drain and capacity apply **once, after** selection, and only when the decision
queues a new unowned agent dispatch (`queue.intent: dispatch` with actor
reviewer, remediator or hammer). Drain wins over capacity. Capacity counts only
when the actor's class reports finite `inFlight >= cap`. The decision keeps its
action, actor, reason and intent; only `queue.deferredBy` and an evidence
reference change.

Carry rules. A context-only rebase carries the reviewed verdict only with a
`semantic: true` proof of kind `context-only-rebase` for the exact
reviewed→current head pair. Ancestry, inherited trailers and ticket ownership do
not carry it. A HAMATTEST-02 closer carry needs the exact head pair. Evidence
bound to another head (lease, launch, receipt, cap, carry) confers nothing.

Deadlines anchor at the latest durable anchor at or before the observation
(`anchors.*`, plus check transitions for R11). Future stamps are ignored. With
no durable anchor, the observation time is used and labelled
`anchorSource: observed`, which is not durable. Budgets: refresh 60 s;
admission/retry and evidence recovery 5 min; observer 30 min (the legacy
pending-gate bound); live owners use their own deadline, or else the
unscaled closer-lease reclaim ages.

## Adapter projections

| Consumer | Projection | Retained execution mechanisms |
|---|---|---|
| Hammer wake | selected unowned hammer or daemon intent; deferral suppresses transport only | attempt-aware wake election, retention, delivery retry |
| Remediation closeout | `closeoutRereview` retains the decision and durable admission intent | round accounting, publication/final-push proof, watcher claim CAS |
| Closer | shared hammer intent; predicate results replace observations | structural restrictions, exact-head proofs, terminal settlement, bounded retries, class caps, leases |
| Daemon | selected daemon actor; live facts invalidate the generation | HCP/identity, required checks/protection, arming, shared merge lease |
| Rescue | action/actor/queue to compatibility diagnostics | recovery and unreadable ownership never become launch permission |
| Automated recovery | selected reviewer/hammer dispatch, otherwise owned observation | flock, request reservation, attempt cap, alert debounce/refund |
| Orphan recovery | selected reviewer/hammer dispatch after ownership proof | durable idle/attempt history, process/ledger proof, request CAS |
| No-progress | explicit hold selects operator lane; other workflows keep their actor | durable debt, drain observation, scheduler backoff and starvation recovery |

Deleted policy includes reason allowlists for repair, final-round resume/grace
selection, daemon decline classifiers/counter-based escalation, background
mergeability admission refusal, the legacy closure-owner and rescue tables,
and independent no-progress/orphan/automated-recovery successor selection.
Existing pure merge predicates and structural repair restrictions remain.

## Shadow consumers

| Source tag | Where | Evidence |
|---|---|---|
| `closure-orchestration` | selected shared workflow in `maybeDispatchAmaClosureFor` | NXA-01 pass snapshot when present, plus closure-owner input; the launch observation comes from NXA-01's ledger seam inside the shadow's own promise (bounded at 5 s) |
| `posted-review` | handler outcomes above | the same pass decision the orchestration registered |
| `no-progress-lane` | lane gate | a legacy note that the next pass decision for the same subject and head compares |
| `dispatch-closer-handoff` | handed-to-review owner in the closer | closer review state, PR metadata, handoff lease |
| Historical `rescue-classifier` records | read-only rollout evidence | no independent classifier remains |
| `hammer-owner-route` | route-ending page | the same pass decision registered by its coexistence call |
| `watcher-handoff-wake` | `pollOnce` handoff wait | subject, handoff lease, raw review row |

Historical telemetry adapters do not select execution. Consumers import only the
consumer seam, which imports nothing. It evaluates and copies the evidence
synchronously, then loads the shadow lazily, so a short-lived process that never
reaches a shadow call pays no load cost. The shadow never throws, never rejects,
prints nothing and is inert under the offline runner unless a test installs a
sink. Records are appended to
`<root>/data/next-action-shadow/disagreements.jsonl`, which rotates once at
16 MiB. Each record has `schema`, `kind` (`disagreement` | `overdue`),
`observedAt`, `source`, `subjectKey`, `passId`, `generation`, `head`, `fields`,
`legacy`, `next` (with `deadline`, `decisionKey`, `row`, `queue`),
`evidenceRefs` and `caseKey`. `caseKey` identifies a distinct case: subject,
head, legacy triple and next triple, independent of source and pass. Only
disagreements carry `fields`, `legacy` and `caseKey`; overdue records instead
carry `ageMs`. The canonical [data-model contract](data-model/next-action-shadow.md)
defines both variants, retention and failure behavior.

Round enrichment preserves complete remediation evidence from the original
pass, including an in-progress job, unless a consumer supplies replacement job
evidence. Confirmed terminal ledger launches on an observed open PR are
no-merge outcomes regardless of process success or stale lease status; readable
retry descendants and retry/lifetime caps still determine retry ownership.

Overdue decisions are recorded once per decision per process. They reach the
existing closure-wait alert path (SQLite debounce, refund on transport failure,
retry next pass) only when `AMA_NEXT_ACTION_OVERDUE_ALERTS=1`. Expiry and alert
availability never gate execution.

## Rollout

The retained operator/SRE rollout procedure calls for classifying at least
20 distinct **live** disagreement cases, including at least one candidate mistake
and one expected correction. Repeats of one case count once. This source
deletion does not establish that live evidence; the procedure remains separate
from worker validation and does not introduce runtime admission conditions. Run:

```bash
node bin/next-action-disagreements.mjs --root <deployed root> \
  --dispositions <private dispositions.json>          # full case list
node bin/next-action-disagreements.mjs --root <deployed root> --aggregate   # anonymous counts
```

The tool reads at most `--max-bytes` (default 8 MiB, maximum 64 MiB) from the end
of the log. It never writes and always exits 0. Dispositions stay in the rollout
owner's private file, outside this repository (`{ "<caseKey>":
"candidate-mistake" | "expected-correction" | "needs-investigation" }`). Publish
only `--aggregate` output and synthetic reproductions. `rollout.evidenceSufficient`
is guidance for human acceptance. It is not a CI, runtime or pre-push gate. Missing cases remain pending operator acceptance; rollout evidence never becomes
a runtime refusal or removes an adopted workflow owner.

Known limits of the shadow evidence:

- Live-lease windows use the unscaled closer-lease reclaim ages, and no PID
  probe runs. A lease that the load-aware executor still honours can therefore
  read as `lease-expired`.
- Consumers without durable anchors produce `anchorSource: observed` deadlines.
- Partial snapshots lacking PR state or ownership evidence select an owned
  refresh/reconciliation through `R00`/`R04`.
