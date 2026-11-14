# FINDINGSSTATUSTIMEOUT-01

## Summary

Publication's status and keyed launch probes now use the publisher dispatch's
load-aware timeout policy instead of fixed 15-second bounds. Terminated reads
put the timeout and signal cause ahead of command echoes in the bounded batch
error and watcher log. They remain retryable without spending preparation
attempts; existing custody, intent, handoff and stale-release rules still apply.

The [SEV3 report](../postmortems/SEV3-findings-publication-probes-timed-out-under-load-2026-11-14.md)
records the supplied anonymised evidence, root cause and qualification limits.
The closure runbook describes the effective probe policy.

## Interface changes

No new option, environment variable, config key or durable state. Both probes
use `dispatchTimeoutMs()` and the existing
`adversarial.reviewer.load_aware` settings. Probe diagnostics now identify
timeouts and signals within the first 300 characters.

## Verification

- `node --test test/findings-batch.test.mjs`: 152 tests passed, zero failures.
  Run through the bounded worker validation runner with a 600-second limit and
  the required netguard environment. Synthetic reads model 20 seconds under
  load; killed, timed-out, signalled and typed read failures retain their cause
  and retry successfully. Includes PUBLISHINTENTSTRAND-01 and
  FINDINGSDECISIONHOLD-01 regression cases.
- Scoped ESLint on `src/findings-batch.mjs` and
  `test/findings-batch.test.mjs`: passed.
- `npm run lint`: passed with zero errors and 149 existing warnings outside
  the changed files.
- `npm run typecheck:contracts`: passed.
- `git diff --check`: passed.

Only the touched test file was run, per ticket scope. No production recovery
or live-state changes were performed.
