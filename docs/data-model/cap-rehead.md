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

The daemon selects branch maintenance with its canonical runtime root.
Its complete-history evidence comes from `src/ama/primary-change.mjs` and its
existing `isHammerCommit` predicate. Classification stops before merge-gate proofs
or local artifact inspection.
The dispatch prompt binds mode and exact repository/PR/branch/head coordinates;
workers need no helper checkout.
Hammer histories (including an already
divergent primary/final merge base) are squashed onto current main as
one builder commit and pushed with an explicit old-head force-with-lease.
Builder-only histories retain merge-main and a fast-forward push. Neither
variant changes this store, refunds an attempt, or advances an exhausted
review cycle. A squash carries no closer provenance and receives fresh review
of the whole diff.

Rescue closeout: each new attempt optionally retains `updateMode` (`squash` or
`merge-main`), resolved with canonical daemon provenance before reservation. Old
records without it remain valid. The corresponding `<key>-<head>.prompt.md`
binds repository, PR, branch and old head with the selected mode. Existing
reserved/dispatched/unacknowledged states and permanent charges are unchanged.
Only a positively live dispatched launch or retry suppresses cap notifications;
terminal/unknown evidence and terminal skip reasons retain ordinary escalation.
