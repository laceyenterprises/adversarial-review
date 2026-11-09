# CENSUSEIO-01

## Summary

Retry transient Darwin process-group census reads and embryonic/moving process
records within a bounded load-aware window. Retry controller census polls during
validation and merge before cancellation, preserving signal and lease fences.
See the [SEV2 report](../postmortems/SEV2-CENSUSEIO-01-controller-census-transient-read-failure.md).

## Interface changes

The request protocol and successful replies are unchanged. Exhaustion retains
errno, retryable and actual attempts, adding `elapsedMs`; stderr adds bounded
attempt/elapsed tokens. Adapters expose `censusAttempts` and `censusElapsedMs`.
Controller receipts add `censusFailure` and exhaustion `reasonDetail` with
requests, attempts, elapsed time and last errno. The internal helper budget is
passed through `HAM_CENSUS_RETRY_BUDGET_MS`, sized once by the JS caller; this
requires no operator configuration. Canonical runbook and store docs describe
the bounds and unknown-census safety rules.

## Verification

Scoped suites run individually through `python3 -m cwp_dispatch.worker_validation
--repo-root . --timeout-seconds 600 --command node --test <file>`, with
`NETGUARD_LOG=<file>` and the prescribed network-guard PATH for tests only.

- `test/controller-process-census.test.mjs`: 18 passed, one sandbox setuid skip;
  includes the Python unittest fixtures in `test/fixtures/controller-census.py`.
- `test/hammer-controller.test.mjs`: 109 passed, one sandbox setuid skip.
- Contract typecheck (`npm run typecheck:contracts`): passed.
- Scoped ESLint: passed with zero errors or warnings.
- `npm run lint`: passed, zero errors and 152 warnings outside changed files.
- `ruff check --fix` and `ruff format` on both changed Python files: passed.

The ticket limits execution to touched test files, so the full repository test
suite and demonstration were not invoked directly.
