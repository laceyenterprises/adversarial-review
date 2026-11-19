# SEV3 review watcher resident memory growth

ARWATCHERRSS-02 follows an investigation that found no sustained JavaScript heap
growth. Resident memory grew across samples after a watcher restart. The
allocator summary pointed to native malloc. This report uses synthetic data
for all measurements. The full rate of growth in service remains unattributed.

## Phase 0 reproduction

The repo test runner isolated the real `pollOnce` in a fixture workspace with
an empty repository listing and a fresh SQLite file. The synthetic worker
registry callback emitted a child start and close for each of the five measured
command names during each of 180 polls. The harness sampled `rss`, `heapUsed`,
`external` and `arrayBuffers` every pass and counted calls to
`perf_hooks.createHistogram`. The control used the same poll loop and database
setup with child events omitted. Neither fixture launched reviewers.

Before the change, the child fixture allocated ten histograms per pass and
reached 1,800 allocations. RSS at pass 180 was 293.5 MiB with child events
and 233.6 MiB in the control. Heap usage varied with GC timing in both runs,
so the RSS difference alone cannot attribute the growth.

A separate 1,500-pass replay isolated the latency monitor. Both runs delivered
the same child events and produced summaries. The replay compared the original
factory with a test factory that reset and reused the same ten native
histograms. Memory figures below are MiB after two explicit GCs at the end.

| Histogram factory | Allocations | RSS | heapUsed | external | arrayBuffers |
|---|---:|---:|---:|---:|---:|
| Fresh histograms each pass | 15,000 | 99.3 | 4.26 | 2.11 | 0.19 |
| Reuse histograms | 10 | 54.7 | 4.27 | 2.11 | 0.19 |

`createWatcherLatencyMonitor` created two native histograms on the first
event for each command in a pass, then discarded the bucket after emitting
the summary. Reusing the native storage removed 44.6 MiB of RSS in the
isolated replay. Node's `external` already includes `arrayBuffers`. Both
counters missed the RSS difference from recreating the histograms.

## Other candidate sites

Short probes exercised the SQLite write canary's per-call statements, the
child capture helper with 128 KiB on each stream, reads and writes of
synthetic ETag bodies, and repeated reads of a 1 MiB file. Each probe ran 90
iterations. After GC, `external` and `arrayBuffers` were flat within each
probe. Several probes still raised RSS. The probes exercised individual
operations and leave service-only retention paths unresolved.

The CLI reviewer adapter deletes its run entry on settlement and the latency
monitor drops its child reference on close. The ETag cache stores bounded
bodies on disk. The synthetic real-poll control still exercised the SQLite
canary without the repeated native histogram allocations.

## Fix and verification

The monitor retains one pair of histograms per measured command and resets
each pair after summarizing the poll. A command with no samples or outstanding
children stays absent from the summary. `NODE_DEBUG=adversarial-watcher-memory`
enables one memory sample in bytes at the end of each settled `pollOnce`,
including failures. The default path skips sampling.

The regression test runs 180 real polls through the isolated fixture, verifies
the histogram allocation count stays at ten and bounds the post-warmup spread
of `external + arrayBuffers` to 16 MiB. A debug run emitted 180 lines and
measured a 1.32 MiB spread across passes 31 through 180. RSS at pass 180
was 206.2 MiB. The test records RSS for diagnosis because allocator behavior
and GC timing affect it. Confirmation at the service's cadence and workload
remains open.
