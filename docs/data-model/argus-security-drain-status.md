# Data Model - Argus Security Drain Status

**Owner:** ARGUSDRAIN-01 Argus security drain
**Store:** `data/argus-security-drain-status.json`
**Source of truth:** `src/argus-security-health.mjs`
**Runtime surface:** written by `startArgusSecurityDrainForWatcherTick`
(`src/argus-security-drain.mjs`) once per watcher tick; read by
`summarizeArgusSecurityQueue` (`src/argus-security-health.mjs`) for
`review-pipeline-health`.

## Purpose

A single status record for the watcher-owned drain of
`data/argus-security-jobs/`. It lets the pipeline health surface tell a drain
that is disabled, erroring, or not running apart from one that is working, and
tells it whether the backlog retirement pass is fresh enough to vouch for the
liveness of the jobs still queued. The file is a report, never an authority:
nothing reads it to decide what to claim, and deleting it only makes the health
surface report the drain as not running until the next tick rewrites it.

## File

`data/argus-security-drain-status.json`, replaced atomically on every write.
Unparseable content reads as `{ "unreadable": true }`.

| Field | Shape | Contract |
|---|---|---|
| `observedAt` | string | ISO time of the tick that wrote the record. Its age is what `review:argus_security_drain_not_running` measures. |
| `enabled` | boolean | `false` when the drain's kill switch is set; the record then carries only `observedAt` and `enabled`. |
| `error` | string or absent | Present only when the tick itself threw. |
| `paused` | boolean | `true` when the watcher's drain mode paused new claims this tick. |
| `skipped` | string or null | Why the tick claimed nothing: `paused`, or `awaiting-backlog-retirement` before the first retirement pass has finished. `null` when the tick was free to claim. |
| `claimedThisTick` | number | Jobs claimed on this tick. |
| `running` | number | Reviews in flight in this process after the tick. |
| `limit` | number | Concurrency cap. |
| `peakRunning` | number or null | Highest concurrent reviews seen by this process. |
| `retirement` | object or null | Backlog retirement state: `firstPassDone`, `running`, `lastFinishedAt`, `lastError`, and `lastSummary` (the last pass's counts: `observedAt`, `pendingBefore`, `retired`, `retiredByReason`, `liveHeads`, `oldestLiveHead`, `requeued`, `reclaimed`, `resumedRequeues`, `skippedRepos`). A pass that finished without `lastError` within the freshness window marks queued jobs `verified-by-retirement` on the health surface. |

## Operational contract

- Written every tick, including when the drain is disabled or the tick fails,
  so "disabled", "erroring" and "dead" read differently.
- A failed status write is logged and never stops the drain.
- Contains no secrets: counts, timestamps, PR identities and error text.
