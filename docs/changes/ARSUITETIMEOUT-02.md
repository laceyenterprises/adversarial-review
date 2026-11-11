# ARSUITETIMEOUT-02

## Summary

Schedule test files longest first using measured wall times. A single native
Node coordinator feeds the next pending file to each free worker, retaining
the previous eight-worker concurrency, capped by the number of selected files.
CPU count does not reduce concurrency on smaller hosted runners.
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

The controller census-loss and history-progress fixtures retain main's
ARCIDEFLAKE-01 deterministic clocks, readiness handshake and synthetic timeout
injection. The operator-approval fixture keeps
both classification retries with zero fixture delay. Existing integration
operations and assertions remain intact, including real process timeout tests.

## Interface changes

`npm test` remains the full-suite entrypoint. Exact paths or basenames passed to
`node test/run-tests.mjs` select files. `AR_TEST_TIMINGS=/absolute/path.json`
records per-file wall times, exit statuses, native test counts and total worker
wall time. Relative report paths resolve against the caller's working directory
before entering the disposable sandbox. Node's engine floor is now 22.10,
the first Node 22 release with native `run({ execArgv })` support; process
isolation support arrived in 22.8. The native API receives the ordered file
list and concurrency directly, without unused shard partitions.
`test/fixtures/suite-durations.json` supplies scheduling hints only;
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

Runner regressions cover measured scheduling, eight-worker bounds, deterministic ordering,
actual overlap within the worker bound, named file failures and the unchanged
timeout message. Sandbox regressions retain signal propagation, descendant
termination and cleanup coverage. Loader regressions exercise synchronous and
fallback modes, source overrides, CommonJS imports and syntax preservation.

The earlier Node 26 checkpoint passed all 829 files in 613.135 seconds,
matching the PR body's acceptance evidence. The previously quoted 522.201-second
figure is omitted because it is not part of that checkpoint record. A 32-worker Node 22 trial
completed 832 files in 784.802 seconds with one failure at an unchanged
45-second fixture subprocess limit in `hammer-self-rebase.test.mjs`. That
fixture deadline flake is tracked separately by ARCIDEFLAKE-01. Higher bounds
increased aggregate file elapsed time and resource contention, so the final
bound is eight workers.

The final eight-worker full runs on Node 22 and Node 26 reached the unchanged
900-second deadline on the shared validation host. The refreshed Node 26 run
reported no assertion failure before the cutoff. Local full-suite timings are
affected by heavy disk I/O contention and do not establish the approximately
450-second hosted-runner target. Under the approved continuation, publication
proceeds with this limitation documented; existing hosted CI jobs supply the
performance evidence, followed by the SRE observation above.

Lint, contract typechecking, ESLint on changed JavaScript files (zero errors),
and the byte-equivalence demo passed.
The final focused runner, loader, sandbox, root-isolation and history-clock
checks passed on both Node 22.22.3 and Node 26.10.0: 44 tests on each version,
zero failures or skips. These commands used netguard and a 300-second outer
bound.

### Final comment-only remediation

The reviewed head `a39d2e3da88734b667307cfa7cfb96137cd23986` passed its
existing hosted test jobs on `ubuntu-24.04`. The **Run kernel + adapter test suite**
step took 613 seconds on Node 22.23.4 (07:46:21–07:56:34 UTC) and 709 seconds on
Node 26.10.0 (07:46:25–07:58:14 UTC) on 2026-11-11:
[Node 22 job](https://github.com/laceyenterprises/adversarial-review/actions/runs/42981897272/job/130393996610),
[Node 26 job](https://github.com/laceyenterprises/adversarial-review/actions/runs/42981897272/job/130393996283).
Both logs report eight measured parallel workers. These green runs remain above
the approximately 450-second observation target; they do not establish that
target or the runner's exact CPU count. Retaining eight
workers prevents the CPU-derived bound from halving the previous concurrency.
SRE's existing superproject observation plan remains the owner of subsequent
timing evidence; this remediation does not change that plan.

The prompt-contract fixture again terminates its process group after the shell
leader exits, so descendants retaining output pipes cannot defeat its command
timeout. A regression backgrounds a SIGTERM-resistant descendant and verifies
that the existing timeout and SIGKILL escalation finish the command.

Remediation validation used `bash bin/run-bounded.sh` and targeted files only:
`node test/run-tests.mjs parallel-runner.test.mjs hammer-prompt-contract.test.mjs
hq-root-runner.test.mjs temp-sandbox-guard.test.mjs` passed 19 tests on each of
Node 26.10.0 and Node 22.22.3, with no failures or skips. The Node 22 run required
a temporary rebuild of the checkout's Node 26 `fs-ext` binary; the original
binary was restored afterward. `npm run lint` passed with zero errors (149
existing warnings), ESLint on the five changed test JavaScript files passed,
`npm run typecheck:contracts` passed, and
`bash demo/research-finding-walkthrough.sh` passed.
`node scripts/validate-data-model-catalog.mjs` validated all 93 entries, and
`git diff --check` passed. Full-suite validation remains owned by PR-head CI.

### Fresh PR on current main

Supersedes PR 1822. The retained head
`22ee1ece61aea244e1ea2998f37c922a9c846c32` was squashed onto
`5a20312144f56070506ecc277b1c759653f1c8f5`. Both conflicting files,
`test/hammer-controller.test.mjs` and `test/history-read-progress.test.mjs`,
retain main's complete versions: ARCIDEFLAKE-01 already supplies deterministic
fixture behavior, so the older PR's competing clock changes are redundant.
All other code changes from the retained head are preserved, along with main's
intervening changes. No fixture deadline is raised.

The latest review's findings are all applied in the retained head: eight
workers independent of CPU count; Node 22.10 engine floor in both manifests;
descendant group cleanup after leader exit with a regression; caller-relative
timing report paths with a regression; and consistent 613.135-second checkpoint
evidence. Its advisory simplification is also applied: ordered files and an
explicit concurrency replace unused shard partitions. The hosted timings above
belong to the earlier reviewed head, not this fresh PR; this head's ordinary CI
must supply its own results. No full local suite is run for this rewrite.

Fresh-head validation on Node 26.10.0: all 14 touched test files passed,
813 tests total, with no failures or skips. Each file ran separately through
`node test/run-tests.mjs <file>`, under the required netguard environment and
the runtime Python `cwp_dispatch.worker_validation` wrapper with a 600-second
per-command bound. This includes all 168 watcher claim-loop tests.
`npm run lint` and ESLint on all changed JavaScript passed with zero errors
(149 existing production warnings and one existing fixture warning).
The installed `scripts/ci-mirror/run-ci-mirror.py` passed the CDM re-derivation
audit and contract typecheck, deferring its slow full-suite check normally;
this repository does not vendor that script. `git diff --check` passed.
