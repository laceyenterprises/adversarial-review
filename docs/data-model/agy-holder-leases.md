# agy execution holder leases

**Source of truth:** `src/agy-reviewer-identities.mjs`, using `src/agy-holder-leases.mjs`.
Store: `<resolved adversarial review state directory>/agy-holder-leases/<user>.json`
and a persistent `<user>.lock` inode. The existing state-directory resolver
and override apply. Files are mode 0600; the directory is created mode 0700.

The version-1 record contains `version`, `user`, `lease` (nullable), and `auth`
(nullable). A lease records `identity: gemini-reviewer`, `tokenAccountId`,
`user`, `hqOwner`, `reviewId`, `generation` (unique lease fence),
`evidenceGeneration` (validated holder/model declaration fingerprint), and
`ownerPid`, and `selectionReason` (`preferred-ready` or `fallback-ready`). These are metadata, never OAuth material or signing authority.

The account ID comes from the ITP-10 declaration when present. Legacy login
lists import a stable opaque `agy-<sha256-prefix>` ID per username. Locking and
cooldown remain keyed by the credential holder, so renaming an account does
not grant another slot. Duplicate declared holder aliases fail validation;
legacy duplicate usernames count once. Concurrency remains one per holder.

An exclusive nonblocking flock serializes read/modify/atomic-write operations.
Acquisition persists the claim before spawn. Release compares the unique lease
generation; a stale release cannot clear a replacement. The local receipt remains
populated and release is fenced in memory through cleanup and durable persistence,
so an overlapping readiness pass recognizes the watcher's own claim. Failed added-user workspace
cleanup, surviving processes, unknown process evidence, and busy release writes
retain the durable claim and retry on readiness, while admission stays held.
Failed-review auth requirements are persisted even while release is pending.
After owner exit, reclaim reconstructs workspace cleanup from the durable
lease's `reviewId` and must complete cleanup and process draining under the lock.
Lock files
are never unlinked. Unreadable or malformed records isolate only that holder.

There is no heartbeat-expiry reclaim. A live watcher PID retains ownership;
after its exit, strict reviewer-run scans and the existing survivor check must
prove the holder unused under the lock. Live process groups in terminal as
well as active holder run records retain occupancy. Only `launching` records
hold without a PGID; terminal records without one cannot represent a live group.
Terminal live PGIDs are checked against `spawnedAt`: a proven start-time mismatch
does not hold occupancy, while unavailable identity evidence retains the hold.
Unknown evidence holds.
The runtime still writes its launch intent before forking, and rolling readers
retain both `agyHolderLease` and `agyIdentityLease` run-record fields.

Failed reviews require an authenticated probe before reuse. `auth` records
`needsProbe: true`, `failures` and `retryAt` in local epoch milliseconds. The
first recovery probe may run immediately; failures back off 1, 2, 4, 8, then
15 minutes, with a 15-minute cap. The holder lock spans the bounded probe,
preventing concurrent watcher probes. Restart preserves backoff. A successful
probe clears `auth`; quota cooldown remains in its existing separate store.

This adds no session-ledger schema or migration. Rollback requires stopping
new admissions and draining/adopting running reviews before restoring an older
binary. Do not delete claims or cooldowns to manufacture capacity.

## Offline acceptance evidence (2026-10-21)

`test/agy-token-holders.test.mjs` replays against parent
`fad3947fbaf80941ed5a66acbb404fb986047800`: all 11 outcome tests fail.
The deterministic two-watcher contention fixture overbooks the capacity-one
holder in 25/25 parent trials (100%); it uses independent pools sharing a
temporary store, with no provider, Keychain or production ledger access.

The initial durable-claim fix produced 0/25 overbookings. Each intermediate
release/recovery/model-generation fix retained 0/25 in its focused run. The
final implementation passed five repeated 11-test runs: 55/55 outcomes and
0/125 overbookings. These are bounded deterministic replay counts, not a
production failure-rate estimate. The compatibility fixtures additionally run
two synthetic agy processes in separate private homes, returning the same
Gemini review actor, and the sandbox smoke refuses a third holder lease.

There is no session-ledger edit, so SQLite/Postgres migration coverage is
unchanged. Live credential readiness, model-vocabulary reconciliation and host
rollout remain operator cutover evidence under ITP-19.
