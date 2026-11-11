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
