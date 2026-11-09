# HAMEDITPLAN-03

## Summary

A valid cited non-blocking `in-place` plan now receives correctable shape
feedback instead of a terminal refusal or advisory deferral. The hammer can
re-plan as `additive` within its existing one-correction-per-run budget.

Final comment-only remediation documents the redundant blocking-kind guard on
the cited in-place execution path as a safety check against future dispatch
changes. Runtime behavior and interfaces are unchanged.

## Interface changes

The existing `action: correct` path maps to exit 21 with the exact message:

`correctable: allowed editKinds for kind=non-blocking are additive|author-lines (author-lines only where checkReversalFinding authorizes)`

No in-place permission changes: non-blocking in-place plans never allow an
edit, including with strict policy, `requiredCiRepair`, or missing finding
numbers. Missing finding evidence remains terminal. Blocking in-place repairs
still require `checkReversalFinding` authorization; uncited required CI repairs
retain their existing permission. Review authority and reviewed-head checks
remain mandatory. The prompt directs the additive correction; the closure
runbook documents the classification and unchanged permission.

## Verification

Synthetic offline regression coverage checks exact feedback and exit mapping,
the additive retry, both strict modes, all combinations of CI-repair flag and
missing/present finding number, and both allowed in-place cases.

All test commands used netguard and the bounded worker-validation runner:

- `node --test --test-concurrency=2 test/hameditplan-01.test.mjs
  test/hamscope-01.test.mjs test/hammertrim-contract.test.mjs`: 79 passed.
- `node --test --test-concurrency=2` over every test file selected by
  `git grep -l -e hammer-edit-plan -e hammer-prompt -- 'test/*.test.mjs'`,
  plus `test/merge-agent-doc-contract.test.mjs` and `test/smv.test.mjs`:
  567 passed, two skipped, two existing repository-registration failures.
  The failing test and dispatcher match `origin/main`; HAMEDITPLAN-02 also
  records these same native-dispatch registration failures.
- Changed-file ESLint with `--fix`, `npm run lint` (zero errors, 152 existing
  warnings), `npm run typecheck:contracts`, the offline research walkthrough's
  byte-equivalence check, and `git diff --check` passed.

Final changed-file ESLint and
`node --test test/hameditplan-01.test.mjs test/hamscope-01.test.mjs`
passed (26 tests).

The required `npm test` attempt exited 1 with the repository runner's
`ETIMEDOUT` after its 900-second deadline, including cancellation diagnostics
for unfinished files. This is an incomplete full-suite result, not a green
run; HAMEDITPLAN-02 records the same baseline timeout. No broad rerun or live
smoke was performed.

Final comment-only remediation validation passed after rebasing onto fresh
`origin/main`: `node test/run-tests.mjs test/hameditplan-01.test.mjs
test/hamscope-01.test.mjs` (26 tests), changed-file ESLint, `npm run lint`
(zero errors, 152 existing warnings), `npm run typecheck:contracts`,
`bash demo/research-finding-walkthrough.sh`, and `git diff --check`.
Commands used the checked-in bounded runner. The full suite is left to PR-head
CI under this final round's validation rules.
