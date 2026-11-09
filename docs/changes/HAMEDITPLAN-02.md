# HAMEDITPLAN-02

## Summary

Resolve edit-plan review evidence from the run's pinned head so an omitted or
unusable model-authored head does not stop a valid repair. Help requests succeed
without performing a plan check.

## Interface changes

`bin/hammer-edit-plan.mjs` accepts `--reviewed-head SHA` after the four positional
arguments, falling back to `HAM_REVIEWED_SHA` when the option is absent. The
prompt passes the substituted controller pin explicitly across the database-owner
boundary. All four literal JSON examples omit the optional head, matching help.
The CLI fills omitted, non-string and empty or whitespace-only plan
`reviewedHead` values in memory. A valid explicit head may differ from the pin
but must match the fetched authoritative review's `commit_id`. Malformed
nonempty strings or a missing/invalid pin stop with `review-evidence-invalid`.
The pure checker still enforces authoritative reviewer identity, review state,
review commit matching, policy and edit authorization; the CLI no longer adds
the unintended requirement that explicit heads match the pin.

Final comment-only remediation normalizes the CLI pin to lowercase and compares
nonempty plan heads without hex case sensitivity. Review-mismatched hashes and
whitespace around a hash remain invalid; plan files remain untouched. The additive CLI help
example and prompt example both omit optional file coordinates.

`--help` and `-h` print usage and accepted plan shapes and exit 0 without reading
a plan, fetching a review, loading policy or capturing findings. Help is handled
by the CLI entry point and is not a plan-check result. Actual helper failure exits
are unchanged.

## Verification

All test commands used netguard and the bounded worker-validation runner.
`node --test test/hameditplan-01.test.mjs test/hamscope-01.test.mjs
test/hammertrim-contract.test.mjs` passed all 74 tests. The search-selected run
covered every test file referencing `hammer-edit-plan` or `hammer-prompt`, plus
`test/smv.test.mjs`: 532 passed, two skipped and two existing registration-test
failures. Both failures reproduced with the original test and template from
`origin/main`; the untouched dispatcher selected native no-op mode.

After making the help subprocess independent of the working directory,
`npm test -- test/hameditplan-01.test.mjs` passed all nine tests in the isolated
runner. The final helper and state/smoke check passed all 20 tests.
`npm run lint` passed with zero errors and 152 existing warnings; changed-file
ESLint with `--fix`, `npm run typecheck:contracts`, the offline research
walkthrough's byte-equivalence check and `git diff --check` passed.
The required full `npm test` attempt hit the repository runner's 900-second
deadline and exited 1 with `ETIMEDOUT`; it is incomplete, not a green full-suite
result. No broad rerun or live smoke was performed.

Final comment-only round: offline `npm ci --offline --no-audit --no-fund`
restored the initially absent dependencies. Bounded
`npm test -- test/hameditplan-01.test.mjs test/hamscope-01.test.mjs test/smv.test.mjs`
passed all 33 tests, including mixed-case pins from both input sources and exact
additive help/prompt shape parity. Changed-file ESLint passed without warnings;
`npm run lint` passed with zero errors and 152 existing warnings.
`npm run typecheck:contracts`, `bash demo/research-finding-walkthrough.sh` and
`git diff --check` passed. Two broader selections including
`test/hammertrim-contract.test.mjs` reached their 60-second bounds without
assertion failures; that broader suite remains unverified locally.
The full suite was left to PR-head CI.

Fresh re-land preserves review-read instructions and fixes case-insensitive 40-hex head comparison plus additive help/template coordinate parity.

## Review remediation

Missing or invalid run pins now return `review-evidence-invalid` before the CLI
reads or parses the plan file. Regression coverage exercises both pin sources
with missing files, malformed JSON and directory paths, and verifies that review,
policy and backlog operations remain untouched. The closure runbook documents
this refusal ordering.

The reported undefined `usage`, help JSON parsing and template-placeholder
failures are absent at reviewed head `46579743ca818a3fa1420716cc1aa44d41d6250c`:
the prompt contract declares `usage`, excludes help from plan assertions and
loads head-free examples from help. No harness rewrite was needed.

After rebasing onto freshly fetched `origin/main`, bounded targeted tests
(`npm test -- test/hameditplan-01.test.mjs test/hammer-prompt-contract.test.mjs`)
passed all 17 tests, including execution of 38 documented prompt commands.
Repository lint passed with zero errors and 152 existing warnings; contract
typechecking and the offline research byte-equivalence walkthrough passed.
The full suite is reserved for PR-head CI.

## Fresh re-land verification

Preserved the CLI usage export and fenced help examples used by current main.
Restored all four pinned-head template examples while retaining the review-read
helper instructions and existing prompt budget. Additive examples omit optional
coordinates in both places; the policy wording and exit semantics remain intact.
The help contract fixture discovers plans by edit kind because their head now
comes from the run pin.

Fresh validation uses netguard and `cwp_dispatch.worker_validation` with explicit
time bounds. Changed-file ESLint with `--fix`, repository lint (zero errors,
152 existing warnings), `npm run typecheck:contracts`, the offline research
walkthrough and `git diff --check` pass. The required `npm test` attempt reached
the repository runner's existing 900-second deadline (`ETIMEDOUT`); the full
suite is incomplete and was not rerun.

The two registration tests also fail with the original test and template from
`origin/main` against the unchanged dispatcher. These baseline failures are
reported separately from edit-plan and review-read coverage.

The final bounded `node --test --test-concurrency=2` run covered all 26 test
files selected by `git grep -l -e hammer-edit-plan -e hammer-prompt --
'test/*.test.mjs'`, plus `test/merge-agent-doc-contract.test.mjs` and
`test/smv.test.mjs`: 564 passed, two skipped, and only the two reproduced
registration baseline failures. Edit-plan, help/prompt parity, primary-change
policy, review-read, rendered-budget and sandbox-smoke tests pass.

## Final comment-only review remediation

Restored cross-head citations: a valid explicit plan head is lowercased and
checked against the fetched authoritative review, while the required controller
pin fills only omitted or unusable heads. Missing/invalid pins still refuse
before plan I/O; malformed nonempty strings and review-mismatched heads still
refuse. Regression coverage exercises author-line authorization on another head
with either pin source and both hex cases, plus a head matching neither source.

Help now exits successfully only through the CLI entry path, outside
`editPlanExitCode`. Prompt and help JSON shapes match without stamped heads,
and both explain how to cite another review head. Updated the closure runbook,
existing README contract and post-merge verification description in place.

Bounded targeted validation passed all 30 tests in
`npm test -- test/hameditplan-01.test.mjs test/hammer-prompt-contract.test.mjs
test/hamscope-01.test.mjs` and all 11 tests in
`npm test -- test/smv.test.mjs`. Repository lint passed with zero errors and
152 existing warnings; changed-file ESLint, contract typechecking, the offline
research byte-equivalence walkthrough and `git diff --check` passed.
A standalone name-filtered prompt-budget test was redirected by the sandbox
preload into an unfiltered file run and reached its 30-second bound. Direct
execution of the same rendering assertions passed: 61,304 bytes within the
61,440-byte limit, with no unresolved placeholders. No full suite was run;
PR-head CI remains the full-suite merge gate.
