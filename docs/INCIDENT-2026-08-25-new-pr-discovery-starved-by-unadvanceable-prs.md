# Incident — new-PR discovery starved by PRs the poll loop cannot advance

**Date:** 2026-08-25 UTC
**Ticket:** WPS-01
**Severity:** new PRs received no first review at all; no reviewer outage, no dead LaunchAgent
**Primary symptom:** `laceyenterprises/agent-os#5915` sat 30+ minutes with **zero**
reviews, **zero** rows in `reviews.db`, and **zero** mentions in the watcher log.

## Summary

`agent-os#5915` was well-formed in every respect: correct worker-class title
prefix, `isDraft=false`, `base=main`, same-repo, `MERGEABLE`/`CLEAN`, checks
green, and the same author (`app/lacey-claude-agent`) as #5911–#5914, which were
all picked up. It was not stuck in review. **The watcher never reached it.**

Of the last 400 watcher log lines, 72 belonged to three PRs that made no
progress, and 0 belonged to the PR waiting for a first look:

| PR | lines |
|---|---|
| #5911 | 33 |
| #5909 | 24 |
| #5908 | 15 |
| **#5915** | **0** |

The last 2000 lines carried **13** `auto-hammer: dispatching terminal
remediation` events for that same set of three. The repeating cycle, verbatim:

```text
[watcher] adversarial gate for ...#5909: pending (stale-review-head)
[ama-closer] auto-hammer: dispatching terminal remediation for ineligible PR
    (reasons: stale-review-head,verdict-not-settled-success,blocking-findings-unknown)
[watcher] AMA hammer route retained ownership for ...#5909: closer-lease-held-by-other-process
[watcher] adversarial gate for ...#5908: pending (stale-review-head)
[watcher] AMA hammer route retained ownership for ...#5908: stale-dispatched-lease-terminalized
```

Watcher process state throughout: alive (2h13m), **0% CPU**, sleeping, **no child
processes**, heartbeat **~40 minutes stale**, `poll_counter` not advancing.

## Root cause: a correct composition with no bound on it

Every individual component behaved correctly. The auto-hammer was right that
those PRs needed terminal remediation. The hammer was right to refuse merging
over a blocking verdict. `closer-commit-identity` suppression was right to refuse
a re-review after final remediation. **The composition of three correct
behaviours starved the loop.**

`pollOnce` runs three phases per tick:

1. discover subjects, then walk each one (this is what creates the `reviewed_prs`
   row for a brand-new PR and queues its reviewer);
2. drain the reviewer dispatch queue;
3. run the queued posted-review handlers (AMA closer, auto-hammer, merge
   routing), then the maintenance sweep.

Phase 3 was **unbounded** — every queued handler, to completion, however long,
however many, and however certainly it had already decided nothing could move. A
tick that never finishes phase 3 never returns to phase 1, so **discovery never
runs again**. That is why #5915 had no row and no log line: not stuck in review,
never seen.

Nothing caught it:

- The **poll deadline** is workload-aware. `computeWorkloadAwarePollDeadlineMs`
  budgets `repos × 50 PRs × 15m + slack`, i.e. roughly **12.5 hours** for a single
  repo. It is a safety bound, not a schedule.
- The **in-process stall watchdog** (`createWatcherStallWatchdog`) returns early
  whenever `pollInFlight` is true. A poll that is running is, for its purposes,
  healthy — which is exactly the state that lasted 40 minutes.
- The **dispatch watchdog** (`cwp_dispatch_watchdog`) reported `wedged: false`
  throughout; every trigger there is a `process-missing` variant, so it detects an
  ABSENT watcher and never a STARVED one.

### Relationship to the 2026-06-20 incident

[INCIDENT-2026-06-20-review-adoption-starved-by-merge-handoff.md](./INCIDENT-2026-06-20-review-adoption-starved-by-merge-handoff.md)
is the direct ancestor. That fix reordered work *within* a tick so reviewer
dispatch drains before merge-side handoffs. It is still correct and still in
place. WPS-01 is the next-order failure: reordering does nothing for a tick that
never **ends**, because the starved work is in the *next* tick's discovery.

## Fix

Three changes, none of which weaken a guard.

### 1. Discovery-first ordering (`orderSubjectEntriesDiscoveryFirst`)

Subjects with no `reviewed_prs` row are walked before subjects that already have
one. Note that the pool-disabled sort (`compareReviewerDispatchCandidates`) is
oldest-created-first, which puts a brand-new PR dead last, behind precisely the
long-lived backlog most likely to be unadvanceable. First-look latency is the one
thing that cannot be made up later.

A tracked PR that waits an extra tick is *late*. A PR with no row yet is *absent
from every operator surface* — which is how #5915 accumulated 30 minutes of
nobody noticing.

**Scope:** this reorders the *walk* (row creation, routing, claim, queueing), not
the *dispatch*. In the pooled path `runBoundedReviewerDispatchQueue` re-sorts its
own queue oldest-created-first, and that FIFO-by-PR-age policy is left exactly as
it was. Changing who gets reviewed first is a separate policy decision; this only
guarantees a new PR is **seen**.

### 2. A bounded posted-review phase (`runPostedReviewHandlersFairly`)

