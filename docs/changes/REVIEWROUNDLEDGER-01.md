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

Final comment-only remediation orders the non-blocking streak by terminal time,
normalizes record/void round IDs identically, and preserves hammer ledger domain
identity on charge and refund. The CLI resolves the risk-tier budget before the
first ledger write, including for exhausted legacy jobs.

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
- Round IDs are trimmed and truncated to 300 characters for both operations.
  Store schema, lifecycle states and smoke promises are unchanged.
- The alleged missing `targetRevisionRef` is already present in the reviewed
  head's retrigger call. The existing live-head integration test passes through
  the production request validator and persists the correct request head;
  no retrigger implementation change is needed.

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
- Final remediation: `node --test test/pr-round-ledger.test.mjs
  test/retrigger-review.test.mjs`: pass (17 ledger tests and 56 retrigger tests).
  Regressions cover non-monotonic round numbers, legacy exhaustion at all four
  risk tiers, domain-preserving hammer dispatch/reservation refunds, and round-ID
  normalization.
- Final remediation guards: `npm run lint` (0 errors, 149 warnings),
  `npm run typecheck:contracts`, `node scripts/validate-data-model-catalog.mjs`
  (96 entries), `bash demo/research-finding-walkthrough.sh` and
  `git diff --check`: pass. Full local test suite intentionally deferred to
  PR-head CI.
- `node test/run-tests.mjs test/follow-up-jobs.test.mjs
  test/follow-up-pr-ledger.test.mjs`: 188 pass. Broader hammer/watcher file runs
  exceeded the 60-second and 180-second local bounds; they are not claimed as
  passing. The ledger regression suite directly covers both hammer recording
  entrypoints and their domain-specific no-work refunds. Full-file completion
  remains with PR-head CI.
