# CIWAITLANE-01: a clean PR merges within one watcher pass of its CI passing

## Summary

A clean PR with an approving zero-finding review could wait up to 12 watcher
passes after its CI passed. While it waited on CI, the no-progress lane saw no
review-row change and demoted it to the slow lane, with backoff 1, 2, 4, 8.

Cause: the posted-review handler dropped `amaClosureResult` (and its
`nextAction`) on the `ama-pending` return unless the result was an operator
hold, a missing remediation job, a drain deferral or a lease wait. The
`pending-required-checks` closure result carries `nextAction`
`wait-for-CI` / `ci` / `R11-pending`, but none of it reached the lane ledger.
The ledger therefore had no `nextAction`, its decision-fingerprint closure was
all null, and the lane applied plain backoff. A deferred PR's handler never
runs, so CI turning green produced no decision change and no reset.

Fixes:

- The `ama-pending` return now keeps `amaClosureResult` when its next action is
  `wait-for-CI` by actor `ci`. The CI wait reaches the ledger as `nextAction`
  and the decision fingerprint records its closure row, action and reason.
- The lane treats a recorded `wait-for-CI` / `ci` action as self-resolving, not
  as a hammer route. It keeps ordinary slow-lane backoff instead of walking
  every pass.
- In plain slow-lane backoff, the existing posted-review readiness probe makes
  one bounded candidate read (metered `gh pr view`, the same read-cache seam,
  the probe's 10 s per-read and phase deadlines) for a settled current-head PR
  whose ledger records that CI wait. If checks are no longer pending (or
  mergeability is computed, for `mergeability-unknown`), the scheduler admits
  one walk and the handler reuses the read. The admitted signal is stored as
  `ciWaitAdmittedSignal`, so one unchanged signal cannot admit the PR again on
  that head.

## Interface changes

- Lane ledger: new optional `ciWaitAdmittedSignal`
  ([data model](../data-model/watcher-no-progress-lane.md)).
- Lane evaluation reason `ci-wait-settled`.
- New `watcher-no-progress-lane.mjs` exports: `isCiWaitNextAction`,
  `ciWaitNextActionFor`, `evaluateCiWaitAdmission`, `recordCiWaitAdmission`.
  New `posted-review-row.mjs` export: `clearedCiWaitSignal`. The lane gate has
  a `ciWaitAction` field on plain-backoff evaluation decisions, resolved from
  the already-read ledger so readiness preview does not read it twice.
- The closure runbook's posted-review scheduling paragraph now describes the
  one probe exception.

No config keys, thresholds, merge eligibility, review policy or handler
decisions change. Backoff cap, rewalk ceiling, operator-blocked cadence,
decision-reset cap and drain handling are unchanged.

## Verification

- `test/ciwaitlane-01.test.mjs` (synthetic fixtures). Against unchanged `src/`,
  4 of 6 fail, including the ledger `nextAction` test. With the fix, 6/6 pass.
- Lane, posted-review and scheduler suites (32 files that import the touched
  modules): 1192/1193 passed under the network guard. The one failure was the
  load-flaky SMV clean sandbox smoke, which passed alone (11/11).
- `npm run lint`: 0 errors. `npm run typecheck:contracts`: passed.
  `bash demo/research-finding-walkthrough.sh`: passed.

Final comment-only remediation normalizes `nextAction.head` consistently with
the requested and ledger heads. Regression coverage checks lowercase, uppercase
and mixed-case combinations, rejects different heads, and counts one ledger
read per readiness preview while verifying that preview does not mutate it.

- `node test/run-tests.mjs test/ciwaitlane-01.test.mjs test/watcher-poll-starvation.test.mjs test/posted-review-row-log-noise.test.mjs test/smv.test.mjs`:
  184/184 passed offline under the bounded runner.
- Final remediation lint: 0 errors (149 existing warnings); contract typecheck,
  offline research walkthrough and `git diff --check` passed. State projection
  unchanged; no lifecycle, storage-shape or smoke promise change.
- The additional claim-loop validation reached its 120-second bound without an
  assertion failure. A filtered invocation was re-executed unfiltered by the
  isolation helper and reached its 45-second bound. Claim/dispatch code is
  unchanged; full-suite validation remains with PR-head CI.
