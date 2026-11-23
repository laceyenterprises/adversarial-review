# FINDINGSBATCHSTRAND-01: Finding batches under a second GitHub owner name their missing read grant; holds are surfaced; operator release verb

## Summary

The review app reads dispatch launches only through exact `(project,
owner/repo)` grants. Finding-batch keyed reads were unscoped. For a repository
whose pair was never granted (in practice, a repository under a second GitHub
owner) the producer dropped the launch row and returned an empty `not_found`
with no absence proof. The client read that as `dispatch absence scope
unproven`, so:

- publication recorded `batch-publish-receipt-unavailable`;
- release returned `needs-operator: batch-keyed-launch-probe-unreadable`, but
  only after the timeout, and only in a log line.

These batches stayed open on every pass, and the backlog could never drain.

The fault is not in the GitHub client, the idempotency key or repository-name
canonicalization. The dispatcher records the owner-qualified repository from its
registration, and the key is recorded as submitted. Only the read grant is
missing.

## What changed

- `findingBatchDispatchScope(batch, env)` (new export) returns the pair the batch
  is dispatched under. The project is `HQ_PROJECT`, default
  `adversarial-merge-authority`, the same value `hq dispatch --project` receives.
  The repository is the batch's qualified repository.
- The publication receipt probe and the release probe now send that scope.
- A refused scope (`selectorRefused`) has its own outcomes:
  - Publication records `batch-dispatch-read-scope-denied: <project> <owner/repo>`.
  - Release reports that reason as `needs-operator` on the first pass.
  - After the grant, an unexpired prepared batch publishes. An ended preparation
    releases.
- New nullable column `finding_batches.hold_json` (migration
  `20261122_findings_batch_hold.sql`) keeps the latest `needs-operator` decision.
- `summarizeFindingBacklog` returns `heldBatches` and `heldFindingCount`.
  `findingBacklogAlert` fires for any held batch, with one
  `held=<batchId>:<reason>` evidence entry per batch.
- New operator verb `bin/findings-batch-release.mjs` (logic in
  `src/findings-batch-release.mjs`): `--root --db --batch --mode retry|drop
  --reason [--accept-unreadable-custody] [--apply]`. It is read-only unless
  `--apply` is given, and refuses live, decision-blocked or unknown launch
  custody.

## Interface changes

- New CLI `bin/findings-batch-release.mjs`. Exit 0 means previewed or applied,
  2 means refused, 1 means invalid input.
- New backlog summary fields `heldBatches[]` and `heldFindingCount`. The backlog
  alert also fires for held batches.
- New batch error and hold reason `batch-dispatch-read-scope-denied: <project> <owner/repo>`.
- Additive column `finding_batches.hold_json`.

Final documentation remediation adds the hold migration and both batch-release
entry points to the review-findings domain document's source-of-truth list,
matching their existing catalog fragment registration. This correction adds
no interface changes.

## Operator follow-up

Grant the review app the `(HQ_PROJECT, owner/repo)` dispatch read for every
reviewed repository under each configured owner. Use the app-contract operator
runbook's capability reporter and its backup, owner and mode procedure. Batches
held on that pair then resolve on the next pass. Alternatively, release them
with the verb.

## Verification

`test/findingsbatchstrand-01.test.mjs` (13 tests) passes. It runs a
grant-filtered producer double through the real dispatch-read client. Against
the base `src/findings-batch.mjs`, its 4 behavioural cases fail. Existing
suites pass: findings-batch, findingsrequeue-01, findings-batch-regressions,
findings-batch-grades, finding-batch-probe-census, osgbackfillenroll-01,
findingsdrainrate-01, grok-remediator, hamscope-01, review-pipeline-health-ttm,
smv and the FINDINGSBATCH case of watcher-daemon-clean-merge. In
review-pipeline-health, `CI orphan workspace pages are memoized…` fails on the
base too, so that failure predates this change.

Final documentation remediation: `node scripts/validate-data-model-catalog.mjs`
passes (103 catalog entries); `git diff --check` passes.
