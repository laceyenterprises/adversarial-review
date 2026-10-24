# LAC-2098: canceled CLI waiter outlived its acquiring process

At 2026-10-24 03:52 UTC the shared `agent-os::main` merge lane had no
holder, but the canceled acquisition for #9082 remained first in FIFO and blocked
ready #9086. Acquiring CLI PID1189 was gone. Its caller shell PID84379 was still
alive inside the active closer, repairing a new CI failure. That shell's lifetime
did not establish an active acquisition. The operator removed only the exact
waiter through `removeMergeLeaseWaiter`; the source worker continued and later
merged normally. No holder was preempted or service restarted.

## Evidence and prior incident

The issue and its operator follow-up distinguish cancellation from a slow
acquire: #9082's progress log explicitly reported canceling its queued acquire
and holding no lease before continuing repair. Its abandoned request was
`cli_1189_1792813709282_9082`, head
`c42fbe1f5570a8bd9435719bc7d3414142c827fb`, arrival
`03:48:29.386Z`, last update `03:51:25.516Z`, attempt 535,
`holderPid: 84379`, `deadlineSeconds: 124558`.

Read-only historical artifacts under
`/private/tmp/os-open-pr-audit-20261024-034541/`:

- `core-lease-current.json` is the earlier 03:50:52 snapshot: #9078 still holds
  the lane and #9082 precedes #9086. It is not the later empty-holder snapshot.
- `9082-waiter-process-proof.txt` records the surviving parent shell. The issue
  records the fresh absence of acquisition PID1189 and the later empty holder.
- `9082-abandoned-cli-waiter-cleanup.json` records the exact request and canonical
  removal reason. No other waiter or holder was removed.
- Issue follow-ups record #9082's subsequent normal merge at 03:59:22 UTC and
  #9086's eventual progress. Mitigation did not establish a source fix.

LAC-2087 / PR #1474 fixed daemon reservations abandoned before a subsequent
acquire. Its candidate-scope cleanup was already deployed. Daemon reservations
belong to a PR/head and deliberately ignore watcher PID death; they retain that
contract here. The same lesson applies to CLI requests: a long-lived owner's
liveness cannot stand in for the lifetime of a particular acquisition.

HCP memory searches for dead acquisitions, live parents, PID reuse and cleanup
returned available with no matching records. Linear shared field-note lookup
was unavailable (`Tool not found`); local runbooks and LAC-2087 were inspected.

## Root cause and correction

`bin/merge-lease.mjs` registered the caller's `--owner-pid` as `holderPid` on the
waiter. `waiterProcessDead` probed that parent instead of the acquiring CLI.
Cancellation therefore left a durable FIFO request alive for the load-scaled
deadline. The CLI removed its waiter only on timeout, lacked signal/finally
cleanup, and could adopt a previous request solely by parent, PR and head.

The compatible optional `acquisitionPid` identifies the CLI on `holderHost`.
Every invocation gets a fresh UUID-based waiter ID; refreshes within that
invocation retain its original FIFO arrival. New invocations cannot inherit or
clean up another live request. Legacy rows without explicit acquisition
metadata retain the existing parent-PID/deadline rules. In
particular, an old CLI could adopt a previous invocation's encoded waiter ID;
PID absence inferred from that ID is therefore uncertain evidence. A dedicated
regression proves such an adopted request is preserved with a live parent.

Early pruning requires confirmed same-host PID absence. Live and reused PIDs
are intentionally preserved, without start-time mismatch reclamation. Unknown,
throwing or permission-denied probes, malformed identities and foreign/missing
hosts cannot authorize early pruning. Existing arrival deadlines still bound
these reservations. The resulting holder continues to belong to the caller,
with all existing lease-ID/head/acquired-at fences intact.

CLI poll sleeps now yield to signal handlers. SIGINT/SIGTERM/SIGHUP return
retryable exit 75, identify the signal and refund the provisional gate attempt.
Timeouts and runtime exceptions also enter `finally`; cleanup removes only the
invocation's exact ID through the canonical API, with an optional
`expectedAcquisition` PID/host fence rechecked under the mutation lock. If an
older CLI adopted that ID and removed or changed its metadata, cleanup preserves
that uncertain owner. It retries mutation contention
at most three times with two 250ms sleeps and warns if cleanup cannot complete.
Dead-acquirer pruning recovers SIGKILL or failed cleanup on the next contender.
Successful acquisition already removes its waiter while holding the existing
per-base lock. Recovery that returns a matching pre-existing holder still cleans
up its own unserved request, without releasing that holder. No alternate lease release, lock or merge path is introduced.

