# ARSUITETIMEOUT-01

## Summary

Advance synthetic rate-limit resets with a virtual clock, including the nested
throttle reached by retrying GitHub fixtures. Give each virtual-clock test its
own rate-limit store so synchronous wall-clock budget reads cannot inherit
future reset timestamps; carry virtual time forward between tests so expired
in-memory observations stay expired. Virtual sleeps yield to real lock-holder
I/O before advancing time. Default shared-state locks retain wall time and real
retry sleeps, independent of the virtual budget clock, so filesystem timestamps
and lock deadlines remain comparable under contention.
Run most hammer phase scenarios through their existing synthetic executor
without repeatedly starting the timeout helper and its budget-sizing subprocess.
The `old-reply` and `old-reply-foreign` self-rebase scenarios retain the real
helper across the rendered phases, including the shebang-launched `rebase-result`
proof's success and refusal paths. The API publication CLI suite retains and
asserts real `api-publish` helper execution through the rendered publication
phase, including failed scratch adoption. The dedicated helper suite continues
to test timeouts and process cleanup. Synthetic GitHub replies load production
predicates and writers only in the fixture commands that use them.
Both explicit Node calls and direct helper shebangs use the fixture runtime.
The hammer fixture's short-lived Node helpers share a disposable, file-scoped
compile cache under the runner's sandbox. Direct file launches use that runner
too; file cleanup and synchronous exit hooks remove the cache normally, and
parent sandbox cleanup covers forced termination.
The rendered shell advances its existing file-backed clock with Bash builtins;
child processes use matching executable clock shims. API publication subprocess
fixtures also inject retry sleep and assert the 500/1000 ms backoff policy.

The 900-second suite cap, concurrency, CI jobs and check names are unchanged.
No tests are removed or newly skipped. Most phase scenarios bypass the helper;
the representative integration scenarios above preserve its in-context coverage.

## Interface changes

`rateLimitClock` exposes the default throttle's clock and asynchronous sleep for
injection for budget policy only. Production defaults retain wall time and real
sleeps. Explicit `createRateLimitThrottle` clock/sleep arguments retain precedence
for both budget policy and lock behavior.
`hammerNetworkClock.sleep` provides the same seam to API publication entrypoints;
production code must not assign to that shared test seam. Explicit per-call
`sleep` injection still takes precedence. Retry counts,
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

Final comment-only remediation also passes the new virtual-clock regression
suite, duplicate-family workflow, throttle, state-owner and load-aware-call
timeout suites (75 tests in that targeted group). The hammer API CLI, API
publication, helper-step, bounded-git-sync and follow-up merge-agent suites
reported no failures in a bounded multi-file run; its 240-second command cap
interrupted the self-rebase file. Re-running `node test/run-tests.mjs
hammer-self-rebase.test.mjs` alone under `bash bin/run-bounded.sh --timeout 600`
passes. Lint (zero errors), contract typechecking, the offline research demo and
`git diff --check` pass. The full suite remains delegated to PR-head CI.

SRE must observe the next ordinary main run containing the fix: `npm test
(Node 22)` is green with suite wall time well under 900 seconds. Retain the run
link and timing in the companion incident report. The repository-local PR
declaration contains an operator observation only.
