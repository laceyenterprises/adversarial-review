# REVIEWROUNDLEDGER-01 - one per-PR round ledger

## Summary

The per-PR remediation budget was derived from follow-up job files only.
Closure hand-off jobs were seeded at round 0, so their comments printed
"round 1 of 1" again. Hammer passes, in-place HQ PR-updates and operator
retriggers were never charged. The non-blocking streak was keyed by round
number, so separate jobs that carried the same number collapsed into one entry.

`src/pr-round-ledger.mjs` adds an append-only JSONL ledger per PR. Every
producer writes one line per round with a stable `roundId`, and the ledger is
folded into `summarizePRRemediationLedger`. Every existing budget consumer now
reads the all-source count: claim seeding, the claim cap, first-pass review
suppression, exhausted-head admission and hold-release routing. The claim lifts
a normal job's round to the PR-wide count. Once the tier budget is spent, the
follow-up daemon stops the job `max-rounds-reached` and hands it to the hammer,
whichever producer spent the rounds. Remediation comments show the PR-wide
`round N of B` and a ledger summary.

## Interface changes

- New store `data/pr-round-ledger/*.jsonl`; see
  `docs/data-model/pr-round-ledger.md`.
- New optional job field `remediationPlan.prRound`; see
  `docs/data-model/follow-up-jobs.md`.
- `summarizePRRemediationLedger` returns `prRoundLedger` once the PR has ledger
  lines. `completedRoundsForPR` is now the max of the job-derived and ledger
  counts.
- New CLI `bin/pr-round-ledger.mjs show|record|void`. `record` accepts only
  `--kind hq-pr-update`, for HQ's in-place PR-update hook.
- `retrigger-review` records an operator-charged round before the reset and
  voids it on refusal or failure. Its audit row carries `prRoundLedger`
  (`chargedTo`, `overBudget`, summary).
- Tier budgets, strict mode and reviewer prompts are unchanged. `high` already
  has a tier value (2) in `src/kernel/convergence-budget.mjs`.

## Verification

- `node --test test/pr-round-ledger.test.mjs`: 9 pass.
- `node --test` on `follow-up-jobs`, `follow-up-pr-ledger`,
  `follow-up-settled-non-blocking`, `pr-comments`, `retrigger-review`,
  `ama-hammer-retry-cap`, `single-review`, `remediation-closeout-next-action`,
  `watcher-claim-loop`, `ama-closer-dispatch-priority`: all pass.
  `follow-up-review-claim` has 1 failure that also fails on unmodified
  origin/main.
- A concurrent sweep of the 140 test files that import the touched modules
  failed 97 tests; the same sweep on origin/main failed 100. The two files that
  failed only on this branch pass on their own.
- `npm run lint` on changed files: 0 errors. `npm run typecheck:contracts`: pass.
  `bash demo/research-finding-walkthrough.sh`: pass.
