# LOADAWARESTDERR-01

## Summary

Use native CPU counter deltas on macOS instead of spawning `ps`. A cold,
unreadable, unchanged or stale sample uses the existing last-good/full-load
fallback. Preserve the multiplier curve, timeout budgets, caps and cache periods.

## Interface changes

Timeout-helper diagnostics are silent by default. `LOAD_AWARE_TIMEOUT_DEBUG=1`
enables CPU substitution and config-fallback messages on stderr. Explicit
sampler diagnostic callbacks remain supported. The closure runbook documents
sampling and the operator-owned activation receipt.

## Verification

Tests ran individually through `cwp_dispatch.worker_validation`, bounded to
600 seconds with `NETGUARD_LOG` and the required netguard `PATH`:

- `node --test test/load-aware-timeout.test.mjs`: 37 passed.
- `node --test test/finalization-queue-gsr.test.mjs`: 4 passed.
- `node --test test/load-aware-call-timeouts.test.mjs`: 16 passed.
- `node --test test/basefetch-01.test.mjs`: 9 passed.

`npm run lint` passed with zero errors and existing unrelated warnings.
Changed-file ESLint and `npm run typecheck:contracts` passed.
`bash demo/research-finding-walkthrough.sh` passed with three byte-stable
deliveries. The operator-only activation plan passed the existing schema
parser. The full suite was not run, per the host constraint.

The supplied historical GSR test is absent on this trunk; the new synthetic
regression pins its reported stderr and exercises the current finalization
queue CLI.