- **Per-handler deadline** (`ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS`,
  default 5m). A phase budget alone cannot save a tick, because it is only checked
  *between* handlers: one handler that never settles wedges the tick regardless of
  remaining budget. Same trade-off `safePollOnce` already documents — the
  abandoned promise may still complete its side effects, which is tolerable
  because every side effect downstream of a posted-review handler is guarded by a
  lease or a CAS, and the alternative is the outage above.
- **Per-tick wall-clock budget**
  (`ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS`, default 10m). Handlers cut
  off are **deferred, not dropped**: their keys are promoted to the front of the
  next tick, so the cut point rotates and the same tail cannot be starved.

### 3. A no-progress lane (`src/watcher-no-progress-lane.mjs`)

A per-`(repo, pr, head)` ledger counting consecutive ticks that produced no
observable state change, deliberately extending the idea already proven in
`ama-retain-loop-cap.mjs`. The difference is the consequence: the retain cap
*escalates* for one specific AMA reason; this lane is reason-agnostic and
*demotes*. After `DEFAULT_NO_PROGRESS_LANE_CAP` (3) consecutive no-progress ticks
on the same head, the PR is re-walked on an exponentially-spaced schedule —
1, 2, 4, 8 … ticks — **capped at 12 ticks (one hour at the production 5m
interval)**.

Progress is measured by fingerprint (`subjectProgressFingerprint`), not by asking
the handler: a handler that returns cleanly having decided "retain ownership,
nothing to do" is indistinguishable at the call site from one that dispatched
real work. Only the resulting review-state row tells the truth.

Three properties this preserves deliberately:

- **Nothing is weakened.** The lane never changes what a handler decides, only
  how often it is asked. Auto-hammer eligibility, the blocking-findings hard
  stop, and `closer-commit-identity` suppression all run verbatim when the PR is
  due.
- **Nothing is dropped.** The backoff is bounded, so a demoted PR is still
  re-walked forever on a known cadence. Every skip logs, and the ledger is on
  disk under `data/watcher-no-progress-lane/`.
- **Progress always wins.** A new head or any state change resets the series
  immediately.

### 4. Starvation detection (`createWatcherStallWatchdog` + `watcher-poll-starvation-signal.mjs`)

The missing signal, on exactly the state nothing could see: a poll **in flight**
for longer than the heartbeat SLA with **no `poll_counter` advance**, observed
across N consecutive checks so a single slow-but-productive tick is not paged.

- Env: `ADVERSARIAL_WATCHER_POLL_STARVATION_MS` (default `max(15m, 3 × poll
  interval)`), `ADVERSARIAL_WATCHER_POLL_STARVATION_CHECKS` (default 3).
- On trip: a loud `[watcher] poll starvation:` log line, a `poll_starvation`
  block persisted into the heartbeat file, and an
  `adversarial_review.poll_starved` alert.
- It **signals, it does not exit.** Killing a long tick would abort reviewer work
  that may be legitimately slow, and `POLL_DEADLINE_EXCEEDED` already owns the
  kill decision. What was missing was somebody being told.
- The heartbeat write uses `persist`, which refreshes `updated_at` but **not**
  `last_poll_at` — the field the external `adversarial-watcher-watchdog` prefers
  for freshness. The starvation is made legible without masking the staleness
  that proves it.

## Operator surfaces

| Question | Where to look |
|---|---|
| Is a tick frozen right now? | `[watcher] poll starvation:` in the log; `poll_starvation` in the heartbeat JSON; the `adversarial_review.poll_starved` alert |
| Which PRs are in the slow lane? | `data/watcher-no-progress-lane/<repo>-pr-<n>.json` (`lane`, `noProgressTicks`, `skippedTicks`, `headSha`) |
| What did this tick skip or defer? | The once-per-tick `[watcher] posted-review phase: queued=… ran=… slow_lane_deferred=… budget_deferred=…` line |

A demoted PR is not hidden: it keeps its `reviewed_prs` row, its gate status, and
its labels. Only the re-walk cadence changes.

## Relationship to HSC-01

HSC-01 fixes the *reason* #5908/#5909/#5911 could not advance (the hammer's
terminal remediation does not self-certify, so a remediated head never merges).
That is a separate ticket and a separate fix.

WPS-01 assumes HSC-01 succeeds. A PR that legitimately cannot advance — an
operator-gated one, a genuinely unresolvable head, one awaiting a human — will
always exist, and must never be able to starve discovery.

## Regression coverage

`test/watcher-poll-starvation.test.mjs` — a fixture with N unadvanceable PRs plus
one new PR, asserting the new PR is ingested within one tick and that the tick
terminates. Verified to fail without the fix: with identity ordering and no
per-handler deadline, the fixture tick never returns (`test timed out`), which is
the live wedge reproduced.

## Follow-ups

- Teach the external `cwp_adversarial_watcher_watchdog` to read the
  `poll_starvation` block from the heartbeat payload so the signal surfaces in
  `hq adversarial-watcher-watchdog status` as its own trigger rather than as a
  generic `heartbeat-stale`. (Lives in `agent-os`, not this repo.)
- Consider extending the phase budget to the maintenance handlers
  (`postReviewMaintenanceHandlers`) and `syncPRLifecycle`, which remain unbounded.
