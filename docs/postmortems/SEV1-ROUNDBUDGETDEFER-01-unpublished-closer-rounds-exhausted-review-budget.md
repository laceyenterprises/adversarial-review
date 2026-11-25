# SEV1 — unpublished closer rounds exhausted the PR review budget

Date 2026-11-25. Ticket ROUNDBUDGETDEFER-01.

## Impact

Autonomous closure stalled for roughly three hours. The eligible set shrank
while open PRs accumulated and closer capacity remained available. Affected
branches needed repair-in-place dispatch or operator intervention.
Local validation deferrals dominated terminal reconciliation during the
incident. Exact-head GitHub CI authority addressed the local UNKNOWN verdict,
while the charges from earlier deferrals persisted.

## Reproduction and cause

The offline fixture records two attempts against the same synthetic head on
a medium-risk PR. Both end `retryable-canonical-validation-deferred` with no
push receipt. On the original code the fixture reported two completed
remediation rounds, `reviewCycleExhausted === true`, and no closer dispatch
intent. The rescue repair cause for that exhausted budget is
`review-cycle-exhausted`.

`recordHammerPrRound` in `src/ama/hammer-retry-cap.mjs` writes a round on
dispatch. `summarizePrRoundLedgerEntries` in `src/pr-round-ledger.mjs` counted
every live stamp as spent. `summarizePRRemediationLedger` in
`src/follow-up-jobs.mjs` took the maximum of that tally and the job-derived
count. Closure orchestration passed the result to
`reviewCycleExhaustedFromRounds`. Terminal reconciliation released the lease,
but the review-cycle ledger still charged the attempt.

## Correction

The budget read joins each recorded closer attempt to the exact launch's
terminal receipts and publication evidence. A distinct pushed head counts
through a later deferral, as do an authoritative merge, a substantive refusal,
and an operator terminal. An unpublished infrastructure stop spends zero.
Existing closer backoff paces repeat deferrals. Publication alone does not
grant merge permission. The settled verdict and exact-head CI gates continue
to determine whether a merge is authorized.

Existing automatic budget handoffs are evaluated on the next watcher pass.
An automatic handoff can still route work to a closer when corrected evidence
removes exhausted-cycle authority. Explicit operator holds and escalations
retain custody. The fixtures use generated receipts and disposable state.

## Deployment verification

After ordinary deployment, the runtime owner observes naturally affected PRs
regain eligibility and settle without operator repair. Correlate
`ama.closer_queue_depth` and individual closure dispositions, since aggregate
backlog also changes as PRs land. Confirm that published rounds still count
and that held heads retain their owner. Deployment verification is pending.
