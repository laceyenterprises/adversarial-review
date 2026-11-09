# LOADAWARESTDERR-01

## Summary

Use native CPU counter deltas on macOS for warm sampling. A cold or stale
baseline (including changed CPU count) tries `ps` once within the existing
one-second sampling budget, preserving corroboration for one-shot hammer CLIs.
Unreadable or unchanged samples use the existing last-good/full-load fallback.
Preserve the multiplier curve, timeout budgets, caps and cache periods.

## Interface changes

Timeout-helper diagnostics are silent by default. `LOAD_AWARE_TIMEOUT_DEBUG=1`
enables CPU substitution and config-fallback messages on stderr. Explicit
sampler diagnostic callbacks remain supported. The closure runbook documents
sampling and the operator-owned activation receipt.
The receipt now requires finite native warm evidence separately from quiet
stderr. Linux and macOS daemon diagnostics remain opt-in; the runbook makes
that observability limit and debug-enabled diagnosis explicit. No automatic
health metric or status field is introduced. CPU fixtures that mock `ps` pin
the Linux sampler so warm macOS reads cannot escape the fixture.

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

Final comment-only remediation validation used `bash bin/run-bounded.sh
--timeout 120 -- node --test` with these targeted files; all passed:

- `test/load-aware-timeout.test.mjs`
- `test/load-aware-call-timeouts.test.mjs`
- `test/load-aware-operational-waits.test.mjs`
- `test/timeoutsweep-control.test.mjs`
- `test/watcher-poll-guard.test.mjs`
- `test/findings-batch.test.mjs`
- `test/load-time-kit.test.mjs`
- `test/load-time-regressions.test.mjs`
- `test/finalization-queue-gsr.test.mjs`
- `test/basefetch-01.test.mjs`

The new synthetic macOS CLI case returns 784 seconds for a nominal 360-second
budget at load/core 3 and 20% CPU busy, with empty stderr for debug on and off.
Denied cold `ps` recovers through native deltas on the next sample interval.
`npm run lint` passed (zero errors, existing unrelated warnings),
`npm run typecheck:contracts` passed, and
`bash demo/research-finding-walkthrough.sh` passed with three byte-stable
deliveries. The existing post-merge `parse_prompt_payload` schema parser accepted
the receipt with one operator step and zero automated actions.
`git diff --check` passed. No full local suite or live activation was run.
