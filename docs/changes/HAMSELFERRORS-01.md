# HAMSELFERRORS-01

## Summary

Apply the world-fact stop rule across mandatory closer helpers and phases.
Closer-owned usage, canonical validation environment and controller setup faults
receive correction/retry and then defer. Refund ended charged launches atomically
across series/head/lifetime counters, up to three per head; exhaustion parks and
pages once without spending the PR adjudication budget. Every registered stop
origin and concrete phase emission is pinned by offline synthetic fixtures.
Unknown new stop codes defer for contract repair. Historical explicit hammer
self-errors project to deferrals without rewriting stored audit evidence;
unknown historical reasons, structured refusals and success remain authoritative. World facts retain stop authority.

## Interface changes

Helper usage correction returns exit 21 without permission to edit. The private
run correction receipt prevents repeated corrections; mutations are never
replayed by the wrapper. Canonical validation accepts repository-relative changed
files, runs repository-owned runners, and claims no local pass when setup cannot
produce a verdict; exact-head required GitHub checks remain mandatory. Retry and
dispatch records gain optional bounded self-error refund receipts, documented in
the data model and canonical catalog. No new CI check, label or live action.

Final comment-only remediation catches legacy Git changed-file discovery errors
as canonical setup faults, preserving the exact-head required-check fallback
without a local-pass receipt. Direct importer selection resolves paths from
each test directory, including shared and adapter-local helpers. The prompt's
validation example takes changed repository-relative files instead of a
repository-specific Python test.
The documentation-only SRE plan lives at
`modules/worker-pool/post-merge-actions/HAMSELFERRORS-01.yaml`, the publisher's
required declaration namespace; it contains operator steps and no automatic
actions.

## Verification

Scoped offline tests run individually through worker_validation under netguard,
each bounded to 600 seconds. The stop-origin/correction/canonical-runner/refund
tests, actual dispatch accounting, helper/controller/progress/prompt contracts,
audit, HAMEDITPLAN-01..05, HAMINTENT-02, HAMREFUND-01, HAMFINAL-01,
VERIFYHEADTRANSIENT-01 and watcher claim-loop regressions pass. Commands use
`node test/run-tests.mjs test/<scoped-file>.test.mjs`; no full suite was run.
`npm run lint` passed with zero errors, `npm run typecheck:contracts` passed,
and `bash demo/research-finding-walkthrough.sh` preserved byte equivalence.
Both operator plans parsed successfully. The PR acceptance evidence records
the scoped counts and any execution limitations.
The committed operator plan declares ordinary float/restart, PID start-time
verification and 24-hour acceptance; no live acceptance receipt is claimed.

Final remediation validation: the bounded offline command
`node test/run-tests.mjs test/hamselferrors-01.test.mjs test/hammer-prompt-contract.test.mjs test/ama-hammer-merge-protocol-prompt.test.mjs test/run-bounded.test.mjs`
passes all 76 tests, including 38 documented prompt commands. The prompt size
and validation-policy cases in `test/hammertrim-contract.test.mjs` pass separately
with `--test-name-pattern 'rendered hammer prompt stays|hammer and every remediation stage'`
after removing a redundant sentence to retain the 60 KiB limit.
`npm run lint` passes with zero errors (149 existing warnings),
`npm run typecheck:contracts`, `node scripts/validate-data-model-catalog.mjs`
(93 entries), `bash demo/research-finding-walkthrough.sh`, and
`git diff --check` pass. Rebase declaration conflicts preserve both trunk's lease
liveness and this PR's self-error recovery entries in both JSON declarations.
No full local suite or live acceptance was run.

Hammer CI repair updates offline fixtures to distinguish closer-owned deferred
faults from authoritative world-fact stops, preserves unknown-reason diagnostics,
and exercises all three self-error refunds before exhaustion. Isolated helper
fixtures include the stop-origin dependency and alert delivery stays synthetic.
The unrelated diff-timeout fixture deadline increase is excluded from the fresh
PR; fixture-deadline flakes belong to ARCIDEFLAKE-01.
The smoke handoff uses a registered world-fact reason. These repairs preserve
production behavior and required exact-head CI gates. Targeted regression tests,
lint (zero errors), contract typechecking and the byte-equivalence demo pass;
no full local suite was run.

## Fresh PR on current main

Supersedes PR 1823. The replacement squashes its complete implementation and
review remediation onto current main as one builder commit. Both declaration
conflicts retain main's `endedRemediationRecovery` and add
`closerSelfErrorRecovery`; main's `closerAttemptIdentity` and
`leaseHolderLiveness` declarations remain intact. Automatic merges retain the
new closer worker identity/custody logic, remediation recovery and bounded
parallel test runner. Apart from this note and the excluded deadline increase,
the added and removed lines match the original PR's intended diff.

All three comment-only findings are applied: Git discovery failures take the
canonical environment fallback without a local-pass receipt; importer selection
resolves paths relative to each test directory; the prompt takes changed
repository-relative files. Their synthetic regressions remain in the squash.
No finding is deferred.

Fresh verification ran all 14 touched test files individually through
`/opt/agent-os/runtime/python/bin/python3 -m cwp_dispatch.worker_validation
--repo-root . --timeout-seconds 600 --command node test/run-tests.mjs <file>`
under netguard: 728 passed, zero failed, one existing Darwin census sandbox
skip. Every file completed within 600 seconds. Lint has zero errors (149
existing warnings); contract typechecking, the byte-equivalence demo, 93-entry
data-model catalog validation and whitespace checks pass. The plain-shell
CI mirror uses the installed foreign-repository runner binding because this
repository does not contain `scripts/ci-mirror/run-ci-mirror.py`: both fast
checks pass and the slow suite is deferred to hosted CI. No full local suite
was run. Hosted current-main run 43028750608 completed its test steps in
545 seconds on Node 22 and 600 seconds on Node 26, below the unchanged
900-second cap; replacement-head hosted results belong in the PR evidence.

## PR 1831 final comment-only remediation

Invalid canonical validation paths now print usage and exit 64 without running
tests or recording a verdict/fallback. Missing dispute arguments report
`helper-input-invalid` and exit 21 before ownership inspection; complete requests
still enforce ownership before SQLite access. Controller setup yields for 50 ms
before its one census retry. The canonical data-model catalog now contains the
self-error refund, dispatch, audit and wait metadata plus a correction-receipt
entry, replacing the unindexed fragment. The runbook and progress contract
describe these refinements. Lifecycle states and existing smoke promises remain
unchanged.

Verification for this round: bounded targeted runs of
`node test/run-tests.mjs test/hamselferrors-01.test.mjs test/hamintent-02.test.mjs`
pass 57 tests; the corrected controller fixtures pass all 113 tests in
`node test/run-tests.mjs test/hammer-controller.test.mjs`. `npm run lint` passes
with zero errors (149 existing warnings), `npm run typecheck:contracts` passes,
`node scripts/validate-data-model-catalog.mjs` validates 94 entries,
`bash demo/research-finding-walkthrough.sh` preserves byte equivalence, and
`git diff --check` passes. No full local suite or live acceptance was run.
