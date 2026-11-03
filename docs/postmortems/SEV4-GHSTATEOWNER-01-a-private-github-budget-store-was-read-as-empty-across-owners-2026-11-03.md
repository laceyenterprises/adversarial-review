# SEV4 GHSTATEOWNER-01: a private GitHub budget store was read as empty across owners

Ticket: LAC-2157 (root rescue LAC-2132; open follow-up agent-os #10185).
Date: 2026-11-03. Severity: SEV4, qualified. This is a cross-owner
coordination defect. No new outage, admission failure or token compromise has
been proven.
Status: source qualification only. Cross-model review, exact-head CI, merge,
normal deployment and live acceptance remain separate gates. They belong to
LAC-2132.

## What was observed

The following metadata was read at 2026-11-03 12:02Z. No file contents or
credentials were read.

- The deployed `tools/adversarial-review/data/api-cache` directory is owned by
  the HQ owner account with group `staff`, mode `0775`.
- `rate-limit-state.json` in that directory has the same owner and group,
  mode `0600`.
- A metadata-only open by a second operating-system account failed with
  `PermissionError` errno 13 (`EACCES`).

No deployed file mode, owner, state, lock or lease was changed.

## Root cause

`src/rate-limit-throttle.mjs` assumed every caller of the shared store owns it:

1. **Reads.** `readStateFile` caught every failure and returned `{}`. `EACCES`
   was indistinguishable from "no observations yet". `readGitHubBudgetStatus`
   and the synchronous `meteredExecFileSync` preflight in `src/metered-gh.mjs`
   repeated the same catch-all.
2. **Writes.** `recordRateLimit` read the store under its lock, merged the
   incoming observation and called `writeStateFile`. That function opens
   `<store>.tmp` with `0600` and renames it over the store. Under a
   group-writable directory, a caller that cannot read the file can still
   create the temporary file and rename it. Its "merge" started from `{}`. The
   rename therefore discarded every observation it had not read, including
   active zero-balance holds, and left a `0600` file that the original owner
   could not read.
3. **Siblings.** The lock directory and `<store>.throttled.json` sat beside the
   same shared path. A non-owner took the owner's lock. Its throttle status
   write failed with `EACCES` against an owner's file, and its clear could
   unlink the owner's file in the group-writable directory.

Bucket keys and token digests were correct (LAC-2075, WATCHERANONBUCKET-01).
Only the file-ownership boundary was wrong.

## Reproduction

`test/rate-limit-state-owner.test.mjs` uses a hermetic two-owner permission
adapter (`test/helpers/two-owner-fs.mjs`). One real temporary directory is
modelled as group-writable to fixture uids 7001 and 7002. A `0600` file
created by one uid refuses the other with `EACCES`, while rename and unlink
succeed for both. No chmod, chown, sudo or second account is used. A separate
test makes a temporary store `chmod 000` to obtain a real kernel `EACCES`
(skipped as root).

The new file was run against an archive of the unfixed `origin/main` (base
`d1b430c6`) with only the new test and helper copied in. All 9 tests failed.
Three failed on behaviour alone:

- *The peer renames over the shared store:* `peer renamed its private snapshot
  over the shared store`.
- *Deterministic schedules (owner→peer, peer→owner):* `{ lostHolds: 1,
  blindPeers: 1, falseSharedWrites: 1 }` against an expected all-zero.
- *The directory owner and a legacy foreign file:* the owner renamed over a
  foreign store it could not read.

The other six depend on interfaces added by the fix.

A scratch driver used only seams present on the base. It repeated both
schedules 50 times (100 runs):

| | lost owner holds | blind peer reads | shared store taken by a non-owner | real `EACCES` record |
|---|---|---|---|---|
| unfixed | 50/100 | 50/100 | 50/100 | succeeded, unreadable store replaced |
| fixed | 0/100 | 0/100 | 0/100 | refused `GITHUB_BUDGET_STORE_UNREADABLE`, store unchanged |

These are deterministic schedule counts. Each ordering produces one outcome,
so 50/100 means "always, in the owner→peer order" (or peer→owner for blind
reads). They are not a production failure rate. No production rate was
measured, and no production occurrence of a lost hold is proven.

## Fix

- The shared store belongs to the uid that owns the file or, before it exists,
  its directory. Every other caller uses
  `<store without .json>.uid-<uid>.json`, with its own `.lock` and
  `.throttled.json`, and never writes the shared store. Ownership that cannot
  be proven is treated as foreign. File modes are unchanged; nothing is opened
  to wider access.
- Reads classify `ok`, `missing`, `malformed` or `unreadable` (with errno).
  Only `missing` means no observations. A non-owner merges a readable shared
  store conservatively and reports an unreadable one.
- A writer never renames over a store it could not read. It rejects with
  `GITHUB_BUDGET_STORE_UNREADABLE`. A malformed own store is still healed.
- `readGitHubBudgetStatus`, `readGitHubBudgetBucketsSync` (the sync
  preflight), `readGitHubBudgetStoreStatus` and the `runtime-status`
  `githubBudgetStore` field share the resolution. The rendered status adds a
  `GitHub budget store:` line when the scope is `owner` or a store is
  unreadable or malformed.

Retained without change: LAC-2075 credential isolation, the
WATCHERANONBUCKET-01 observed-limit floor, secret-free bucket digests, the
conservative merge rules, the atomic temporary-file rename and the lock
protocol. Anonymous requests are not assumed forbidden. A tokenless caller is
still the `default` bucket, and the uid attributes a store, never a
credential.

## Sibling sweep

- **Fixed:** the async throttle read/write, the lock and throttle status
  files, `readGitHubBudgetStatus`, and the `meteredExecFileSync` preflight.
- **Unchanged, by design:**
  - The `etags` and `diffs` caches. A failed read is a cache miss and the
    request refetches, so there is no cross-owner coordination state to lose.
  - The `api-call-log` telemetry. It is append-only and its write failures are
    already non-fatal.
  - `readLockOwner`. With owner-scoped stores, it only reads the caller's own
    lock.

## Trade-off and remaining live proof

Owners no longer share observations through a store they cannot read. A
non-owner learns its budget from its own GitHub responses. Before the fix,
the same non-owner saw nothing and erased the owner's evidence. Restoring
genuine cross-owner sharing would require a deliberate readable store or a
supported owner transport. That is a separate operator decision, not part of
this ticket. A foreign file already at the shared path is left in place and
reported. Removing it is an operator action.

Live proof after normal deployment (LAC-2132): run as the HQ owner, confirm
`runtime-status` shows no `GitHub budget store:` line (or `scope=shared`).
From a second-owner process, confirm an owner-scoped
`rate-limit-state.uid-<uid>.json` appears. Confirm that the shared store's
owner and mode are unchanged. Source tests alone do not close this incident.
