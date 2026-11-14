# LOADCAPS-01

## Summary

Seven remaining fixed closer-path budgets now use `loadAwareTimeoutMs`:
primary-change region diagnostics (15 seconds), safety-stop repair PR reads
and dispatch (15 and 60 seconds), pre-receipt PR attempt and total reads
(3 and 5 seconds), pushed-attestation API calls (15 seconds), and the helper
timeout-sizing subprocess (5 seconds).

## Interface changes

No new command or configuration. Existing unloaded bases and explicit
effective diagnostic timeout overrides are preserved. Repair PR reads share
one scaled attempt/total budget; pre-receipt retries stay inside their scaled
total budget.

## Verification

Synthetic idle and busy host readings check the actual timer or subprocess
budget at every changed call site, including total-budget retry clipping.
No host load is generated.

- Focused tests passed using `node test/run-tests.mjs` for
  `test/primary-change.test.mjs`, `test/safety-stop-repair.test.mjs`,
  `test/ama-pre-receipt-intent.test.mjs`, and
  `test/closer-cli-load-timeouts.test.mjs`.
- All 102 related test files were exercised in three groups, each bounded to
  an absolute 600 seconds. Two initial failures in the unchanged
  `hammertrim-contract.test.mjs` cleared on an isolated full-file rerun:
  `ADVERSARIAL_TEST_RESTRICTED_PROCESS_PROBE=1 node test/run-tests.mjs test/hammertrim-contract.test.mjs`
  passed all 53 tests. That existing fixture option accepts fail-closed
  cleanup uncertainty on restricted hosts. The common-close timing fixture
  also passed against both original and patched code in isolation. The other
  101 files passed in their initial groups; two existing tests were skipped.
- `npm run lint`: passed with zero errors (existing warnings elsewhere).
- ESLint with `--fix` on changed JavaScript files: passed without warnings.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed with three byte-stable
  transcript deliveries.
- `node scripts/audit-cdm-rederivation.mjs --strict --format json --out /tmp/loadcaps-cdm-audit.json`:
  passed with zero findings.
- `npm test`: attempted, but did not complete within the requested
  600-second budget. The validation wrapper scaled that timeout; the attempt
  was stopped and cleaned up. Related-test groups use an absolute 600-second
  limit around the wrapper.
