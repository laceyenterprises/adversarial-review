# Finalization simulator

MLR-05's offline, discrete-event oracle for the existing v2 fold and leased
executor. All subjects, payloads, timestamps, launches and effects are synthetic.
The nine historical PR identifiers are scenario names only; they are never
queried or used as subject keys. No token, network, GitHub, HCP, database, host
clock, sleeps or Agent OS installation is needed to run the tests.

Run the ordinary test entry point (also discovered by `npm test`):

```sh
node --test test/finalization-simulator.test.mjs
```

The bridge imports `oracle-suite.mjs`, whose filename avoids duplicate discovery
by recursive `*.test.mjs` runners.

`clock.mjs` orders events by virtual time and insertion order. A seeded PRNG
jitters read completion; supplied CPU/load evidence drives the shared
`loadAwareTimeoutMs` primitive with finite ceilings. Reads and operation durations
slow with load. Episode anchors and the absolute end bound do not slide when
polling. Every event, ledger append and observed execution effect invokes the
independent oracle; the trace retains first and later violations even if the
subject eventually recovers. Oracle observations reuse eligibility for the
same ledger and virtual timestamp, and read current effects at every observation.
Mutation probes get their own effect copies and recompute eligibility for each
observation. A read gets the current immutable event snapshot. An append publishes a
new snapshot and leaves earlier snapshots intact. The executor continues to
fold each read through its own path. Both simulator executor entrypoints reject
deferrals whose details report a frozen-object mutation, so a production catch
cannot silently hide an incompatible reader. A leased-read mutation fixture
exercises this failure through the real executor. Clock events run serially, except an explicit
concurrent-owner scenario that races two real executor ticks against one fake CAS.

`simulator.mjs` runs the production `fold`, `eligible` and executor. Its in-memory
ledger validates event shapes; fake leases fence concurrent ticks. Fake GitHub
models head/base, checks, verdicts, mergeability, an expected-head merge guard and
idempotent merge receipts. Fake admission/runtime models typed refusals, delayed
starts, outcomes, crashes and kills. Identity reads model an HCP bounce. A crash
after the external merge effect leaves no finalized ledger mark until replay
reconciles the receipt. The head-race case moves the head during identity checking,
after the executor's decision, exercising the merge surface's revision guard.

The oracle checks seven predicates (the five spec invariants expanded into
observable ownership, custody, progress, safety, paging and retry checks):

| Predicate | Evidence checked |
| --- | --- |
| `owner-deadline` | One owner at the current head, with a finite unexpired deadline |
| `bounded-terminal` | Finalized with merge and activation evidence, paged escalation, or explicit operator hold by the absolute bound |
| `fresh-merge` | Actual merged revision equals the live head at the effect |
| `addressed-findings` | No outstanding blocking or non-blocking finding at merge |
| `page-once` | Exactly one page receipt for each escalation cause; no unrelated page |
| `transient-retry` | No terminal refusal or round charge for transient infrastructure/admission/kill outcomes |
| `live-custody` | An agent owner has verified running evidence, never a terminal/dirty holder |

`bad-policies.mjs` supplies isolated, deliberately invalid policies. Each is
rejected by the corresponding predicate; positive observations prevent an
always-failing oracle from passing. Additional tests cover missing pages,
multiple owners, activation gaps, transient refusals, comment coverage, replay,
head moves, admission and concurrent ownership.

## Requirements generation

Regeneration is an explicit offline build step; normal tests read only the
committed synthetic library. From this repository:

```sh
node test/sim/generate.mjs /path/to/agent-os/projects/merge-lane-rebuild/requirements.json
node test/sim/report.mjs --write-baseline
```

`recipes.mjs` deliberately maps every requirement identity to an executable fault
recipe. The generator refuses unknown or duplicate requirement identities instead
of silently assigning a generic happy path. `scenarios.json` contains stable IDs,
recipe selections and the SHA-256 of the source ledger, without copying incident
records or prose. It includes all 61 requirements and nine named parked subjects.
A future requirements row needs a reviewed recipe before regeneration succeeds.
The generator's coverage test uses a synthetic source, so tests need no companion
checkout. Re-run generation against the canonical ledger when its rows change.
Each parked PR must provide a non-empty `requirementIds` array containing only
known requirement IDs; invalid lists are rejected before selecting a recipe.

