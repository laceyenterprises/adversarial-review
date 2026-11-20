# FINDINGSDRAINRATE-01

## Summary

The live findings-batch collector's submission concurrency is now configurable,
and the backlog summary reports last-hour capture against resolution, so an
operator can see a growing backlog and match the drain to review volume
without ad-hoc SQL. Report:
[SEV3 findings drain throughput](../postmortems/SEV3-FINDINGSDRAINRATE-01-findings-drain-throughput-was-fixed-while-capture-scaled-2026-11-20.md).

## Interface changes

- `ADVERSARIAL_FINDINGS_BATCH_CONCURRENCY` (positive integer, default 2; was a
  fixed 1) in `findingBatchOptions`. The watcher's findings-batch ticker passes
  it to `runFindingBatches`. An invalid value refuses the pass before any claim
  or submission, like the other findings-batch settings. Direct
  `runFindingBatches` callers keep their explicit `concurrency` (default 1), and
  `bin/findings-batch-backfill.mjs --concurrency` is unchanged.
- `summarizeFindingBacklog(...).rates`: `capturedLastHour`, `resolvedLastHour`,
  `batchesCompletedLastHour` and `netLastHour` (captured minus resolved). It
  reaches pipeline health (`nonBlockingBacklog`), `bin/review-findings.mjs backlog`
  and the backfill tool's output.
- No store shape, claim, fencing, retry cap, release or dispatch-attempt change.
  No CFG schema key and no CI check.

## Verification

- `node --test --test-concurrency=2 test/findingsdrainrate-01.test.mjs`: 8/8 pass.
  Against the unpatched source, the knob, default, refusal and rate tests fail;
  the concurrent-collector fencing test passes on both because it pins existing
  behaviour.
- `node --test --test-concurrency=2 test/findings-batch.test.mjs test/findingsrequeue-01.test.mjs test/findings-batch-grades.test.mjs test/hamscope-01.test.mjs test/osgbackfillenroll-01.test.mjs`:
  92/92 pass.
