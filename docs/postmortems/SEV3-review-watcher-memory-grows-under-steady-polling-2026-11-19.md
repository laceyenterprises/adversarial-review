# SEV3: Review watcher resident memory grows under steady polling

Ticket: ARWATCHERRSS-01. Severity: SEV3 (resource-leak watch, nothing broken).
Outcome: **(b) no JS-heap growth reproduces. No code change.**

## What was observed

A host leak sampler read one long-running watcher process hourly. Resident
set size rose on three consecutive samples (about 343, 353, 363, then 392 MB;
+9.6, +9.1 and +33.0 MB/h) while file descriptors (131-145) and threads (13)
stayed flat. Three consecutive rises meets the campaign's leak rule, so the
ticket asked for the growing structure to be attributed and bounded only if
it is an unbounded structure. Earlier processes in the same fleet grew
faster (70-115 MB/h) early in life but were each restarted by a deploy before
a third sample.

## Phase 0: method

All measurements are synthetic and in-process. No live watcher was attached to,
signalled or restarted, and no live data was read or written.

- The real `pollOnce` (and the real hammer-scratch sweep ticker) ran from an
  isolated copy of the repository, so its state root was a throwaway tmp
  directory, under a sanitized environment (`env -i`; stub Python, empty stub
  deploy root, empty config, fixture token, `hq` replaced by `/usr/bin/false`).
  An early probe that inherited the ambient environment was discarded; every
  number below comes from the sanitized runs.
- Fixture: one repository (`example-org/demo`) with 30 open PRs. Each PR's head
  rotated every third poll, so new heads arrived at about 10 per poll. A
  synthetic `gh` shim served PR facts, commits and a passing check rollup.
  Reviewer routing stayed in its normal "deferred, no review attempt spent"
  state, so PRs were re-evaluated every poll and no reviewer was spawned.
- The tmp root held 40 aged hammer-scratch directories with matching closer
  dispatch records and 25 pending follow-up job files. The scratch sweep ticked
  every poll (simulated clock advanced 61 s per poll, so it retried every pass)
  against an always-unreadable ledger stub and deferred each time.
- 2,000 polls in one process (about 180 `gh` children per poll). Heap
  statistics were sampled every 100 polls after a forced GC. Separate processes
  of the same fixture wrote V8 heap snapshots at 0, 500 and 1,000 polls, and the
  2,000-poll process wrote its own at the end (a snapshot taken mid-run slowed
  later polls in the same process by two orders of magnitude, so snapshots were
  taken in separate runs). Snapshots were diffed by constructor.

## Phase 0: results

| Polls | RSS MB | heapUsed MB | heapTotal MB | external MB | malloced MB |
|---:|---:|---:|---:|---:|---:|
| 0 | 126.6 | 30.7 | 55.9 | 4.8 | 0.54 |
| 100 | 210.6 | 44.0 | 123.0 | 4.9 | 0.54 |
| 500 | 217.9 | 44.9 | 125.3 | 5.0 | 0.54 |
| 1,000 | 219.8 | 46.0 | 126.9 | 5.0 | 0.54 |
| 1,500 | 223.2 | 46.3 | 128.2 | 4.9 | 0.54 |
| 2,000 | 221.2 | 46.5 | 121.7 | 4.8 | 0.54 |

- Warm-up is the first ~100 polls (lazy module load, compiled code, one-time
  caches): RSS 127 to 211 MB, then it flattens.
- From poll 600 to 2,000 heapUsed stays within 45.9-46.5 MB (slope about
  0.4 KB/poll) and RSS within 219-223 MB (slope about 2 KB/poll, noise from
  `heapTotal` swinging 117-128 MB between GCs). At the production cadence
  (12 polls/h) that is a few tens of KB/h, three orders of magnitude below the
  observed +9-33 MB/h.
- `external`, `arrayBuffers`, native-malloced memory, detached contexts and
  active-resource counts are all flat.
