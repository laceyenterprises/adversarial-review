# REVIEWCLIJSON-01

## Summary

Executable-resolution failures are `cli-resolution-transient`, distinct from
reviewer OAuth failures. They preserve healthy reviewer capacity, avoid
credential-outage accounting, and retry behind existing PR-level backoff.
Below the existing five-consecutive-transient threshold, settlement releases
only the matching claim to `pending` without charging review or infrastructure
recovery attempts. Threshold failures use existing bounded `pending-upstream`
recovery. Stale results leave replacement claims and backoff untouched.

Both resolver clients retry once with load-aware deadlines. Strict protocol-v1
validation remains required: one response alongside non-JSON banners is
accepted, duplicate JSON responses are refused, and invalid-JSON diagnostics
contain only byte length, line count and protocol-line presence. Pipeline
health retains the new class; runtime readyz reports separate informational
24-hour resolution/OAuth counts without adding a readiness gate.

Final comment-only remediation synchronizes the exported failure-class types,
ignores non-object JSON chatter around a single protocol object, and shares one
read-only readyz database handle while preserving independent query failures.
The suggested `(status, ended_at)` index remains a follow-up schema migration;
this remediation does not change persistent storage or lifecycle/smoke promises.

See the [synthetic SEV2 report](../postmortems/SEV2-REVIEWCLIJSON-01-review-cli-resolution-false-auth-isolation.md)
and the corrected [resolver runbook](../RUNBOOK-reviewer-workspace.md).
No reviewer model, concurrency limit, strictness, merge rule or CI gate changes.
Normal submodule float and watcher restart activate this source change; this PR
makes no live changes.

## Interface changes

Resolver errors expose `ReviewCliResolutionError`, `failureClass` and existing
`binaryResolution` evidence; invalid JSON adds a bounded `diagnostic` object.
`CLI_RESOLUTION_TRANSIENT_FAILURE_CLASS` and `isReviewCliResolutionFailure` are
exported for shared classification. Resolver fixture options accept an injected
`loadAwareTimeoutMsImpl`. The existing cascade breakdown maps preserve the new
failure class without a schema migration. Runtime readyz JSON adds
`reviewerFailures24h` with availability and separate counts; text renders the
same diagnostics. Unavailable history is not represented as zero failures.
`ReviewerFailureClass` (and its reviewer, remediator and agent consumers) includes
`cli-resolution-transient`. Line-oriented resolver ambiguity counts JSON objects
only; additional objects still fail closed.

## Verification

Final comment-only remediation validation (bounded foreground commands):

- `npm test -- review-cli-resolver.test.mjs runtime-readyz.test.mjs runtime-status-cli.test.mjs`:
  48 tests passed across three files, including primitive chatter, object ambiguity,
  one read-only handle, independent query errors, and missing/corrupt/legacy history.
- `npm run lint`: passed with zero errors (149 existing warnings).
- `npm run typecheck:contracts`: passed, including resolution failures in reviewer,
  remediator and agent result contracts.
- `bash demo/research-finding-walkthrough.sh`: passed, three byte-stable deliveries.
- `git diff --check`: passed. No full local suite was run in this final round.

Earlier validation:

All test commands use the repository runner, the prescribed netguard environment
and a 600-second process-group budget through `cwp_dispatch.worker_validation`.

- `npm run lint`: passed, zero errors (existing warnings).
- ESLint `--fix` over changed JavaScript: passed, zero errors.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed, three byte-stable deliveries.
- Scoped `npm test --` covering resolver, REVIEWCLIJSON-01, identity leases,
  Argus quota/leases, classification, cascade, settlement, runtime, pipeline
  health, watcher single-claim loop and pending-failure recovery: 903 assertions
  passed across 12 files, including the corrected runtime contract (84 assertions
  passed in the final runtime-file rerun).
- `npm test -- runtime-readyz.test.mjs runtime-status-cli.test.mjs`: all 33 passed,
  including independent counts, old/corrupt history and unchanged readiness.
- Full `npm test`: not completed. The requested 600-second wrapper budget was
  load-scaled by the shared process runner; the over-budget suite was stopped
  with process-group cleanup (exit 143). The partial run also reported two
  untouched-fixture failures: `hammertrim-contract` cleanup `EPERM` and a
  `primary-change` Git fixture timeout. These are outside this change; no full
  suite pass is claimed.
