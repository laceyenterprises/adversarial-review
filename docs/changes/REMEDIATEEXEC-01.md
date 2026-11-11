# REMEDIATEEXEC-01

## Summary

An ended remediation round with findings retains an executor: closure
reconciliation first attempts guarded publication of verifiable retained work,
then requeues eligible execution failures within the existing round budget and
backoff. At the job's round ceiling, watcher selection, hammer wake and the
read-only rescue projection agree on hammer ownership, including blocking
findings. Live owners, safety refusals and operator holds remain fenced.
Initial missing-job creation stays with the reviewer/reaper, whose durable
review-mode and PR-wide budget evidence prevents single-review budget refunds.
Automatic ceiling handoff admits execution and budget stops only; operator
holds and closure handoffs keep their owners.

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

## Interface changes

The existing recovery marker optionally records the spent round. Successful
retained publication uses normal completion and re-review without launching
another worker. No CLI, configuration, CI check or merge permission is added.
Canonical lifecycle, data-model and smoke declarations describe these paths.

## Verification

Scoped offline tests run individually through the 600-second worker-validation
runner under netguard:

- `node test/run-tests.mjs test/remediateexec-01.test.mjs`: 21 passed,
  including missing-job budget refusal and operator-hold precedence.
- `node test/run-tests.mjs test/closer-next-action.test.mjs`: 101 passed.
- `node test/run-tests.mjs test/watcher-claim-loop.test.mjs`: 168 passed.
- `node test/run-tests.mjs test/remlabel-publication.test.mjs`: 20 passed.
- `node test/run-tests.mjs test/smv.test.mjs`: 11 passed, including disposable
  Git smoke.
- `npm run lint`: zero errors; existing warnings remain.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed.

Additional scoped next-action, publication, completion and ownership regression
results are recorded in the PR. The full suite was not run.

The committed operator-only post-merge plan requires deployment PID checks and
24 hours with no missing executor beyond one watcher pass and no expired
remediate action older than 15 minutes. No live changes were made by this PR.

Final comment-only round validation used `bash bin/run-bounded.sh` for each
scoped test file:

- `node test/run-tests.mjs test/remediateexec-01.test.mjs`: 27 passed.
- `node test/run-tests.mjs test/closer-next-action.test.mjs`: 103 passed.
- `node test/run-tests.mjs test/pr-next-action-shadow.test.mjs`: 23 passed.
- `node test/run-tests.mjs test/remediation-completion-comments.test.mjs`: 87 passed.
- `node test/run-tests.mjs test/smv.test.mjs`: 11 passed, including source
  projections and disposable Git smoke.
- `node test/run-tests.mjs test/watcher-claim-loop.test.mjs`: 168 passed.
- `npm run lint`: zero errors; 149 existing warnings.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed.
- `node scripts/validate-data-model-catalog.mjs`: 93 entries validated.
- `git diff --check`: passed.

The initial concurrent scoped run hit its 240-second bound and a sandbox smoke
failure under host load; isolated reruns passed. The full suite was not run.
Lifecycle states, durable store shapes and deployed smoke promises are unchanged.
