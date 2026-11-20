# SEV1 — Remediation completion waited for closer dispatch

Ticket `CLOSERLATENCY-01`

scars: merge.finding-remediation-and-authoritative-terminal, adversarial-review.verdict-bound-to-current-head

## Impact

A closer launch must exist within 10 minutes of remediation `completedAt`
for every PR whose next action is a closer. In the incident sample, the
median observed launch exceeded the target, the upper tail approached an
hour, and the slowest launch took over an hour. A substantial fraction of
completions had no observed subsequent launch in the sampled window.

## Cause

The watcher consumed wake hints as part of a normal poll. The PR discovery
loop walked subjects in sequence, and posted reviews then competed for four
handler slots. Slow closure observations kept slots occupied and forced
eligible work to wait for the watcher to reach it. A remediation completion
could not directly put its PR in front of that work.

## Synthetic reproduction

In a synthetic pass, three posted reviews run through the real gate,
candidate and coexistence handlers with fake GitHub results and a delayed
daemon lease-status observation. The slowest named sub-call in the sample was
`observeClosureRefreshLoop` at 108 ms. The three injected ledger waits
measured 61–62 ms each. There were 19 mocked subprocess calls across the
three PRs, including two GitHub subprocess calls per coexistence decision.
These measurements describe the fixture. The separate scheduler fixture fills all four
posted-review slots. Recording a remediation completion while those slots
are occupied starts the priority decision before any of the slow work
finishes. Reprocessing the completion preserves the existing closer lease.

## Correction and verification

The watcher drains completion events independently using the ordinary
posted-review closure handler. The coexistence caller yields after a bounded
wait while the active attempt retains its custody. Positive live status can
be shared within a batch. Other evidence goes through the usual read and
reconciliation. Closure health and queue logs report the interval to the
first confirmed launch receipt.

Verify deployed performance by joining completed jobs to confirmed launch
records and counting closer-owned completions without a launch separately.
The latency metric describes confirmed launches, so the join is necessary to
measure the whole SLO population.
