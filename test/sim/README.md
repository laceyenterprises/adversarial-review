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
subject eventually recovers. Clock events run serially, except an explicit
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
