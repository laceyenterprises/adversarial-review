# ARSUITETIMEOUT-02

## Summary

Run test files in measured, bounded parallel shards within the existing test
job. Each file keeps a separate process, repository-state root, home, temporary
directory. Repeated CLI fixtures have disposable Node compile caches. Files use ephemeral listener ports;
there is no serial-only file list. Workers draw from a measured longest-first queue,
with filename ties and a median estimate for new files. Full diagnostics are
printed in deterministic scheduled order; failures identify the file and fail the suite after
all scheduled files finish. The existing 900-second deadline and process-group
cleanup still own the entire test tree. One native Node test coordinator schedules all file processes. Its bounded
worker slots form dynamic shards: each free slot takes the next longest pending
file. Preloads resolve through each file’s private repository root, avoiding
duplicate loading of production modules and cleanup hooks. Every file remains a fresh process. Temporary directories sit outside
the symlinked package tree so extensionless CommonJS fixtures retain their module
scope. Only the two repeated publication CLI fixtures enable private compile caches;
one-off test workers and other generated scripts are not cached. Prompt fixture cleanup never signals an exited process leader. The controller
census-loss fixture advances a controlled policy clock after readiness, so host
pauses cannot skip its TERM grace phase; its signal and lease assertions remain
unchanged. The history-progress fixture controls elapsed time and timeout timers,
expiring the original 100 ms budget at the stalled-comparison boundary.

## Interface changes

`npm test` and selected-file arguments remain the entrypoints. The CPU-derived
worker count is eight times the available CPUs, capped at sixteen and the number
of selected files. This permits subprocess/I/O fixtures to overlap while bounding
process pressure. `AR_TEST_TIMINGS=/absolute/path.json` writes file wall times,
statuses, native test counts and total worker wall time as JSON. Timing hints live in
`test/fixtures/suite-durations.json`; they affect scheduling only. Missing hints
do not omit tests. No workflow, required check or timeout changes are included.

## Incident

**Severity: SEV2.** The growing offline suite approached its 900-second deadline and intermittently
timed out while tests were still passing. This delayed review-system changes.
Alphabetical scheduling left long subprocess suites clustered together. Balanced
shards and private fixture seeds reduce that concentration. Recovery requires
ordinary CI observation on both supported Node versions: SRE records the next
five PR runs and main runs completing in approximately 450 seconds or less,
without timeouts. The repository-local post-merge declaration requests read-only
observation and executes no live action.

## Verification

Measurement and final full runs use netguard with an outer 1,200-second bound.
The baseline on Node 26.10.0 passed 828 files: 19,466 passing tests, 11 existing
skips and no failures. Native suite wall time was 689.529 seconds (696.369 seconds
for the bounded command); summed per-file elapsed time was 4,873.872 seconds.
The longest existing fixtures already advance policy waits virtually. The
remaining work is predominantly real Git and helper subprocess execution, which
retains its integration assertions and real timeout coverage.
The queue and self-rebase fixtures reuse file-private pristine Git seeds, copied
without hardlinks or alternate object stores for each case. All integration
operations and assertions remain real; a regression mutates one copy and checks
that peer and subsequent copies retain independent objects, remote refs and
queue databases. Fixture-only schema bootstrap uses transactions and a closed
pristine database copy; production operations retain their real persistence.
The PR body records the baseline top twenty file durations and aggregate counts,
plus the final observed timings. Runner regressions cover balanced shards,
CPU-derived bounds, deterministic ties/output, file failures, and the unchanged
suite-timeout message. Existing sandbox regressions cover signal propagation,
unexpected exits, descendant termination, and cleanup.

### Checkpoint status

The final single-coordinator Node 26.10.0 run passed all 829 files:
19,484 tests, 19,473 passing, 11 existing skips, zero failures. Suite wall
time was 522.201 seconds (531.390 seconds for the bounded command), versus
the 689.529-second baseline. This does **not** meet the 450-second target.
The runner/sandbox/history/smoke selection passed 28 tests. `npm run lint`
passed with zero errors and 149 existing warnings; `npm run
typecheck:contracts` and `bash demo/research-finding-walkthrough.sh` passed.

Full Node 22 validation and further performance work remain pending. The
2.5-hour budget was exhausted, and a dispatch decision requests an additional
90 minutes. This is a local checkpoint; no PR has been published and no
post-merge observation has occurred. Do not treat this checkpoint as completed
acceptance evidence. The measured baseline top twenty files are retained in
`/tmp/arsuite-pr-baseline.md` for the eventual PR body; raw local measurements
are `/tmp/arsuite-baseline-summary.json` and
`/tmp/arsuite-final26-v9-times.json`.
