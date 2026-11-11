# REMEDIATEEXEC-01

## Summary

An ended remediation round with findings retains an executor: closure
reconciliation requeues eligible execution failures within the existing round budget and
backoff. At the job's round ceiling, watcher selection, hammer wake and the
read-only rescue projection agree on hammer ownership, including blocking
findings. Live owners, safety refusals and operator holds remain fenced.
Initial missing-job creation stays with the reviewer/reaper, whose durable
review-mode and PR-wide budget evidence prevents single-review budget refunds.
Automatic ceiling handoff admits execution and budget stops only; operator
holds and closure handoffs keep their owners.

The fresh rewrite preserves current-main lease liveness, controller plan handling
and state contracts. Watcher discovery now performs local queue recovery only,
without awaiting network publication or using watcher credentials in a retained
worker checkout. Explicit worker-authenticated recovery checks uid ownership
before any git call; otherwise the bounded successor retains unpublished work.
An explicit exact-head guard also protects terminal budget attribution, and
recovery forwards any supplied closeout snapshot.

Publication base fetches disable recursive submodule fetching so an unavailable
submodule cannot prevent parent-branch publication.

The final comment-only remediation preserves `failure.code` in shadow evidence
so eligible failed rounds at their ceiling reach hammer ownership. Retained-work
verification now refreshes the remote base before `git cherry`, with recursive
submodule fetching disabled; an unreadable base preserves the existing retry
and unpublished-work evidence.

Three reviewed observations required no runtime change. The declaration stores
`digest(stateProjection(source))`, not whole-file hashes: both recovery modules
have the same empty projection, and the follow-up-jobs projection matches its
declaration. Terminal-job selection already filters to the current head.
`remediationCloseout` constructs a fresh snapshot even when its caller supplies
none. Focused fixtures exercise older-head stopped/failed jobs and real retained
publication completion with and without a supplied snapshot.

The last Comment-only round separates missing or blank review text from a
settled-clean refusal and retains `failure.code` in the recovery marker and
requeue reason when no stop code is available. Focused regressions cover blank
review bodies, a clean-review control, and failed rounds without plan stops.
Existing recovery states, transitions, budgets and smoke promises are unchanged.

## Interface changes

The existing recovery marker optionally records the spent round. Successful
retained publication uses normal completion and re-review without launching
another worker. No CLI, configuration, CI check or merge permission is added.
Canonical lifecycle, data-model and smoke declarations describe these paths.

## Fresh rewrite validation

Validation for the fresh branch is recorded in the PR. Tests run serially, one
changed test file per invocation, through the 600-second worker-validation
runner under netguard. The full suite is intentionally deferred to CI. No live
service or configuration changes are part of this PR. The operator plan retains
the float, watcher/follow-up PID start-time checks and natural-traffic
observation, and confirms Grok remediation stays opt-in/default-off and Grok
closer selection stays refused.

Final diagnostic fixes: bounded `node --test test/remediateexec-01.test.mjs`
passed 35 tests; bounded `node --test test/strict-settled-remediation.test.mjs`
passed seven. `npm run lint` passed with zero errors (149 existing warnings),
`npm run typecheck:contracts`, `node scripts/validate-data-model-catalog.mjs`
(93 entries), `bash demo/research-finding-walkthrough.sh`, and `git diff --check`
passed. The SMV `checkMap` source/graph check and README diagram comparison passed
without declaration changes. Full-suite execution remains with PR-head CI.

## HAM final adjudication and conflict validation

Both final non-blocking findings are addressed by the existing diagnostic fixes:
blank or absent review bodies report `review-body-missing`, and failed rounds
retain their concrete `failure.code` in recovery evidence and requeue reasons.
No finding is deferred or withdrawn. Conflict resolution preserves current-main
zero-output-refusal ownership alongside the ended-round recovery declarations;
the dispatch source projection and independent graph snapshot reflect the merged
contracts rather than either parent snapshot.

HAM validation uses the repository's isolated `test/run-tests.mjs` coordinator
for recovery, strict-settled, state/smoke, closure-budget/next-action, publication
and watcher claim-loop tests. Lint has zero errors (149 existing warnings),
contract typechecking passes, all 93 catalog entries validate, and the offline
research-finding walkthrough preserves byte-equivalent transcripts. The initial
plain `node --test` invocation hit checkout-state isolation failures; it does not
count as passing evidence. Full-suite execution remains with exact-head PR CI.
