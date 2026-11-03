# GHSTATEOWNER-01 (LAC-2157)

The GitHub budget store is private to the uid that wrote it (`0600`), while
the deployed `data/api-cache` directory is group-writable to several owners.
Before this change, `readStateFile` returned `{}` for every read failure. A
caller that could not read the store therefore saw "no observations", and its
next write renamed a `0600` snapshot of only its own observations over the
store. That dropped the owner's unread observations, including active
zero-balance holds, and left the store unreadable to its owner.

Now the shared store belongs to the uid that owns the file (or, before it
exists, its directory). Every other caller uses its own
`<store without .json>.uid-<uid>.json` store, lock and throttle status file,
and never writes the shared store. Reads classify each store as `ok`,
`missing`, `malformed` or `unreadable` (with errno). Only `missing` means no
observations. A writer rejects with `GITHUB_BUDGET_STORE_UNREADABLE` rather
than rename over a store it could not read. A readable shared store still merges
conservatively into a non-owner's admission. Bucket keys, credential digests,
the merge rules, atomic rename and the lock protocol are unchanged.

`readGitHubBudgetStoreStatus` and the `runtime-status` `githubBudgetStore` model
field report the scope and classification. `meteredExecFileSync` uses the same
resolution through `readGitHubBudgetBucketsSync`.

`createRateLimitThrottle` defaults `storeStatImpl` to its injected `statImpl`,
so one stat adapter covers lock inspection and store ownership discovery.
Callers can still override `storeStatImpl` independently.

`test/rate-limit-state-owner.test.mjs` reproduces the defect with a hermetic
two-owner permission adapter (`test/helpers/two-owner-fs.mjs`) and a real
`EACCES` from a `chmod 000` temporary store. See
[`docs/data-model/github-rate-limit-state.md`](../../docs/data-model/github-rate-limit-state.md#store-ownership-ghstateowner-01).
