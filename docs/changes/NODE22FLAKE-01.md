# NODE22FLAKE-01

## Summary

On loaded CI runners, some tests failed at random because their result
depended on wall-clock timing. Different runs failed different tests, so
pull requests went red even when the change under review was not the cause.
This change makes the affected tests depend on conditions, not on how fast
the host runs. No production code changes.

- `test/osgbackfillpace-01.test.mjs`: the live-writer concurrency test used a
  writer with a 100 ms SQLite busy timeout. In effect it required every
  backfill write transaction to finish within 100 ms of host time. On a slow
  runner a transaction took longer, so the writer reported `SQLITE_BUSY`.
  The writer now commits on demand. At every backfill yield, the production
  pacer (`createBackfillWritePacer`) gives it one turn, then sleeps its full
  computed yield. The writer uses `busy_timeout=0`, so a turn that finds the
  write lock held fails at once. The test asserts the following:
  - the writer never hit `SQLITE_BUSY`;
  - it got one turn per backfill write transaction;
  - every turn committed;
  - the duty cycle stayed within bounds.

  It still proves that a live writer keeps committing while the backfill
  projects new and captured passes. It now proves this without depending on
  transaction duration. If the backfill yielded while holding the lock, or
  never yielded, the test still fails.
- `test/history-read-budget.test.mjs`: several tests armed a real 25 to 250 ms
  history-read deadline. That deadline then raced real work: GitHub fixture
  reads, blob writes and a child spawn. On a slow host it could expire before
  the fixture reached the step under test. For example, "an injected diff
  ignoring abort cannot strand scratch cleanup" failed with no scratch
  directory, because the diff was never reached.

  These tests now use a virtual reader clock and `t.mock.timers`. Each test
  waits until the condition it is about holds, then advances the clock past
  the deadline. Examples of such conditions: a transport is in flight, the
  local diff was reached, or history finished and a proof stage started.
  Expiry still happens through the production timer callback. Scratch-cleanup
  checks now poll for the directory's removal, with the test timeout as the
  hang guard, instead of a fixed 100 × 5 ms loop. Converted tests:
  - HAMHISTORYBUDGET-01 whole-verification timeout;
  - shorter reader deadline;
  - timed-out stored history recovery;
  - proof-stage budget;
  - injected diff scratch cleanup;
  - real stalled diff child.

These changes add no retries, skips or version-specific exclusions, and they
raise no timeouts. The CI workflow is unchanged.

The Argus test "a restarted watcher pool adopts the Argus child lease while
ordinary runtime recovery ignores it" also flaked in the same window. Its
synthetic child PID was checked against the host's real `ps`. On a runner
where that PID belonged to a real process, the lease read as recycled.
CLOSERHEADPIN-01 already fixed it on `main` by injecting the PGID identity
probe, so this change does not touch that test.

## Interface changes

None.

## Verification

All commands ran in the netguard environment with
`ADVERSARIAL_REVIEW_TEST_TEMP_BASE=/tmp`, through `node test/run-tests.mjs`
on both touched files:

- Node 22.22.3, 24 runs, 12 in parallel beside 18 CPU-bound loops:
  24/24 green.
- Node 26.10.0, the same load: 24/24 green.
- Node 22, 6 runs under macOS background QoS (`taskpolicy -b`) beside 24
  CPU-bound loops: every converted test passed 6/6. The unmodified tests
  failed "an injected diff ignoring abort cannot strand scratch cleanup"
  in 2 of 6 runs under the same conditions. "A shorter reader deadline"
  also exceeded its hang guard in 2 of 6.
- Node 26, 12 runs under the same throttle: every converted test passed
  12/12.

Under that extreme throttle, about 100 times slower than normal, the existing
CLI test in `osgbackfillpace-01` also failed: its `spawnSync` 10 s hang guard
expired. That test is not timing-dependent at normal CI load. It has never
failed in CI, so this change leaves it unchanged rather than raise its
timeout.
