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