The registration, selection/pruning, served-request removal and release-wake
paths were inspected together. They retain the shared mutation lock; holder
reclaim/release still re-read the holder identity before mutation. There is no
new concurrency race required to explain this incident: the lifecycle failure
reproduces sequentially after cancellation. Repeated fixture-child interruption
runs supplement that deterministic reproduction; one pass is not race proof.

## Offline validation

Against starting commit `ad6019ff`, the dead-CLI/live-parent fixture with
explicit acquisition metadata failed deterministically: expected acquisition `true`, received `false`, with
no holder. The focused lease/CLI/history/revalidation/SMV run includes the
canonical disposable smoke. Final counts are recorded below. Coverage includes:

- Dead CLI/live parent with no holder and following contender progress.
- Explicit live/reused/unknown/malformed/foreign ownership retention and
  uncertain legacy adoption preservation, plus existing expiry and daemon priority.
- An unchanged live holder, stale-release rejection and subsequent FIFO service.
- Distinct same-parent/PR/head requests, timeout and exception cleanup, signal
  handler removal, transient and exhausted cleanup contention, and preservation
  after legacy adoption or PID/host rebinding before cleanup.
- Real signals to disposable fixture children: SIGINT, SIGTERM and SIGHUP cleanup;
  SIGKILL recovery after the child exits, with the parent and holder preserved.

An exploratory 20-run batch had 19 passes and one failure: the busy-lock
fixture used wall time, so under load its lock legitimately expired before the
last cleanup retry. Cleanup succeeded and the fixture's expected warning was
absent. The fixture now follows the existing future-timestamp pattern, keeping
that synthetic lock deterministically busy. This was not evidence of a holder
fence race; the exploratory batch is not reported as green. Intermediate
validation batches were superseded when compatibility and matching-holder
cleanup coverage changed. Final gate results follow below; repeated-run receipts are recorded with the
PR and Linear publication evidence.

The final focused command passed **134/134**:

```bash
node test/run-tests.mjs cli-waiter-lifecycle.test.mjs ama-merge-lease-cli.test.mjs ama-merge-lease.test.mjs merge-lease-history.test.mjs ama-merge-lease-revalidation.test.mjs
```

The required `npm test` attempt hit the runner's 900-second deadline and the
930-second outer bound (exit 124): **8,808 passed, 4 failed, 245 canceled,
4 skipped**. All four failures were in unchanged `derived-artifacts.test.mjs`
(rebuild collector/predicate, lifecycle-hook suppression, tracked HOME/TMPDIR,
and descendant cancellation). This is not a green full-suite result. The final
lease behavior is established by the focused run, with separate SMV and repeated
results below. An earlier combined targeted/SMV run hit the existing smoke time
budget under full-suite contention; the isolated smoke rerun is authoritative
for its final result. No unrelated packaging repair or gate bypass was added.

The isolated `node test/run-tests.mjs smv.test.mjs` rerun passed **11/11**,
including the canonical disposable sandbox smoke. Lint reports zero errors
(148 existing warnings); contract typechecking and the byte-equivalence
walkthrough pass.
All fixtures own temporary stores and child processes. No production
queue/lease probes, service restarts, worker cancellations, deployment edits,
rescue PR changes or optional Agent OS checkout were used.

## Deployment acceptance

Normal review, CI and merge are required. Source publication does not establish
deployment or runtime acceptance. After normal rollout, the runtime owner should
record an organic canceled acquisition's exact waiter disappearance and the next
live contender's progress, together with unchanged holder fencing. An empty lane
alone is insufficient evidence. Do not force a cancellation, restart, production
probe or queue mutation to manufacture acceptance. No configuration or migration
is needed. Legacy rows with live parents may remain until their existing
cleanup/deadline; new CLIs always record explicit acquisition identity.
