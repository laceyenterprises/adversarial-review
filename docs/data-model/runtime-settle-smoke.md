# Data Model - Agent Runtime Settle Smoke

**Owner:** agent-runtime cutover readiness  
**Store:** `data/runtime-settle-smoke/agent-runtime.json`  
**Source of truth:** `src/adapters/agent-runtime/settle-smoke.mjs`  
**Runtime surface:** `src/runtime-settle-smoke-cli.mjs`,
`scripts/adversarial-runtime-canary.mjs`, `src/reviewer-runtime-cutover.mjs`,
`src/runtime-status.mjs`

## Purpose

The settle-smoke artifact is the durable latest-result snapshot proving that the
`agent-runtime` adapter can dispatch a synthetic review, reach a clean terminal
result, and attribute that result to a worker run. Cutover readiness fails
closed when the snapshot is missing, unreadable, malformed, failed, or stale.

The artifact is runtime evidence, not a queue or event log. Each scheduled or
manual smoke atomically replaces the previous snapshot.

## Artifact Schema

| Field | Shape | Contract |
|---|---|---|
| `schema_version` | integer | Required. Exactly `1`; other versions are unsupported and fail readiness. |
| `runtime` | string | Required. Currently `agent-runtime`. |
| `at` | ISO-8601 string | Required result timestamp used for the freshness decision. An invalid timestamp fails readiness. |
| `startedAt` | ISO-8601 string | Time the smoke dispatch began. |
| `requestId` | string | Runtime run reference when dispatch succeeds, otherwise the deterministic request idempotency key. |
| `dispatched` | boolean | Whether the runtime returned a run reference. |
| `settled` | boolean | Whether the runtime returned terminal status `completed`. |
| `attributed` | boolean | Whether the terminal result carried a worker-run identifier. |
| `workerRunId` | string or null | Canonical worker-run attribution for the smoke. |
| `status` | `pass` or `fail` | `pass` only when dispatch, settle, and attribution all succeed. Any other value is invalid for readiness. |
| `detail` | string or null | Operator-facing explanation of the pass or failure. |

Writers may add diagnostic fields without changing the readiness contract. The
reader requires only the version, runtime, result timestamp, and status fields
and preserves the complete parsed object for operator output.

## Operational Contract

- `writeSettleSmokeResult` asserts canonical ownership before writing and uses
  the repository atomic-write helper with overwrite enabled. Partial JSON must
  never be published as the latest snapshot.
- `readSettleSmokeResult` returns `null` for a missing file. Invalid JSON becomes
  `read_error: invalid-json`; other read failures become
  `read_error: unreadable`. Neither condition is healthy.
- The current freshness window is seven days. A `pass` older than that window
  fails closed as `stale`; future timestamps are clamped to age zero.
- `fail` is a valid persisted result but blocks cutover. Missing, unsupported,
  or otherwise malformed fields block cutover through distinct reason codes so
  operators can distinguish a failed smoke from absent or corrupt evidence.
- The scheduled runtime canary refreshes this snapshot. Scheduled execution
  must report rejected writes as a clean non-zero process exit rather than an
  unhandled promise rejection.
- The artifact contains no credentials or review content. It records only
  synthetic request identity, lifecycle booleans, attribution, and diagnostics.
