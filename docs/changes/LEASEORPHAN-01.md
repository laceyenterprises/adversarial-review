# LEASEORPHAN-01

## Summary

Closer and merge-lane leases share host/PID/process-start liveness. Merge-lane
holders persist optional `holderStartedAt`; legacy records detect reuse when
the observed process was born after acquisition. Observation invokes the
existing fenced stale reclaim, with the existing history event. Closer
pre-receipt recovery continues to scan submitters before the exact-key lookup:
adopt the uniquely matching receipt or release only proven absent submission.

Each watcher pass observes merge-lane holders and a bounded closer batch through
the existing reclaimers; the age/pruning sweep retains its ordinary interval.
Closer observation selects 250 entries and reads 50 records by default, retaining
an independent durable cursor across ticks and restarts. Directory-name
enumeration remains complete, with bounded page memory.

Terminal scratch cleanup waits for closure custody to settle. A confirmed
merged PR's ended controller releases its merge-lane and closer leases and
records its success audit before cleanup, without another dispatch or decision.
Closer admission uses the existing deferred-provision mechanism.

After both companion PRs deploy and normal submodule float, SRE restarts watcher
and follow-up and verifies PID start times. Observe natural traffic for 24 hours:
no rescue `lease-left` with a dead submitter, no dead same-host unlaunched lease
surviving a complete holder-observation rotation, and no merged-PR closeout
decision. The operator plan
is in Agent OS at `modules/worker-pool/post-merge-actions/LEASEORPHAN-01.yaml`.
All fixtures use synthetic identities; no live mutation or new CI gate is added.

## Interface changes

Merge-lane holder JSON adds optional `holderStartedAt`; legacy records remain
readable. The existing lease APIs preserve their generation fences. Dead local
holders are reclaimed by acquisition and reaper observation; inspection reports
liveness without mutation. Unknown local identity retains custody.
Final remediation adds `data/recovery-reaper/closer-holder-cursor.json` using the
existing version-2 cursor shape. Ordinary success retains its worker audit
reason, with `terminal-merge-reconciliation` for missing success audits;
`confirmed-merged-closeout` is reserved for parked-controller merge discovery.
Bulk merged-PR lane release accepts an omitted repo using each discovered holder.

The dispatched-holder finding is already prevented by the pending/no-LRQ guard.
Inspection now remains read-only. Although the existing per-base mutation lock
already serialized deletion/history, inspection side effects broke controller
release receipts by removing their holder before the explicit release. CI also
exposed merged terminal cancellation writing its dispatch record before lease
settlement; it now releases lane and closer custody before scratch cleanup.
Expiry fixtures use foreign hosts for age-only expiry, preserving local
unknown-identity custody. The history progress fixture injects its diff timeout
after the first persisted comparison instead of racing a 100ms wall deadline.

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

Final comment-only remediation validation ran through `bin/run-bounded.sh`:

- `node test/run-tests.mjs test/leaseorphan-01.test.mjs` and the affected
  terminal-cancel, ownership, mutual-exclusion, operational-waits and history
  progress suites passed. The final terminal-cancel run passed 20 tests.
- `node test/run-tests.mjs test/ama-merge-lease.test.mjs test/merge-lease-history.test.mjs test/smv.test.mjs`
  passed 93 tests, including disposable sandbox smoke.
- `node test/run-tests.mjs test/finalclose-01.test.mjs` passed 77 tests.
- With `NODE_OPTIONS=--test-name-pattern=CLOSERLEASE|MERGESIGNAL|terminal.success`,
  the dispatch-priority suite passed 68 selected reconciliation tests.
  The earlier unfiltered attempt exceeded its 180-second bound; it was replaced
  with this focused selection, without increasing any CI budget.
- With `NODE_OPTIONS=--test-name-pattern=normal.script|ownership.stops|lost.process.census|cancellation.drains|validator.timeout|two.successful.validators|real.census`,
  the controller suite passed all 14 previously failing lease-cleanup cases.
- The recovery-reaper and closer-lease suites passed alongside the initial
  merge-lease/history run.
- The claim-loop selection for happy-path claim, duplicate suppression,
  moved-head and CAS/cascade recovery passed 11 tests. An initial unfiltered
  watcher-claim-loop run reached its 90-second bound with 49 passes and no
  assertion failures; the remaining full-file coverage stays with CI.
- `npm run lint` passed with zero errors (149 existing warnings); targeted
  ESLint on the four changed source files passed without warnings.
  `npm run typecheck:contracts`, `node scripts/validate-data-model-catalog.mjs`
  (93 entries), `bash demo/research-finding-walkthrough.sh`, and
  `git diff --check` passed.

The full suite is delegated to PR-head CI. Deployment and natural-traffic SRE
acceptance remain separate from these offline source checks.
