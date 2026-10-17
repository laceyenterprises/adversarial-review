# WATCHERLAG-01: admission latency

Operator report: "PRs are going hours without a first review" (2026-10-17 03:3x UTC).

The reproduced shared blocker is synchronous ledger subprocess work on the
watcher's main event loop. Builder-provenance routing called a synchronous
reader with three 30-second psql attempts and synchronous retry sleeps. Closure,
worker identity, pack liveness and duplicate-family census paths also called
synchronous ledger readers, including inside functions declared async. Awaiting
such a function does not make its synchronous child asynchronous. Timers,
capacity-freed callbacks and independent preflight completions all wait together.
The GitHub budget is not needed to reproduce this failure.

Run `node demo/watcher-admission-latency.mjs` for an offline comparison. It uses
synthetic psql executors, each running a 120ms fake child, and the actual
three-attempt provenance reader. One measured run completed all four independent
preflight steps at 991ms with the legacy reader, versus 8ms with async reads;
event-loop p99 was 995ms versus 23ms. Child startup adds to the nominal sleep.
This is a scaled reproduction of the blocking mechanism, not a measurement of
the reference host's individual 100–160 second stalls. Deployment telemetry is
needed to attribute the remaining live time to spawn readiness versus child work.

Watcher ledger readers now share the synchronous readers' SQL and validation
through the same generator steps, but await execFile completion and retry timers.
Synchronous CLI consumers retain their API. Closure lease reconciliation shares
the same decision code in both modes and rechecks ownership after external reads.
The census copies discovery entries before its first provenance await, then
prefetches evidence asynchronously once per PR/head and passes that same head
snapshot into its synchronous classifiers. A pinned miss also prefetches the
head-independent fallback; successful pinned reads need no fallback. Content
verification rejects a moved live head without rewriting the discovery head.
Missing snapshot evidence aborts the tick through the census error boundary,
preserving existing families and holds. Fixture callers may inject
`spawnAsyncImpl`; an explicitly supplied `spawnSyncImpl` is awaited when no
async executor is supplied. An async executor takes precedence when both are
supplied. The steps' built-in synchronous default is never selected by async
readers; production retains the asynchronous child default.
Async closure also uses async gh/hq
probes. Existing process-lifetime admission, durable refill, credential limits,
holds, drafts, head dedup and spawn-boundary freshness checks remain in force.
No config keys or CI gates are added.

A drain shares identical read-only check-rollup requests for up to ten seconds,
with separate executor and credential identities. Errors are evicted. PR state,
labels, review dedup, requests with cancellation signals, and mutations always
bypass that cache. Each new drain starts a fresh cache. Existing poll-scoped
quota and HCP probes are reused.

Each poll emits `poll latency summary` with event-loop p50/p99 milliseconds and
per-command child counts, spawn-readiness p50/p99 and child wall p50/p99 for gh,
git, hq and psql. Spawn readiness includes native spawn time and the wait until
Node delivers the spawn event. Wall time ends at close, including stdio drain;
it is not pure subprocess CPU time. Counts distinguish starts and completions,
so a child spanning polls completes in a later summary. Synchronous CLI probes
have wall samples only. No argv, environment, credentials or full binary paths
are emitted. Existing `idle_ms` handoff logs remain.

The regression harness runs concurrent posted handlers with 180 seconds of fake
child latency and observes capacity-freed admission at 0ms idle. A real slow fake
psql child also leaves independent preflight steps free to complete. Mutation
checks restore synchronous ledger execution and omit the poll summary; all
three required regressions fail under those mutations. Additional tests cover
sync/async query parity, bounded yielding retries, cache isolation and a lease
owner changing while async closure evidence is pending.

After merge, the SRE session:

1. Confirms the watcher restarted after deployment.
2. Under host load above 60, confirms `idle_ms` stays below 60 seconds and no
   first-pass PR waits over 15 minutes while a seat is free.
3. Confirms per-poll event-loop p99 remains below one second.
