# TESTLOADHYGIENE-01

## Summary

Disable automatic Git maintenance and garbage collection for fixture
commits and fetches under the shared offline runner. Bound local and closer test
parallelism to reduce contention on shared hosts.

See the [SEV1 report](../postmortems/SEV1-TESTLOADHYGIENE-01-fixture-process-load-2026-11-20.md).

## Interface changes

`AR_TEST_CONCURRENCY` sets the local Node test worker limit. The default is
half the available logical CPUs, rounded down and clamped to one through
four. The repository runner retains its eight-worker limit in CI. The suite
deadline stays at 900 seconds when the selected parallel files fit within the
configured worker limit. Otherwise it scales to `900 * 8 / min(8, limit)`
seconds (1800 at a four-worker limit). Generic bounded validators preserve
caller arguments; the local concurrency setting belongs only to this
repository’s runner. The Git fixture
environment is shared with its regression test, which explicitly builds it
and covers commit, push and fetch. Push receivers configure maintenance
separately, and helpers replacing command configuration own their settings.

## Verification

The isolated Git commit probe observed one auto-maintenance exec with Git's
defaults and zero with the fixture settings. A scratch commit, push and fetch
went from three auto-maintenance execs to one on the receiving side of the push.

- `node --test --test-concurrency=2 test/parallel-runner.test.mjs test/run-bounded.test.mjs test/hammer-api-publish-cli.test.mjs`
  passed all 58 fixture and helper tests with the offline guard.
- `npm run lint` completed with zero errors.
- `npm run typecheck:contracts` passed.
- `bash demo/research-finding-walkthrough.sh` produced three byte-stable deliveries.

### Remediation verification

- Targeted runner, sandbox cleanup and HQ-root isolation: 28 cases passed,
  including scaled deadline expiry and unexpected-unwind cleanup.
- Bounded-validator suite: 17 cases passed, including argument preservation.
- Existing API-publication CLI suite: all 29 cases passed.
- `npm run lint`: zero errors (149 existing warnings).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: three byte-stable deliveries.
- Full-suite wall time remains unmeasured: this remediation job prohibits
  full local suite runs; PR-head CI remains the full-suite gate.

### Final comment-only round

Targeted runs no longer stretch their deadline merely because fewer files were
selected. Timeout and unexpected-unwind fixtures explicitly select two files
with `AR_TEST_CONCURRENCY=1` to exercise the scaled deadline; single-file and CI
timeout fixtures retain the 900-second bound.

Follow-up for the deployment owner: record the selected-file count, configured
worker limit, validation wall time and timeout outcome for organic hammer runs,
especially sets larger than four files and hosts with two or three logical
CPUs. Compare with the former eight-worker behavior before deciding whether the
unchanged outer validation budget needs adjustment. This round supplies no
post-deploy throughput measurement.

The PR body's concurrency claim and `src/ama/bounded-command.mjs` scope entry
are stale. The body should say that `AR_TEST_CONCURRENCY` affects this repository's
runner only and bounded validators preserve caller arguments, and remove
`src/ama/bounded-command.mjs` from scope and sensitive paths. PR-body mutation is
outside this worker's read-only GitHub authorization; the reply records this
operator follow-up.

- `node test/run-tests.mjs test/parallel-runner.test.mjs test/runner-sandbox.test.mjs test/hq-root-runner.test.mjs test/run-bounded.test.mjs`:
  48 tests passed under a 120-second outer bound.
- `npm run lint`: zero errors, 149 existing warnings; explicit ESLint on the
  four changed JavaScript files also passed.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: three byte-stable deliveries.
- `git diff --check`: passed. Full local suites remain deferred to PR-head CI.
