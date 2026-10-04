# Data Model - HAM Primary Change Refusals

**Owner:** AMA primary-change merge hold and closer refusal paging
**Store:** `data/ham-primary-change-refusals.db`
**Source of truth:** `src/ama/primary-change-refusal.mjs`
**Runtime surface:** `src/ama/dispatch-closer.mjs`

## Schema and lifecycle

The closer creates SQLite table `refusals` on first use. Its composite primary
key is `(repo, pr, head)`; `repo` and `head` are text, `pr` is an integer.
`count` and `paged` are integers defaulting to zero. Each refused closer
observation increments `count` in an immediate transaction with a 5,000 ms busy
timeout. At `count >= 3`, the transaction changes `paged` from zero to one and
only that winner emits `ama_primary_change_refusal_exhausted` and sends a SEV1
page. The guard survives process restarts and is scoped to one PR head.

`paged` records a reserved delivery attempt, not an acknowledged page: a pager
failure after the commit does not retry the page. Store and pager exceptions are
logged by the closer and cannot release `skipMergeAgent: true`. The daemon parks
before the closer and never writes this store. Recovery is described in
[the AMA runbook](../RUNBOOK-ama-closure.md#primary-change-evidence-authorization-and-disputes-hamintent-02--lac-1833).

## Retention and migration

There is no automatic expiry or deletion. AMA owns these rows until an operator
archives closed-PR diagnostics; do not delete an open head's page guard to reset
its counter. A new head gets a new row. Schema convergence is idempotent
`CREATE TABLE IF NOT EXISTS`; no existing columns are rewritten.
