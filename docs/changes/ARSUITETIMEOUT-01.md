# ARSUITETIMEOUT-01

## Summary

Advance synthetic rate-limit resets with a virtual clock, including the nested
throttle reached by retrying GitHub fixtures. Run hammer phase scenarios through
their existing synthetic executor without repeatedly starting the timeout helper
and its budget-sizing subprocess. The dedicated helper suite continues to test
timeouts and process cleanup. Synthetic GitHub replies load production predicates
and writers only in the fixture commands that use them.
Both explicit Node calls and direct helper shebangs use the fixture runtime.
The hammer fixture's short-lived Node helpers share a disposable, file-scoped
compile cache, removed by the file's cleanup hook.
The rendered shell advances its existing file-backed clock with Bash builtins;
child processes use matching executable clock shims. API publication subprocess
fixtures also inject retry sleep and assert the 500/1000 ms backoff policy.

The 900-second suite cap, concurrency, CI jobs and check names are unchanged.
No tests are removed or newly skipped.

## Interface changes

`rateLimitClock` exposes the default throttle's clock and asynchronous sleep for
injection. Production defaults retain wall time and real sleeps. Explicit
`createRateLimitThrottle` clock/sleep arguments retain precedence.
`hammerNetworkClock.sleep` provides the same seam to API publication entrypoints;
explicit per-call `sleep` injection still takes precedence. Retry counts,
credential handling, expected-head CAS and native subprocess timeouts are
unchanged.

## Verification

Per-file before/after measurements use Node 26.10.0, offline under netguard.
The PR body records the measurements and baseline limitations; its ordinary
Node 22 CI run is the full-suite acceptance measurement.

`npm run lint` passes with zero errors; contract typechecking and
`bash demo/research-finding-walkthrough.sh` pass. The throttle, API network,
helper-step and helper-launch suites pass. Real elapsed-time coverage stays in
`hammer-helper-step.test.mjs`, including “slow base-head read succeeds beyond
nominal within its synthetic scaled budget”, “first timeout retries once and
publishes only successful read output”, “two timeouts record step, effective
seconds, multiplier and attempts”, and “a timed-out mutation executes once and
preserves its partial receipt”. The `api-timeout` CLI scenario still injects
genuine native process timeouts.

SRE must observe the next ordinary main run containing the fix: `npm test
(Node 22)` is green with suite wall time well under 900 seconds. Retain the run
link and timing in the companion incident report. The repository-local PR
declaration contains an operator observation only.
