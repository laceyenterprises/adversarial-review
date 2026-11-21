# SEV1: reviewer settlement waited on ledger reads that could not succeed

Date: 2026-11-20. Ticket: REVIEWSETTLETOKENWAIT-01. Severity: SEV1, operator-declared
(closer and merge latency). Status: settle path fixed. The deployed admission
mode and the dominant miss case still need confirming from the new log line.

## Impact

A production host's watcher log showed that every reviewer-pass settlement
logged `step=token-ledger-lookup ... attempts=3`. Each lookup took minutes.
Summed per step, token-ledger lookups cost far more than freshness, dedup or
closer work. Poll cycles after a restart ran for more than half an hour.
Clean, approved PRs waited up to a cycle before their merge decision, against
an operator target of a closer within ten minutes of remediation completing.
The log contained no `reviewer_pass_token_ledger_lookup_failed` warnings. The
only reason that code suppresses from that warning is
`worker-run-not-yet-visible`, so every miss was silent.

## Mechanism

`readReviewerLedgerEvidenceWithRetry` (`src/reviewer-spawn-settle.mjs`) made up
to three reads, 25 and 75 ms apart. It returned early only when the evidence
carried a `workerRunId`, or when there was evidence and no `launchRequestId`.
Every other outcome was labelled `worker-run-not-yet-visible` and read again.
Each read is a forked process (`src/reviewer-token-ledger-lookup.mjs`) that
does synchronous ledger and transcript I/O, with a 180 s load-aware timeout.
All reads share one queue that runs two at a time. A slow miss therefore cost
three slow reads plus queueing, and every settlement added three reads to the
shared queue.

## Phase 0

### 1. Does `pollOnce` await settlement?

The probe ran the real `pollOnce` through the offline claim-loop fixture
harness (`test/watcher-claim-loop.test.mjs`). Two synthetic reviews returned a
`launchRequestId`, and a stub evidence reader slept 2 s and returned nothing.

| Admission mode | `pollOnce` | Reads | Lookup per settle |
| --- | --- | --- | --- |
| Rollback (`ADVERSARIAL_REVIEW_ADMISSION_SETTLEMENT_SPLIT=false`) | 8.8 s | 6 | 6.1 s, `attempts=3` |
| Default (settlement split on) | 1.1 s | 6 | 6.1 s, `attempts=3`, still running after `pollOnce` returned |

The answer depends on the mode:

- **Rollback mode, or any domain with `pipeline.enabled`** (which disables the
  split): the poll awaits settlement, including the token lookup. The cycle
  grows with the lookup.
- **Default split mode:** the admission slot is released when the review row is
  durably settled. The merge handoff starts at the same point. The token lookup
  runs as a detached continuation that `pollOnce` does not await. The existing
  `SEATIDLE-03` claim-loop test pins this.

The code alone cannot explain the observed half-hour cycles under the default
mode. They are consistent with that host running rollback mode or a
pipeline-enabled domain, which only its live configuration can show; this
ticket did not read it. Indirect effects such as host load from the forked
readers were not established either. The fix bounds the cost in every mode.

### 2. When can a launch carry no attributable worker run?

From code and the existing tests:

- **No launch ID: structural.** Adapters that surface no `launchRequestId`
  (direct CLI runs, and any runtime whose status payload lacks
  `launch_request_id`) can never attribute a worker run. The old loop still
  read three times whenever evidence was absent, and labelled the result
  `worker-run-not-yet-visible`. The existing test *"spawnReviewer settles
  worker_run_id null when no worker run resolves (cli-direct path)"* pinned
  that behaviour: `lookupAttempts: 3`.
- **Launch ID present, ledger miss: timing or refusal.** The worker-run row
  appears only once worker-pool capture lands. A 25/75 ms pause cannot bridge
  that. Producer refusals (`worker-observation-scope-denied`,
  `-inconclusive`, `-unavailable`) reach the settle path as a plain `null`,
  because `readWorkerRunTokenUsage` discards the reason. The loop could not
  tell them apart, so it retried all of them.
- **Not a key mismatch.** The settle path and the ledger selector both use the
  strict `launch_request_id`. Settle never substitutes `reattachToken`; the
  existing collision test proves this.

Which case dominates on that host is unknown without live data. The new
`reason=` field separates them on the next deployment.

## Fix

- **One read per settle.** A ledger miss is never re-read on the settle path.
  The pass keeps its durable `pending` attribution for the existing
  `scripts/backfill-reviewer-passes.mjs` repair. Only transient SQLite
  contention is retried.
- **Bounded settle wait.** Queue wait plus the read is capped at a load-aware
  10 s nominal bound.
- **Deferred backfill.** A read that outlives the bound keeps running. If it
  returns evidence, the watcher replays the same pass once, after the settle's
  own replay. The outcome is already durable before accounting, so the replay
  only enriches tokens, `worker_run_id` and `workerRunAttribution`.
- **Structural miss named.** No launch ID now records
  `worker-run-not-attributable` after one attempt.
- **Visibility.** Every settle that reads evidence logs one info line:
  `step=token-ledger-lookup elapsed_ms=… attempts=… reason=… deferred=…`. The
  reason is always included, `worker-run-not-yet-visible` too.

## Lessons and regression scope

- A retry needs a recovery window that matches what it waits for. Retries
  25 ms apart cannot wait out a capture that takes minutes.
- When a reason is filtered out of a warning, it still needs an info-level
  record, or a failure that happens every time can be invisible.
- Regression tests (synthetic, offline): one read for a structural miss, one
  read for a timing miss, a bounded settle with a blocked reader followed by a
  late backfill, a deferred read that fails, and a claim-loop poll cycle that
  carries one read per settle in rollback mode.

## Follow-ups (not built here)

- Confirm the deployed admission mode and domain pipeline flags. If rollback
  mode is in use only to work around another problem, retire it.
- Pass the ledger producer's refusal reason through
  `readBestReviewerEvidenceTokenUsage`, so a structural refusal such as
  `scope-denied` is named in its own right rather than as
  `worker-run-not-yet-visible`.
