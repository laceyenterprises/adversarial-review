# ARSUITETIMEOUT-02

## Summary

Schedule test files longest first using measured wall times. A single native
Node coordinator feeds the next pending file to each free worker, with two
workers per available CPU, capped at eight and the number of selected files.
Each file retains its own process, repository-state root, home, temporary
directory and disposable subprocess compile cache where useful. Listener
fixtures use ephemeral ports. `test/smv.test.mjs` runs alone before the parallel
phase because it verifies real per-step wall budgets across a process tree.
Its deadlines and assertions remain unchanged.

Repeated Git integration fixtures copy pristine, file-private seeds without
hardlinks or alternate object stores. Regression assertions prove that mutations
to objects, refs, worktrees and queue databases cannot reach other copies.
Queue fixture schema bootstrap uses a transaction and a closed pristine database;
production persistence operations remain real. Watcher fixtures use synchronous
loader hooks when available, preserving their per-case source overrides and
CommonJS behavior; older Node 22 versions retain asynchronous hooks. The loader
adapter changes syntax nodes only, preserving fixture strings and nested async
functions. Repeated subprocess suites use private compile caches.

The controller census-loss and history-progress fixtures advance controlled
policy clocks at explicit rendezvous points. The operator-approval fixture keeps
both classification retries with zero fixture delay. Existing integration
operations and assertions remain intact, including real process timeout tests.

## Interface changes

`npm test` remains the full-suite entrypoint. Exact paths or basenames passed to
`node test/run-tests.mjs` select files. `AR_TEST_TIMINGS=/absolute/path.json`
records per-file wall times, exit statuses, native test counts and total worker
wall time. `test/fixtures/suite-durations.json` supplies scheduling hints only;
missing measurements receive the median estimate and never omit tests.

Diagnostics retain deterministic scheduled order. A failed file names the file
and fails the suite after scheduled files finish. The existing 900-second suite
deadline, process-group termination and sandbox cleanup remain in force. No
workflow, required check or timeout changes are included.

## Incident

**Severity: SEV2.** Growth in the offline suite reduced the headroom below its
900-second deadline. Intermittent timeouts occurred while assertions were still
passing, delaying review-system changes. Measured scheduling and fixture setup
reuse reduce repeated work and overlap independent files within the existing job.
No live service, configuration or alerting state changes are part of this ticket.

SRE observes the next five ordinary PR runs and main runs after merge. Both
Node 22 and Node 26 test steps should finish in approximately 450 seconds or less,
without timeouts. The committed observation plan declares read-only operator
steps and executes no live action on merge.

## Verification

Measurement and final full runs use netguard with an outer 1,200-second bound.
The original Node 26.10.0 runner passed 828 files: 19,477 tests, 19,466 passing,
11 existing skips and no failures. Native wall time was 689.529 seconds
(696.369 seconds for the bounded command); summed per-file elapsed time was
4,873.872 seconds. The PR body records the baseline top twenty file durations
and aggregate counts without copying test output.

Runner regressions cover measured sharding, CPU bounds, deterministic ordering,
actual overlap within the worker bound, named file failures and the unchanged
timeout message. Sandbox regressions retain signal propagation, descendant
termination and cleanup coverage. Loader regressions exercise synchronous and
fallback modes, source overrides, CommonJS imports and syntax preservation.

Final validation on both Node versions is in progress under the approved
90-minute extension. The earlier Node 26 checkpoint passed all 829 files in
522.201 seconds; a subsequent cache measurement passed in 613.135 seconds.
A 32-worker Node 22 trial completed 832 files in 784.802 seconds with one
failure at an unchanged 45-second fixture subprocess limit. Higher bounds
increased aggregate file elapsed time and resource contention, so the final
bound is eight workers. These trials do not establish the 450-second target.
The subsequent eight-worker Node 22 run hit the unchanged 900-second deadline
(961.32 seconds including setup and cleanup). Its baseline scheduling hints
have since been refreshed from the completed 832-file measurement; the refreshed
plan still needs full validation on both versions. This is an unpublished
checkpoint, with performance acceptance outstanding.
Lint, contract typechecking and the byte-equivalence demo passed on the rebased
tree. Final results will replace this progress paragraph before publication.
