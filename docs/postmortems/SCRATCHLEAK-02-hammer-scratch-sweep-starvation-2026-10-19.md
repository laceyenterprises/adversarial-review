# SCRATCHLEAK-02 — hammer scratch sweep starvation across passes

Incident date: 2026-10-19. Status: repair prepared; deployment and independent
reclamation verification pending. Evidence below was supplied with the incident.
Tests use synthetic directories and ledger/process readers. The repair worker
did not inspect or delete production scratch.

## Reported evidence and impact

After PR 1389 (SCRATCHLEAK-01) was deployed, the watcher restarted onto the new
code. The new `probe-timeout` summary key confirmed that the repair was live.
Successive passes still emitted the same summary and pause:

```json
{"event":"ama_closer.scratch_sweep_summary","kept":{"live-owner":0,"non-terminal":0,"process-references-path":0,"process-references-id":0,"too-young":2,"probe-timeout":0},"removed":0,"remainingCandidates":128,"deferredCandidates":0,"completed":false}
{"event":"ama_closer.scratch_sweep_paused","reason":"scan-budget","removed":0,"remainingCandidates":128}
```

The backlog rose through 124, 126, 128 and 129 directories to approximately
131 `hammer-scratch-*` trees, using about 13 GB. The oldest were several days
old; the count grew hourly. Reported load averages were 50–140 during passes.

## Cause

The sweep checkpointed its dispatch-record index but no candidate position.
Each pass restarted at entry zero in filesystem listing order. The first few
entries were young and retained. Under load, owner ledger reads consumed most
of the 10-second scan budget; the pass then stopped before reaching old terminal
trees later in the listing. Repeating a pass repeated the same prefix forever.

Process-census elapsed time was already added back to the scan deadline.
Launch/retry and worker ledger reads instead used that deadline as their own
timeout and consumed it. Thus the delay of one status lookup could determine
the entire pass's reach.

## Why SCRATCHLEAK-01 acceptance failed

SCRATCHLEAK-01 addressed cwd-probe timeout recovery, terminal-tree sizing and
pytest retention. Its offline tests demonstrated that individual eligible
directories could be reclaimed and live owners stayed protected. They did not
demonstrate eventual reclamation across repeated budget-limited passes with
young entries first and slow ledger reads. The existing 100-candidate test
proved only that one pass made partial progress; it never asserted that later
passes reached the rest.

The earlier report left host reclamation verification pending. Deployment and
the new log key established code currency, but could not establish the promised
backlog reduction. The repeated zero-removal summaries show that the behavioral
acceptance failed despite the targeted earlier repairs being live.

## Fix and regression evidence

Candidates now sort oldest first by directory mtime, then name. An atomic,
independent cursor persists the last examined ordering key and resumes after it,
wrapping at the end. Kept candidates advance too; a full lap that removes
nothing preserves its position. The checkpoint survives module/process restarts
and still works when the last examined directory has disappeared.

Launch/retry and worker ledger probes each receive a separate 10-second timeout;
their elapsed time is added back to the scan deadline. Timeout retains that
candidate and advances past it. Async probes receive cancellation; late
synchronous results cannot authorize removal. Terminal ownership, absence of
live workers and held leases, process path/ID checks, source-record checks and
the final stat identity recheck remain required. Scan budget, cadence and
removal cap are unchanged. No configuration key, gate or override is added.

Synthetic regression coverage drains 100 aged terminal trees in 34 passes with
a scan budget covering three removals per pass, restarting the sweep instance
each time. Other tests cover slow successful launch/worker reads, timeout
deferral and resumption, asynchronous cancellation, kept/live cursor progress,
zero-removal laps, and the existing nonterminal, lease, retry and identity-race
protections. Checkpoint shape and operational semantics are documented in the
scratch sweep data model and AMA closure runbook.

## Deployment acceptance still required

After normal deployment, confirm the watcher restarted and observe a summary
with `removed > 0` within two passes. Within about a day, the directory count
should fall from more than 120 to a handful of young/live trees and roughly
13 GB should be reclaimed. Check summaries for continued progress and safely
retained live trees. No manual production deletion is part of this repair;
these host outcomes remain unverified by the worker.
