# FINDINGSDRAINRATE-01

## Summary

The live findings-batch collector's submission concurrency is now configurable,
and the backlog summary reports last-hour capture against resolution, so an
operator can see a growing backlog and match the drain to review volume
without ad-hoc SQL. Report:
[SEV3 findings drain throughput](../postmortems/SEV3-FINDINGSDRAINRATE-01-findings-drain-throughput-was-fixed-while-capture-scaled-2026-11-20.md).

## Interface changes

- `ADVERSARIAL_FINDINGS_BATCH_CONCURRENCY` (integer 1–8, default 2; was a
  fixed 1) in `findingBatchOptions`. The watcher's findings-batch ticker passes
  it to `runFindingBatches`. An invalid value refuses the pass before any claim
  or submission, like the other findings-batch settings. Direct
  `runFindingBatches` callers keep their explicit `concurrency` (default 1), and
  `bin/findings-batch-backfill.mjs --concurrency` is unchanged.
  Explicit live ticker overrides obey the same maximum of 8, bounding host
  subprocess provisioning independently of HQ admission.
- `summarizeFindingBacklog(...).rates`: `capturedLastHour`, `resolvedLastHour`,
  `batchesCompletedLastHour` and `netLastHour` (captured minus resolved). It
  reaches pipeline health (`nonBlockingBacklog`), `bin/review-findings.mjs backlog`
  and the backfill tool's output.
- Additive migration `20261120_findings_rate_indexes.sql` supplies three partial
  expression indexes for last-hour automatic capture, resolution and completion
  range reads. Normalized timestamp comparisons retain offsets and exact hour
  boundaries; selected work remains excluded. Index creation reads existing
  history once during schema migration; subsequent rate reads search the range.
- No column, lifecycle, claim, fencing, retry cap, release or dispatch-attempt change.
  No CFG schema key and no CI check.

## Verification

- `node --test --test-concurrency=2 test/findingsdrainrate-01.test.mjs`: 13/13 pass.
  Against the unpatched source, the knob, default, refusal and rate tests fail;
  the concurrent-collector fencing test passes on both because it pins existing
  behaviour.
  Remediation adds upper-bound and pre-claim refusal coverage, including explicit
  ticker overrides. A populated fixture (2,000 findings and 2,000 historical
  batches) verifies replay-safe index creation, unchanged rates with offsets,
  exact-cutoff exclusions and selected work, and three index searches in the
  actual summary query's `EXPLAIN QUERY PLAN`.
- Legacy selection-scope fixtures remove dependent rate indexes before modeling
  old columns. Closure-latency accounting separates the new migration's sentinel
  reads while preserving the existing non-migration read budget.
- `node --test --test-concurrency=2 test/findings-batch.test.mjs test/findingsrequeue-01.test.mjs test/findings-batch-grades.test.mjs test/hamscope-01.test.mjs test/osgbackfillenroll-01.test.mjs`:
  92/92 pass.
