# FINDINGSSTATUSTIMEOUT-01

## Summary

Publication's status and keyed launch probes now use a read-scale load-aware
30-second nominal instead of fixed 15-second bounds. Publisher dispatch keeps
its separate 900-second provisioning nominal. Terminated reads
put the timeout and signal cause ahead of command echoes in the bounded batch
error and watcher log. They remain retryable without spending preparation
attempts; existing custody, intent, handoff and stale-release rules still apply.

The [SEV3 report](../postmortems/SEV3-findings-publication-probes-timed-out-under-load-2026-11-14.md)
records the supplied anonymised evidence, root cause and qualification limits.
The closure runbook describes the effective probe policy.

## Interface changes

No new option, environment variable, config key or durable state. Both probes
use `publicationReadTimeoutMs()` and the existing
`adversarial.reviewer.load_aware` settings. Probe diagnostics now identify
timeouts, signals and output-limit failures within the first 300 characters.
The runbook documents whole-pass delay and accumulated publication budgets.

## Verification

- `node test/run-tests.mjs test/findings-batch.test.mjs test/findings-batch-regressions.test.mjs`:
  186 tests passed across two selected files, zero failures. Run through
  `bin/run-bounded.sh` with a 120-second limit. Synthetic reads model 20 seconds
  under load and assert a 180-second probe budget at 6× while provisioning keeps
  5,400 seconds. Killed, timed-out, signalled, output-limit and typed read failures
  retain their cause and retry successfully. Includes PUBLISHINTENTSTRAND-01 and
  FINDINGSDECISIONHOLD-01 regression cases.
- Scoped ESLint on `src/findings-batch.mjs` and
  `test/findings-batch.test.mjs`: passed.
- `npm run lint`: passed with zero errors and 149 existing warnings outside
  the changed files.
- `npm run typecheck:contracts`: passed.
- `node scripts/validate-data-model-catalog.mjs`: 98 entries validated.
- `bash demo/research-finding-walkthrough.sh`: passed with three byte-stable
  transcript deliveries.
- `git diff --check`: passed.

Only the two targeted test files were run. No production recovery
or live-state changes were performed.
