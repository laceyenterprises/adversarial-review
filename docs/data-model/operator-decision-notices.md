# Data Model - Operator Decision Notices

**Owner:** watcher operator-decision notification observation
**Store:** `<runtime rootDir>/data/operator-decision-notices/*.json`
**Source of truth:** `src/operator-decision-notice.mjs`
**Runtime surface:** `src/pollonce-phases.mjs`, `src/ama-closure-orchestration.mjs`

## Identity and fields

Each file is named by the SHA-256 hex digest of `repo#prNumber`. Atomic writes
retain one current observation and one latest closer outcome per PR. Missing,
unreadable, or unparseable files are treated as empty observation state.

| Field | Shape | Contract |
|---|---|---|
| `observation` | object or null | Current held head and the beginning of its backstop window; cleared when the PR is terminal or the projected decision no longer requires an operator. |
| `observation.headSha` | string | A different observed head replaces the observation and starts a fresh window. |
| `observation.startedAt` | number | Epoch milliseconds at first operator-required observation, used for the 45-minute backstop. |
| `closer` | object | Latest recorded closer result, independent of the observation. |
| `closer.headSha` | string | Pins the closer result to the head; other heads cannot inherit its outcome. |
| `closer.result` | object or null | Observation of the closure orchestrator result, including `needsOperator`, `closureOwner`, dispatch, recovery, and retry evidence. Does not grant merge or dispatch authority. |
| `heldHeads` | object | Map of head SHA to `true`, suppressing repeated held-notice log lines. |

## Delivery contract

The watcher reads notice state asynchronously on non-alerting settled-subject
polls. Clearing an earlier observation re-reads and writes the latest state
synchronously so a closer outcome arriving during the async lookup is retained.
Operator-required observation and closer outcome persistence use synchronous
reads and writes. Closer leases and dispatch records,
follow-up jobs, and handoff review state remain their own sources of authority;
the notice store only observes them. Active ownership holds delivery even after
the backstop expires. With no active ownership, an operator-required outcome or
ended hammer selects immediate delivery, otherwise the backstop applies.

PR closure and review completion are distinct: the GitHub subject adapter sets
`terminal` only for a non-open PR. Delivery additionally verifies live open PR
state and the same `headRefOid`. Successful durable enqueue sets the existing
per-head debounce fields in [cascade state](cascade-state.md); failed enqueue
leaves them unset and retries later. See the
[operator notice runbook](../follow-up-runbook.md#operator-decision-notices-reviewnotice-01).
