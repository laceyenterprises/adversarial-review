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
