# PR with no reviewer and no hammer after the review-cycle cap — 2026-10-11

Operator: "On launch all fixes".

## Evidence

Agent-os PR 8044 reached five review cycles at 06:34Z and was routed to the
hammer. At 06:36–06:38Z the hammer stopped with `primary-change-unknown`;
the evidence helper defect was repaired by PR 1262 shortly afterward.
At 06:57Z a worker pushed a merge of main. For roughly four and a half hours
neither a reviewer nor a hammer owned the PR. The ledger retained a failed
`[review-cycle-cap]` row and its old `revision_ref`. Generic retry admission
rejected that failure as non-recoverable before the cap-to-hammer hook ran.
An unattributed `retrigger-review` label also produced the same warning each tick.
At 11:31Z the operator applied `merge-agent-requested`; review resumed, the
hammer launched at 12:03Z, and the PR merged at 12:21Z.

## Repair

CAPROUTE-01 routes the capped row before generic reviewer retry admission and
stale posted-review handling. Each new head reaches the existing hammer owner
route while preserving the last actual reviewed head. The closer retains its
lease, retry cap, lifetime ceiling, and merge predicates. Final-outcome pages
say the PR has neither a reviewer nor a hammer and name existing overrides.

Evidence-collection stops (`primary-change-unknown` and
`primary-change-read-failed`) retain a durable hold. Every closer evaluation
for an open PR probes the read-only helper once, even before eligibility can
return early. A computable answer releases the hold through the same persisted
release as changed inputs. A computable refusal does not authorize merging.
A repaired collector permits bounded hammer retry rather than making an
evidence gap the hammer's final adjudication.

The label consumer removes an unattributed `retrigger-review` label without
resetting review or inventing an actor. Its caller logs one result. A failed
removal remains retryable. The watchdog in this repository refreshes the ledger
and requests a watcher wake directly, so an already-present label cannot swallow
that request. The external rescue/watchdog label producers are outside this
repository: they still need remove-and-re-add when requesting another label
signal on an already-present label. This change does not edit those producers.

## Regression coverage

Offline fixtures cover the real watcher polling a capped failed row with a
stale revision across two live heads, the real closer retrying after collector
repair for both evidence predicates, final no-merge isolation to its own head,
per-pass probe counts, existing caps, page wording, and unattributed label
removal. No CI job, config key, cap value, remediation budget, or dead-hammer
rearm policy changes.