- Heap-snapshot diffs: 0 to 500 polls grows by the warm-up set (compiled code,
  feedback vectors, lazily loaded modules). 500 to 1,000 grows by 1.2 MB, and
  1,000 to 2,000 by 0.15 MB, and in both windows every grown constructor is
  code (bytecode, feedback, trusted byte arrays, weak arrays of newly compiled
  functions). No Object, Map, Set, array or string growth appears. That is the
  signature of rare code paths being compiled for the first time, not of a
  retained data structure.

## Module-level structures read on the poll path

Every module-level Map, Set, array or cache reachable from the watcher was
read for its bound. None is an unbounded per-PR or per-head structure.

- Capped or evicting: PR read memory (LRU on a PR count), owner-route pass
  counters (256), rate-limit credential/binding maps (256 each), budget binding
  parse cache (256), orphan-watchdog terminal-launch cache (1,000), closer-head
  launch-refusal cache and dispatch-directory listing cache (fixed maxima),
  role/config cache (16 LRU slots), final-review latency samples (10,000 and a
  24 h prune), reviewer-pool candidates and refill contexts (cleared or drained
  each poll), the in-process lease and in-flight maps (entries deleted on
  settle).
- Keyed by something finite and self-pruning: the hammer-scratch record index
  holds one entry per dispatch-record file and drops an entry when its file
  disappears; the poll-latency monitor's in-flight child map drains on child
  `close`, which Node emits for failed spawns as well as exits.
- Not in the JS heap: the conditional-request (ETag) response cache is on disk
  and swept by age.
- Unbounded but negligible: the token-identity map in `github-owner-token.mjs`
  gains one short string per distinct token (roughly one per role per hour)
  and never evicts. That is on the order of a hundred bytes per hour, so it
  was left alone: the ticket authorizes a bound only for the structure that is
  attributed to the observed growth.
- Per-poll scratch (poll-scoped caches, telemetry line buffer, histograms) is
  created or reset inside the poll and was flat in the runs above.

## Conclusion

Under 2,000 polls of a 30-PR rotating-head fixture, with the scratch sweep
deferring every pass, the JS heap and the process RSS both plateau after
warm-up. There is no unbounded structure to bound, so this ticket ships no
code and no new test. The production rise is therefore consistent with
runtime allocator behaviour, not a heap leak, but that is an inference from a
synthetic load.

One mechanism that does produce a one-off RSS step without retaining heap: a
transient large string (a 32 MB stand-in for a process-census read, which the
scratch sweep allows up to 32 MB of) took RSS from 41 MB to 131 MB while held
and left it at 123 MB after release and GC, with `heapUsed` back to baseline,
and repeating it did not raise RSS further. This shows that a single burst can
raise a process's resident size permanently without any live reference. It is
a demonstration of the mechanism, not a measured attribution of the +33 MB
step.

## Limits

- The fixture does not drive production-only paths: real reviewer spawns and
  review posting, real dispatch/ledger reads (these ran in their
  "unavailable" state), real closer/hammer launches, and the startup-only
  tickers (stale-state reaper, finding batch, overload rescue, alert drain).
  Growth inside one of those paths would not appear here.
- Polls were run back to back, not on the 5-minute production cadence, so
  anything that grows with wall-clock time rather than poll count (hourly
  token rotation, timers) was not exercised.
- Measurements ran on one Node major (26) on a development host; the sampler
  reads `ps` RSS, which can include allocator and compressed-memory effects the
  in-process numbers do not.

## Follow-up if the rise continues

Capture two V8 heap snapshots from a production-shaped process far enough
apart to span the rise (for example with `--heapsnapshot-signal`, run by an
operator on a non-live replica), then diff them by constructor with the
method above. A rise confined to compiled code or to `heapTotal` with a flat
`heapUsed` confirms allocator behaviour. Growth in Map, Set, array or string
bytes would name the structure to bound. No new CI check, gate or restart job
is proposed.
