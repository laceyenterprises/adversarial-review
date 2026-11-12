# Data Model - Per-PR round ledger (REVIEWROUNDLEDGER-01)

Owner: follow-up remediation queue. Source of truth: `src/pr-round-ledger.mjs`.
Store: `data/pr-round-ledger/<domain>--<owner__repo lowercased>-pr-<N>.jsonl`.

One append-only JSONL file per (domain, repository, PR). Every producer of a
review pass or remediation round appends one line, so the PR's round count no
longer depends on one producer's history. Readers de-duplicate by `roundId`:
a retried or racing second write of the same round is the same round, and two
different rounds can never collapse into one entry.

| Field | Contract |
|---|---|
| `schemaVersion` | `1`. |
| `op` | `record` or `void`. A `void` uncharges a live round; a later `record` of the same id charges it again. |
| `roundId` | Stable id, trimmed and truncated to 300 characters on both record and void. `follow-up:<jobId>:r<round>`, `hammer:dispatch:<dispatchKey>` (or `hammer:lrq:<id>`), `operator-retrigger:<idempotencyKey>`, `review:<head>:<createdAt>`, or the caller's id for `hq-pr-update`. |
| `kind` | Remediation kinds: `follow-up-blocking`, `follow-up-non-blocking`, `final-fix-all`, `conflict-primary`, `hammer`, `hq-pr-update`. Review kinds: `review-pass`, `operator-retrigger`. |
| `class` | `remediation` (spends the tier budget) or `review` (visibility only). |
| `chargedTo` | `pipeline` or `operator`. An `operator-retrigger` is always `operator`. A follow-up round run under an operator override, or past the job's budget, is `operator`. A CLI-recorded HQ PR-update after the budget is spent defaults to `operator`. |
| `repo`, `prNumber`, `domainId`, `headSha`, `jobId`, `launchRequestId`, `actor`, `source`, `reason`, `recordedAt` | Identity and provenance. |

Writers:

| Producer | When | Kind |
|---|---|---|
| `markFollowUpJobSpawned` | the remediation worker spawned | `follow-up-*`, `final-fix-all`, `conflict-primary` |
| `requeueInProgressFollowUpJobForRetry` | transient requeue (the next claim reuses the round number) | `void` |
| `createFollowUpJob` | a posted review queued its follow-up (closure hand-offs excluded) | `review-pass` |
| `recordHammerRetryDispatch`, `reserveHammerRepairDispatch` | a hammer dispatch was charged | `hammer` |
| `refundUnexecutedHammerDispatch` | the dispatch never executed | `void` |
| `retrigger-review` | before the review reset; voided if the reset is refused or throws | `operator-retrigger` |
| `bin/pr-round-ledger.mjs record --kind hq-pr-update` | an in-place HQ PR-update finished | `hq-pr-update` |

Hammer records and refunds preserve the caller's `domainId`, defaulting to
`code-pr` when omitted.

Readers:

- `summarizePRRemediationLedger` folds the ledger in. `completedRoundsForPR` is
  `max(job-derived count, ledger remediation rounds)`. Follow-up rounds of a job
  still pending or in progress are excluded, as the job-derived scan excludes
  them. Rounds from other producers also add their `recordedAt` to
  `completedRoundTimestamps`. The summary is returned as `prRoundLedger` once the
  PR has ledger lines. Every budget consumer reads this count: claim seeding, the
  claim cap, first-pass review suppression, exhausted-head admission and
  hold-release routing.
- `claimNextFollowUpJob` lifts a non-closure job's `currentRound` to the PR-wide
  count before the cap check and stamps `remediationPlan.prRound` (see
  `follow-up-jobs.md`).
- `bin/pr-round-ledger.mjs show --repo R --pr N [--json]` prints the enforced
  count, the budget and per-kind counts. Before the first ledger write, the
  budget comes from the latest job's risk tier (or the default medium tier),
  so exhausted legacy PRs already default HQ updates to an operator charge.

Authority: the ledger counts rounds. It grants no merge, dispatch or re-review
authority. A torn or unparseable line is skipped with a warning; the job-derived
count is always a floor, so a missing ledger can never lower a PR's spent
budget.
