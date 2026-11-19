# ARWATCHERRSS-02

## Summary

Reuse the watcher's native child latency histograms across polls. A controlled
replay attributed synthetic RSS growth to recreating the histograms every
pass. The SEV3 report records the reproduction and the remaining uncertainty
about the full service growth rate.
[SEV3 report](../postmortems/SEV3-watcher-native-histogram-allocation-ARWATCHERRSS-02.md)

Final remediation links both same-day reports and records the earlier replay's
unverified child-event coverage. The regression test now explicitly identifies
allocation count as its guard, with the external-memory bound only a sanity
check. Its measured file duration (44,119 ms on Node 26) is recorded in
`test/fixtures/suite-durations.json` for scheduling. Memory debug sampling lives
in the existing latency module, keeping `watcher.mjs` below the unchanged
ARC-18 ceiling after CI exposed the size regression.

## Interface changes

`NODE_DEBUG=adversarial-watcher-memory` enables a per-poll debug line with
`rss`, `heapUsed`, `external` and `arrayBuffers` in bytes.

## Verification

- `node test/run-tests.mjs test/watcher-poll-memory.test.mjs test/watcher-latency.test.mjs test/watcher-claim-loop.test.mjs`
  passed all 191 tests.
- `npm run lint` passed with zero errors. `npm run typecheck:contracts` and
  `bash demo/research-finding-walkthrough.sh` passed.
- Final remediation: `node test/run-tests.mjs test/watcher-poll-memory.test.mjs
  test/watcher-latency.test.mjs test/arc18-decomposition-gates.test.mjs` passed
  all 8 tests. The isolated timing reporter measured the memory-test file at
  44,119 ms; histogram allocations stayed at ten for all 180 polls.
- `node test/run-tests.mjs test/watcher-claim-loop.test.mjs
  test/reviewer-burst-lease.test.mjs test/reviewer-workspace.test.mjs` passed
  all 290 tests in the bounded targeted run, including both size assertions
  and the workspace cleanup case that failed on the reviewed CI head.
- The memory-debug smoke verified that the disabled path skips
  `process.memoryUsage()` and the enabled path emits all four counters.
  Lint (zero errors), contract typechecking and the offline walkthrough passed
  again. Full-suite validation remains with PR-head CI.
