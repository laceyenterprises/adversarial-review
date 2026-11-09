# HAMEDITPLAN-02

## Summary

Resolve edit-plan review evidence from the run's pinned head so an omitted or
unusable model-authored head does not stop a valid repair. Help requests succeed
without performing a plan check.

## Interface changes

`bin/hammer-edit-plan.mjs` accepts `--reviewed-head SHA` after the four positional
arguments, falling back to `HAM_REVIEWED_SHA` when the option is absent. The
prompt passes the substituted controller pin explicitly across the database-owner
boundary and uses that same substitution in all four literal JSON examples.
The CLI fills omitted, non-string and empty or whitespace-only plan
`reviewedHead` values in memory. A conflicting nonempty string or missing/invalid
pin stops with `review-evidence-invalid`. The pure checker, authoritative
reviewer, review state, review commit matching, policy and edit authorization
checks remain unchanged.

Final comment-only remediation normalizes the CLI pin to lowercase and compares
nonempty plan heads without hex case sensitivity. Distinct hashes and whitespace
around a hash remain invalid; plan files remain untouched. The additive CLI help
example and prompt example both omit optional file coordinates.

`--help` and `-h` print usage and accepted plan shapes and exit 0 without reading
a plan, fetching a review, loading policy or capturing findings. Actual helper
failure exits are unchanged.

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
