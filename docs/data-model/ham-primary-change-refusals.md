# Data Model - HAM Primary Change Refusals

**Owner:** AMA legacy primary-change refusal diagnostics
**Store:** `data/ham-primary-change-refusals.db`
**Source of truth:** `src/ama/primary-change-refusal.mjs`
**Runtime surface:** none (legacy helper retained for offline tests and explicit callers)

## Runtime status

REMORPHAN-01 removed the production closer observation writer. Normal watcher
and closer ticks no longer increment this store or page at the refusal threshold.
Existing rows remain historical diagnostics; automatic ownerless recovery and
paging now use [the orphan watchdog](orphan-watchdog.md). The helper remains
available to explicit callers and its tests.

## Legacy helper schema and lifecycle

An explicit helper invocation creates SQLite table `refusals` on first use. Its
composite primary key is `(repo, pr, head)`; `repo` and `head` are text, `pr` is an integer.
`count` and `paged` are integers defaulting to zero. Each explicit refusal helper
invocation increments `count` in an immediate transaction with a 5,000 ms busy
timeout. At `count >= 3`, the transaction reserves the page with `paged=1`
while `paged<2`, emits `ama_primary_change_refusal_exhausted` and sends a SEV1
page. `paged=2` records confirmed durable enqueue and prevents later sends.
The guard survives process restarts and is scoped to one PR head.

An interrupted `paged=1` reservation retries on the next helper invocation.
A successful enqueue changes the guard to two; a failed enqueue releases it
to zero before rethrowing, so the next observation retries without resetting
the count. It does not claim transport delivery.
Explicit callers own error handling. The closer retains its merge refusal
independently of this legacy store; neither daemon nor closer currently writes
it. Recovery is described in
[the AMA runbook](../RUNBOOK-ama-closure.md#primary-change-evidence-authorization-and-disputes-hamintent-02--lac-1833).

## Retention and migration

There is no automatic expiry or deletion. AMA owns these rows until an operator
archives closed-PR diagnostics; do not delete an open head's page guard to reset
its counter. A new head gets a new row. Schema convergence is idempotent
`CREATE TABLE IF NOT EXISTS`; no existing columns are rewritten.
