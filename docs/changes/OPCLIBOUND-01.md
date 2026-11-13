# OPCLIBOUND-01: bounded operator GitHub calls

## Summary

Code inspection found direct metered GitHub calls without an absolute deadline
in the ticket-pipeline pause CLI and branch-protection repository discovery.
The merge-lane inventory collector bounded subprocess execution but allowed
metering to wait outside that bound.

These operator paths now use `operator-gh-read.mjs`: progress on stderr and
one absolute, load-aware budget per command (30 seconds nominal, capped at
60 seconds), including metering, subprocess execution and retry backoff.
Pause label mutations disable transient retries because their remote outcome
can be uncertain. A failed PR step stops a combined pause before its repo file
is written.

Credential-less bounded reads use the separate `operator-cli` budget identity.
Explicit tokens retain their token or installation identity. Admission and
response accounting use the same identity; no stored fields or versions change.

Final comment-only remediation confirms that inventory reads already inherit
the shared executor's 25 MiB output buffer. A new offline regression checks the
actual executor option and reads a real child response larger than Node's
default 1 MiB buffer. No new buffer option is needed.

Branch-protection reads now build an allowlisted environment only for the
fallback executor. Both paths retain the required-token prerequisite; a
supplied operator reader owns subprocess environment construction. Tests cover
that delegation and explicitly count subprocess calls when credentials are
missing, so caught assertion failures cannot mask an unintended launch.

## Interface changes

- Pause failures report `ticket-pipeline-pause-timeout` and exit `1`.
- Branch-protection read failures report `branch-protection-lookup-timeout`.
  Discovery failures exit `4`; per-repository failures remain non-OK results
  with exit `1`. Progress also goes to stderr in JSON mode.
- Inventory timeout entries add `reason=merge-lane-inventory-lookup-timeout`.
- The branch-protection fetcher accepts an optional `runGhRead` seam for the
  operator CLI. Daemon callers retain their existing probe behavior.
- Pause helpers, the branch-protection CLI and inventory collector accept
  injected budgets/executors for offline tests. No new CLI flags.
- Updated the operator runbook and rate-limit data-model documentation, with
  a catalog fragment. No deployment or activation step is required.

## Verification

- Final comment-only remediation: `node test/run-tests.mjs
  test/merge-lane-inventory.test.mjs test/branch-protection.test.mjs
  test/check-branch-protection-cli.test.mjs test/operator-gh-read.test.mjs`:
  **47 passed** across four files, offline, under a fixed 120-second bound.
- Final remediation guards: `npm run lint` **passed** (zero errors, 149
  existing warnings); `npm run typecheck:contracts` **passed**;
  `bash demo/research-finding-walkthrough.sh` **passed** with byte-stable
  transcript deliveries; `git diff --check` **passed**. No full local suite.
- This checkout had no dependencies installed; the initial targeted run could
  not load `js-yaml`. Validation used the existing ignored `node_modules`
  installation from the deployed review-service checkout.
- Focused offline tests: `node test/run-tests.mjs
  test/operator-gh-read.test.mjs test/ticket-pipeline-pause.test.mjs
  test/check-branch-protection-cli.test.mjs test/merge-lane-inventory.test.mjs`:
  **40 passed**. Synthetic hanging processes/executors verify typed timeouts,
  abort signals, progress, no mutation replay and no repo write after failure.
  Exhausted synthetic default buckets do not block operator reads, whose
  responses are accounted separately; explicit token identities are preserved.
- Related-module validation: **1,083 passed across 38 files** in 284 seconds,
  selected by references to the changed modules and retrigger CLI. This includes
  the watcher claim-loop, retrigger, branch-protection, credential-budget and
  operator adapter suites. The command used the fixed outer 600-second bound.
- `npm run lint`: **passed**, zero errors (149 existing warnings).
- `npm run typecheck:contracts`: **passed**.
- `bash demo/research-finding-walkthrough.sh`: **passed**, byte-equivalent
  offline transcript.
- `npm test`: attempted, **incomplete**. The validation runner load-scaled its
  nominal 600-second timeout; the run was stopped when that exceeded the
  requested wall-clock budget. No full-suite pass is claimed.
- Commands ran through the worker validation runner; subsequent test runs use
  an outer fixed 600-second timeout as well. Test commands used the requested
  network-guard environment.
