# CAPREHEAD dispatch reservations

Owner: `src/ama/cap-rehead.mjs`. Store:
`data/follow-up-jobs/cap-rehead/<sha256([lowercase repo, PR])>.json`.
The adjacent `.lock` uses an exclusive OS advisory lock for the whole
read/check/reserve/dispatch/update transaction. Process death releases the lock.

Schema version 1 contains `repo`, `prNumber` and append-only `attempts`.
`repo` must be a string matching the caller's repository case-insensitively,
consistent with the lowercase path key. Stored spelling is preserved; casing
changes cannot reset head reservations or lifetime charges.
Each attempt has `headSha`, `workerClass`, `recordedAt` and `status`:
`reserved` precedes the external dispatch, `dispatched` adds `launchRequestId`,
and `unacknowledged` retains a failed/refused/unknown command outcome, preserving
its launch ID when a refused receipt supplies one.
Atomic writes fsync the file and attempt a directory fsync before dispatch. Malformed records
fail closed. There is no automatic deletion, expiry, reset or head refund.

Every attempt counts toward the configured PR lifetime cap, including failed
calls. A prior head remains attempted forever. Previous acknowledged launches
must have terminal launch/retry evidence before another head can dispatch;
Attempts without a launch ID retain uncertain custody indefinitely.
No receipt is evidence of a merge or review approval. `hq` receives a stable
PR/head idempotency key. Normal review and closer eligibility own the new head.