## Baseline and limits

`baseline.json` records the current implementation's pass/fail table for MLR-06:
78 scenarios at loads ×1, ×3 and ×6, seed 17. Each row lists failing predicates,
unmet recovery obligations and the final ledger state. Predicates absent from
`failed` passed on every observed step in that run; this includes predicates
whose trigger did not occur. The file pins hashes of the fold, eligibility and
executor that were measured. `report.mjs` prints a fresh table; baseline writing
is explicit, never performed by the tests. When MLR-06 changes those modules,
review the changed table and traces and replace this historical expectation
intentionally. A green baseline test means reproducibility, not v2 readiness.

Current gaps include missing decision ownership/deadlines, escalations recorded
without page receipts, typed admission refusal charged as dispatch, kills
terminalizing final remediation, and missing owned conflict/custody/provenance/
activation recovery. The oracle does not invent a recovery owner, page receipt,
activation proof or salvage operation to make the current implementation pass.
`unmet` preserves obligations that cannot yet be expressed by the existing
fold/executor. The owner predicate consequently fails even in clean scenarios;
the isolated positive/negative oracle tests separately exercise custody checks.

These are seam-level scenarios, not a complete proof of every requirement's host
integration. Credential ACLs, config loader parity, parser/model separation,
metric principal attribution, NXA enumeration and actual loaded-code health need
their owning adapters' tests. Fault recipes express their consequences at the
finalization boundary; a passing recipe does not certify those integrations.
No ledger SQL is changed or exercised, so SQLite/Postgres parity is outside this
change. Queue coverage is its real pure replay fold, not the git/build executor.
Rollback uses a synthetic v1 adopter of the same events, budget, queue and
routing fence while remediation is in flight; it proves the handoff model, not
production v1 adoption or live rollback readiness. MLR-06/08 must supply that
integration evidence before activation.

This artifact deploys through ordinary source merge. It adds no production
behavior or activation step. Read-only acceptance is the offline report and
recorded baseline; watcher deployment, configuration and restarts belong to the
operator/SRE cutover tickets.

## Live-adapter patterns (MRQ-11)

`live-patterns.mjs` holds the scenario library for the v2-wrong shadow patterns
that the divergence adjudication traced to the live adapter rather than the pure
fold. Each scenario feeds synthetic canonical next-action snapshots through the
production `recordLiveShadow` into an in-memory store. It then checks the
recorded v2 decision, its classification and that the pattern is keyable.
`live-pattern-suite.mjs` runs from the same bridge (`finalization-simulator.test.mjs`).
Each scenario records the adjudicated pre-fix decision as `before`. Running
the suite against the pre-MRQ-11 sources fails every non-regression scenario.
Scenarios marked `regression` pin behaviour that must not change: a live hammer
lease still wins, and a terminal launch releases custody so remediation proceeds.

| Defect | Scenarios | Corrected decision |
| --- | --- | --- |
| D1 owner/custody blindness | P01, P09, P10, P13, P17, P27, P31 | A launch the ledger reports held becomes launch custody: wait (`launch requires verified progress`), never escalate or remediate. Unreadable ownership at the head is a typed unknown. |
| D2 suppressed-review heads | P04, P05, P14 | A completed comment-only final-round push is a final remediator head: `request-reexact-review`. |
| D3 operator-decision holds | P06 (+ owner regressions) | Label-gated findings escalate as an operator decision only after the live-owner and custody gates. |
| D4 spent rounds | P11 | Spent v1 rounds exhaust the review stage: final coverage-gated remediation. |
| D5 observed merge | P20, P21 | `merge_observed`; no post-merge mergeability; classified as concurrence. |
| D7 unkeyable details | null bucket | Stable keys for label-gated, repair-owner-unproven and disputed-findings details. |
| D8 untyped fold errors | checks, verdict, out-of-order, post-merge | Typed `refresh-evidence` unknowns, never `foldError`. |

The discrete-event library, `scenarios.json`, `baseline.json` and its pinned
module hashes are unchanged: the generated requirement scenarios do not supply a
live owner snapshot, so the new adapter evidence and snapshot-derived gates do
not reach them.
