# HAMEDITPLAN-04

## Summary

An otherwise admissible `author-lines` edit plan outside the cited finding's
ranges is a correctable shape error rather than a terminal policy refusal.
The scope check still refuses every uncovered author-line edit.

## Interface changes

`not-covered-by-cited-finding` now returns `action: correct` through the existing
CLI exit-21 path. Feedback names the planned region and every cited path/range
for that finding, then directs re-planning within one cited range or as
`editKind=additive` if no existing author line is removed or replaced.
The prompt retains one correction per run across all plans and stops on exit 1.
Review evidence, finding authority, advisory deferral, malformed coordinates,
CI-only flags and all allowed paths retain their existing checks and outcomes.
Canonical closure, state-machine and README guidance reflect the classification.
No live actions, CI changes or new smoke commands are introduced.

## Verification

Validation uses `cwp_dispatch.worker_validation` with explicit command timeouts.
Test commands carry the requested `NETGUARD_LOG` and `PATH` prefix. The specified
netguard directory is absent in this workspace environment, so netguard
enforcement is unavailable; no installation or host change was made.

- Final `node --test --test-concurrency=2 test/hameditplan-01.test.mjs
  test/hameditplan-04.test.mjs test/hamscope-01.test.mjs
  test/hammertrim-contract.test.mjs`: 82 passed, zero failures. This covers exact
  range feedback and exit mapping, within-range and additive corrections, policy
  and evidence variants, existing permissions, shell correction limits and the
  rendered prompt budget (61,433 bytes within 61,440).
- Every test file selected by `git grep -l -e hammer-edit-plan -e hammer-prompt
  -- 'test/*.test.mjs'`, plus the new regression file, documentation contract and
  state/smoke tests, was run: 569 passed, two skipped, three failures. One was an
  initial expectation in the new test for uncited CI plans, corrected and passing
  in the final 82-test run. The other two are the registration failures already
  recorded by HAMEDITPLAN-02/03; their test and dispatcher match `origin/main`.
- Changed-file ESLint with `--fix`, repository lint (zero errors, 152 existing
  warnings), contract typechecking, the offline research walkthrough's
  byte-equivalence check and `git diff --check` passed.

The required full `npm test` run passed through the repository's isolated runner:
19,098 passed, 11 skipped, zero failures (664 seconds). This includes the final
edit-plan regressions and the registration tests that fail in the direct
search-selected invocation.

## Final comment-only review

The reported unused third argument is consumed: at reviewed head
`e3571b5204cbcf26735478b15f08a2bd1d694a9b`,
`src/ama/hammer-edit-plan.mjs:8-9` declares `prefix` as the third parameter
and interpolates it into the correction message. The outside-range call at
lines 67-69 intentionally supplies `correctable: `, matching the closure
runbook's documented message and the exact-message CLI regression in
`test/hameditplan-04.test.mjs`. Removing that argument would change the
documented output, so the implementation is retained.

After the fresh-main rebase, a direct offline reproduction first verified
byte-identical edit-plan source against that reviewed head, then exercised an
outside-range plan. It returned `action: correct`,
`reason: not-covered-by-cited-finding` and a message starting
`correctable: plan region src/example.mjs:5-7`. No interface, persistent state,
lifecycle or smoke promise changes are needed.

Final-round validation: the four targeted suites listed above passed all 82
tests under `bash bin/run-bounded.sh --timeout 120`. Repository lint passed
with zero errors and 152 existing warnings; contract typechecking, the offline
research walkthrough and `git diff --check` passed. The full suite was left
to PR-head CI for this round.
