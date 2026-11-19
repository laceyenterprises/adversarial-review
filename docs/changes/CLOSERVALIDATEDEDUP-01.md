# CLOSERVALIDATEDEDUP-01

## Summary

The closer can skip a selected local CI-mirror check when the repository maps
its command to GitHub Actions jobs and every mapped job succeeded on the
validation head. Checks with missing or uncertain evidence run locally.
Validation receipts and the closing result record the decisions and cite the
GitHub Actions run IDs.

## Interface changes

The policy defaults to on. Set `HAM_LOCAL_VALIDATION_CI_DEDUP=0` to run the
full selected local battery. Repositories opt in per command with `ci_jobs`
in their mirror manifests. See the
[closure runbook](../RUNBOOK-ama-closure.md#leasefair-01-fair-merge-lease-service).

## Verification

`npm test -- test/hamcontrollerscript-01.test.mjs test/hammer-pr-read.test.mjs`
passed all 36 tests. ESLint, contract typechecking, ShellCheck, and the
offline research-finding walkthrough passed.

Offline closer fixtures cover exact-head success, skipped and neutral jobs,
another head, missing and ambiguous jobs, local-only and unmapped checks,
manifest and check-read failures, conditional-cache reuse, and the off switch.
They also check that a local exit 75 still stops the close and appears in its
receipt.

## Final comment-only remediation

Unconfirmed skip probes now run the original check locally and retain its
actual outcome. Coverage requires a byte-identical manifest at the pinned PR
base as well as the head and checkout, so a PR cannot grant itself new coverage.
Coverage reads use latest check attempts and a non-urgent budget scope; budget
deferrals fall back locally with `ci-budget-deferred`.

The offline mirror fixture now matches the upstream `Check`, `CheckResult`,
`load_manifest`, `run_check` and `run_checks` signatures, including keyword-only
environment arguments, duplicate selection via `replace`, submodule working
directories and module-level environment refusal. Execution remains synthetic.
A native upstream covered-checks hook remains a separate Agent OS follow-up;
this repository cannot remove its compatibility wrapper until that hook exists.

Validation: the two targeted suites passed all 42 tests. `npm run lint`
reported zero errors (149 existing warnings); contract typechecking, the
data-model catalog validator, Python syntax parsing, `git diff --check`, and
the offline research-finding walkthrough passed. The full suite is left to
PR-head CI.
