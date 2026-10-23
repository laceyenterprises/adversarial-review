# Shared next action: rows and legacy reason inventory (NXA-02)

Spec: `pr-next-action@c216a174c80e`. Module: [`src/pr-next-action.mjs`](../src/pr-next-action.mjs).
Consumer seam (adapters, evidence builders, lazy hook): [`src/pr-next-action-consumer.mjs`](../src/pr-next-action-consumer.mjs).
Shadow: [`src/pr-next-action-shadow.mjs`](../src/pr-next-action-shadow.mjs).
Rollout report: [`bin/next-action-disagreements.mjs`](../bin/next-action-disagreements.mjs).

This page is **design documentation, not an enforced registry**. Nothing reads
it. A new legacy reason needs no entry here, and no code refuses an unknown
reason: the adapter passes unknown reasons through unchanged and the shadow logs
the disagreement.

## Status

`nextAction(snapshot)` runs in **shadow only**. `decideClosureOwner`
(`src/ama/closure-owner.mjs`, frozen v1) and its consumers keep authority and
all effects. No caller is switched. A switch requires the human rollout
acceptance in [Rollout](#rollout); this ticket authorizes no switch,
production observation or rollout.

There is one successor policy owner. `decideClosureOwner` remains the frozen
legacy authority until a caller switches; at that point the legacy table is
deleted, not kept as a second policy. `fromLegacyClosureOwner` expresses every
legacy output in the new vocabulary so the shadow compares the two tables. The
adapter translates faithfully and does not correct: a legacy `page` stays
`operator-hold` there, so the shadow shows where the new table names a recovery
owner instead.

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
| R04 | leases unreadable; launch unreadable while this head's lease references it; unreadable retry descendants; in-flight lease past its window | hammer / closure-recovery / `ownership-unreadable`, `lease-expired` | recovery 5 min |
| R04→R05 guard | execution policy missing, unreadable or without a boolean execution switch; established owners and ownership reconciliation above retain precedence | wait-for-CI / watcher / `policy-unknown` | refresh 60 s |
| R05 | empty diff; primary-change reverted/unknown, unreadable or other; deterministic safety refusal | hammer / closure-recovery / `empty-diff-close`, `primary-change-unreadable`, `safety-refusal`; hammer / hammer / `primary-change-repair`; refresh / `structural-restriction-pending` | recovery or admission |
| R06 | merge receipt for this head while the PR is observed open | daemon-merge\|hammer / closure-recovery / `merge-receipt-unconfirmed` | recovery 5 min |
| R07 | deterministic automatic stop fingerprint; automation-applied hold label; retry cap exhausted on this head; lifetime cap; hammer's final no-merge on this head | hammer / closure-recovery / `automated-stop`, `retry-exhausted`, `lifetime-exhausted`, `hammer-final-no-merge` | recovery 5 min |
| R08 | terminal no-merge (including exit zero) with retry remaining | hammer / hammer / `retry-no-merge` (attempt + 1) | admission 5 min |
| R09 | failed CI (any non-success terminal state) or runner-less failure | remediate / remediator / `ci-red` (round); hammer / hammer / `ci-red-final`, `ci-runnerless`; refresh `rounds-unknown` | admission |
| R10 | mergeable CONFLICTING or mergeStateStatus DIRTY | hammer / hammer / `conflict-rebase` | admission |
| R11 | checks pending (an empty rollup fails closed as pending) or mergeability UNKNOWN | wait-for-CI / ci / `checks-pending`, `mergeability-unknown` | observer (pending-gate bound), anchored at the latest check transition |
| R12 | proven suppressed final-round push at this head | hammer / hammer / `suppressed-final-push` | admission |
| R13 | invalid attestation; closer rereview decision; no current-head verdict without semantic or attested carry; review ceiling | review / reviewer / `attestation-invalid`, `exact-head-review`, `stale-verdict`, `handed-to-review`; hammer / hammer / `review-ceiling` | admission |
| R14 | findings (or unknown finding state) on the current/carried head | remediate / remediator / `review-findings` (round); hammer / hammer / `review-findings-final` | admission |
| R15 | clean verdict (strict mode honoured), green, MERGEABLE, attestation not unknown | daemon-merge / daemon / `clean-exact-head`, `carried-clean-head` | admission |
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

## Legacy reason → row

### `decideClosureOwner` (`src/ama/closure-owner.mjs`)

| Legacy owner / reason | Adapted (action / actor / reason) | New row |
|---|---|---|
| `close` / `empty-diff` | hammer / closure-recovery / `empty-diff-close` | R05 |
| `page` / `primary-change-needs-operator` | operator-hold / operator / `primary-change-repair` | R05 (`primary-change-repair`, hammer) |
| `wait` / other primary-change reasons | wait-for-CI / watcher / `snapshot-refresh` | R05 refresh or R04 |
| `wait` / `dispatch-status-*` (parked or deferred launch) | hammer / hammer / `live-owner` | R03 |
| `wait` / `in-flight:*` | hammer / hammer / `live-owner` | R03, or R04 when liveness is unreadable |
| `page` / `in-flight-lease-expired` | operator-hold / operator / `lease-expired` | R04 |
| `review` / `exact-head-review` (closer rereview) | review / reviewer / `exact-head-review` | R13 |
| `hammer` / `ci-blocked-remediation-exhausted` | hammer / hammer / `ci-red-final` | R09 |
| `hammer` / `review-ceiling-stale-head` | hammer / hammer / `review-ceiling` | R13 |
| `page` / `review-rounds-exhausted` | operator-hold / operator / `review-findings-final` | R09 / R13 / R14 by evidence |
| `page` / `hammer-retry-cap`, `hammer-lifetime-cap` | operator-hold / operator / `retry-exhausted`, `lifetime-exhausted` | R07 |
| `hammer` / `review-findings` | hammer / hammer / `review-findings-final` | R14 |
| `remediation` / `review-findings` | remediate / remediator / `review-findings` | R14 |
| `follow-up-drain` / `clean-review-drain` | remediate / remediator / `clean-review-drain` | R03 (job in progress) or R15 |
| `conflict-rebase` / `conflict-rebase` | hammer / hammer / `conflict-rebase` | R10 |
| `hammer` / `required-checks-red` | hammer / hammer / `ci-red-final` | R09 (remediation first if a round is left) |
| `wait` / `pending-mergeability`, `pending-required-checks` | wait-for-CI / ci / `mergeability-unknown`, `checks-pending` | R11 |
| `page` / `pending-gate-budget-exhausted` | operator-hold / operator / `checks-pending` | R11 (overdue report, no refusal) |
| `daemon-merge` / `clean-exact-head` | daemon-merge / daemon / `clean-exact-head` | R15 |

Two expected corrections are visible in this table. Legacy routes failed CI only
after a clean verdict, while the new table sends it to a remaining remediation
round first (R09). Legacy treats a non-`FAILURE` terminal check state (for
example `TIMED_OUT`) as pending; the new table treats it as failed.

### Closure orchestration final owner (`src/ama-closure-orchestration.mjs`)

| Legacy | Adapted | Row |
|---|---|---|
| result `dispatched` → `hammer` / `dispatched` | hammer / hammer / `live-owner` | R03 |
| result `daemon-merged` | daemon-merge / daemon / `merged-this-pass` | R01 on the next pass |
| `boundedWait` → `wait` / `page` with the wait reason | as above, by reason | as above |
| `handed-to-review` wait | review / reviewer / `handed-to-review` | R13 |

### Posted-review handler (`src/posted-review-row.mjs`)

| Legacy outcome | Adapted | Row |
|---|---|---|
| `pr-terminal` (merged/closed) | done / none / `merged`, `closed` | R01 |
| `operator-skip-label` | operator-hold / operator / `hold-label` | R02 |
| `await-operator` (stacked-base hold) | operator-hold / operator / `needs-operator` | R04/R05 by evidence |
| closure-owner outcomes | compared at closure orchestration (same pass decision) | — |

### No-progress lane (`src/watcher-no-progress-lane.mjs`)

| Legacy lane | Adapted | Row |
|---|---|---|
| `operator-blocked` (`operator-decision-required`) | operator-hold / operator / `operator-decision-required` | R07 or the semantic row; only explicit holds are R02 |
| `deferred-by-drain` | not an ownership claim | drain overlay (`queue.deferredBy: drain`) |
| `active`, `slow` | scheduling only; not compared | — |

### Rescue classifier (`src/merge-agent-rescue-classifier.mjs`)

`classifyClosureOwnership` maps the legacy owner to rescue decisions
(`page-required`, `wait-closer`, …). The shadow compares the underlying legacy
owner. Rescue input carries no PR state, so its shadow decision is `R00`. Read
those records as an evidence gap, not as a policy disagreement.

### Hammer-owner route (`src/hammer-owner-route.mjs`) and watcher handoff wake (`src/pollonce-phases.mjs`)

| Legacy | Adapted | Row |
|---|---|---|
| route page `hammer-no-merge` | operator-hold / operator / `hammer-final-no-merge` | R07 |
| route page `hammer-cap-exhausted` | operator-hold / operator / `retry-exhausted` | R07 |
| handoff wake wait `handed-to-review:<head>` | review / reviewer / `handed-to-review` | R13 |

## Shadow consumers

| Source tag | Where | Evidence |
|---|---|---|
| `closure-orchestration` | final legacy owner in `maybeDispatchAmaClosureFor` (covers both `decideClosureOwner` calls and page overrides) | NXA-01 pass snapshot when present, plus closure-owner input; the launch observation comes from NXA-01's ledger seam inside the shadow's own promise (bounded at 5 s) |
| `posted-review` | handler outcomes above | the same pass decision the orchestration registered |
| `no-progress-lane` | lane gate | a legacy note that the next pass decision for the same subject and head compares |
| `dispatch-closer-handoff` | handed-to-review owner in the closer | closer review state, PR metadata, handoff lease |
| `rescue-classifier` | `classifyClosureOwnership` | closure-owner input |
| `hammer-owner-route` | route-ending page | the same pass decision registered by its coexistence call |
| `watcher-handoff-wake` | `pollOnce` handoff wait | subject, handoff lease, raw review row |

Legacy decisions and their inputs are unchanged. Consumers import only the
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

Before the first caller switches, an authorized operator/SRE classifies at least
20 distinct **live** disagreement cases, including at least one candidate mistake
and one expected correction. Repeats of one case count once. Run:

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
is guidance for human acceptance. It is not a CI, runtime or pre-push gate. If
cases are insufficient, legacy keeps authority and the missing rollout evidence
is stated.

Known limits of the shadow evidence:

- Live-lease windows use the unscaled closer-lease reclaim ages, and no PID
  probe runs. A lease that the load-aware executor still honours can therefore
  read as `lease-expired`.
- Consumers without durable anchors produce `anchorSource: observed` deadlines.
- The rescue classifier and bare pass snapshots lack PR state or ownership
  evidence and decide `R00`/`R04`.
