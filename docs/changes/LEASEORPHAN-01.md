# LEASEORPHAN-01

## Summary

Closer and merge-lane leases share host/PID/process-start liveness. Merge-lane
holders persist optional `holderStartedAt`; legacy records detect reuse when
the observed process was born after acquisition. Observation invokes the
existing fenced stale reclaim, with the existing history event. Closer
pre-receipt recovery continues to scan submitters before the exact-key lookup:
adopt the uniquely matching receipt or release only proven absent submission.

Each watcher pass observes dead holders through the existing reclaimers; the
age/pruning sweep retains its ordinary interval.

Terminal scratch cleanup waits for closure custody to settle. A confirmed
merged PR's ended controller releases its merge-lane and closer leases and
records its success audit before cleanup, without another dispatch or decision.
Closer admission uses the existing deferred-provision mechanism.

After both companion PRs deploy and normal submodule float, SRE restarts watcher
and follow-up and verifies PID start times. Observe natural traffic for 24 hours:
no rescue `lease-left` with a dead submitter, no dead same-host unlaunched lease
surviving a watcher pass, and no merged-PR closeout decision. The operator plan
is in Agent OS at `modules/worker-pool/post-merge-actions/LEASEORPHAN-01.yaml`.
All fixtures use synthetic identities; no live mutation or new CI gate is added.

## Interface changes

Merge-lane holder JSON adds optional `holderStartedAt`; legacy records remain
readable. The existing lease APIs preserve their generation fences. Dead local
holders are reclaimed when inspected; unknown local identity retains custody.

## Verification

Each file ran separately through `cwp_dispatch.worker_validation` with a
600-second bound, the required netguard PATH/log and Python runtime, using
`node --import ./test/helpers/load-aware-timeout-fixture.mjs --test <file>`:

- `test/leaseorphan-01.test.mjs`: 10 passed.
- `test/ama-merge-lease.test.mjs`: 78 passed.
- `test/ama-pre-receipt-intent.test.mjs`: 193 passed.
- `test/ama-closer-dispatch-priority.test.mjs`: 327 passed.
- `test/ama-closer-lease.test.mjs`: 41 passed.
- `test/ama-dispatch-submitter.test.mjs`: 14 passed.
- `test/hammer-scratch.test.mjs`: 80 passed.
- `test/recovery-reaper.test.mjs`: 109 passed.
- `test/smv.test.mjs`: 11 passed, including disposable sandbox smoke.

Targeted ESLint and `tsc -p tsconfig.contracts.json` passed. These fixtures
exercise interrupted state deterministically; they do not measure a production
race rate or claim the SRE observation window is complete.
