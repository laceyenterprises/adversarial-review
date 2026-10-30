# Data Model - AMA Closure Waits

**Owner:** AMA bounded closure wait and exhaustion paging (HAMCLOSE-01)
**Store:** `data/ama-closure-waits/<sha256(repo#prNumber)>.db`
**Source of truth:** `src/ama/closure-wait.mjs`, `src/ama/closure-refresh-loop.mjs`, `src/ama/closure-recovery.mjs`
**Runtime surfaces:** `src/reviewer-ci-admission.mjs`, `src/ama-closure-orchestration.mjs`, `src/ama/dispatch-closer.mjs`, `src/follow-up-merge-agent.mjs`

## Purpose and schema

`observeClosureWait` tracks pending gates, live or uncertain ownership, lease
contention and deferred closure attempts. Each PR has a SQLite database named
by the SHA-256 hex digest of the literal `repo#prNumber` string. The canonical
daemon owns these databases. `CREATE TABLE IF NOT EXISTS` initializes
`waits_by_class`, keyed by `PRIMARY KEY(head, class)`:

| Column | SQLite definition | Meaning |
| --- | --- | --- |
| `head` | `TEXT` | Exact PR head SHA. |
| `class` | `TEXT` | `primary-change` for immediate primary-change pages, `final-round` for final-round stalls and cap exhaustion, `lane-busy` for the third repeated legacy lane-busy launch on a head, `ci-regression-ownerless` for immediate failed-CI remediation refusals, `closure-recovery-deadline` for the one escalation of an R04 ownership reconciliation still unresolved at its next-action deadline (CLOSURERECOVERYEXEC-01), and `bounded-wait` for other waits. Lane-busy pages are immediate, retain contention refunds/backoff, retry failed delivery, and dedupe per PR/head across restarts. Primary-change receipts remain independent of final-round receipts. |
| `started` | `INTEGER NOT NULL` | First observation or latest launch/head progress in epoch milliseconds. |
| `reason` | `TEXT` | Latest wait reason, refreshed on every observation. |
| `paged` | `INTEGER DEFAULT 0` | Exhaustion page reservation: 0 available, 1 reserved/sent. |

## Lifecycle and recovery

`original-worker-evidence` and `closer-worker-evidence` use separate per-head
rows for unavailable original-worker teardown evidence and unknown closer
liveness. Each retains its first observation and pages once at the configured
load-scaled bound, including across restarts. Exhaustion reports operator
recovery while retaining custody; it never authorizes reclaim or duplicate
dispatch. Later evidence reads can resume normal resolution. Alert failures
refund the page reservation using the existing transaction path.

An immediate transaction inserts the head/class with `INSERT OR IGNORE`, updates its
reason and compares elapsed time against the wait bound. Later ticks, changed
reasons and process restarts retain the original `started`. A new head starts
its own boundary for each class. Immediate primary-change observations exhaust
immediately without starting or consuming the bounded-wait or final-round clock or page.
Final-round observations can seed the deadline from completion of the final
remediation push. Launch progress resets the deadline before exhaustion is
evaluated, so a successful launch at the deadline does not emit a stall page.
HAMCLOSEWAIT-01: a retained running/starting dispatch supplies `closerProgressAt` from
its recorded launch; confirmed dispatched lease ownership supplies `updatedAt`,
falling back to `acquiredAt`. The later of this timestamp and final-round
completion advances an existing final-round `started` as well as seeding a new
row. A future timestamp seeds a new row at observation time, but is ignored
when advancing an existing row until the timestamp is reached. Only running/starting retained dispatches supply launch progress; stalled,
blocked, unknown and succeeded-awaiting-audit-or-merged-signal holds supply none. Repeated
observations of the same timestamp do not extend the deadline;
the load-aware thirty-minute base without further progress still pages. Pending or uncertain
ownership and other blockers retain their existing clocks and page receipts.
HAMCLOSEWAIT-02 adds an ephemeral `launchWait: { startedAt, boundMs }` observation
for a running process-queue background dispatch, including its own pending lease.
It uses actual execution start and the dispatch timeout (15-minute fallback),
never queue submission or poll time. It returns that launch boundary without
advancing the durable `started`; refusal resumes the original debt with settled
reasons. At its own bound the dispatch pages once with an explicit overrun and
elapsed milliseconds. Successful settlement supplies fixed launch progress
through the existing timestamp path. Queued, cancelled or restarted intent alone
cannot supply launch credit. There is no store schema change.
Explicit immediate observations still page regardless of launch progress.
For `final-round`, head movement replaces prior class rows and restarts the
deadline while carrying the maximum `paged` value forward. Final-round stalls
and cap exhaustion therefore share one receipt per PR, including across heads;
an immediate primary-change alert cannot consume it.
LOADAR-01: the nominal bound is 30 minutes; a finite positive
`AMA_CLOSURE_WAIT_BOUND_MS` overrides that base. The existing load-aware timeout
helper scales either base at observation time, honoring the shared policy and
multiplier without the helper's default one-hour cap. Invalid or nonpositive
values retain the nominal default. A background launch boundary is already sized
by its dispatcher and is consumed without another multiplier. Observations return a 30-second `retryAfterMs`.

Confirmed running/starting status from the existing live-status read supplies
`launchAlive`; a running in-process background dispatch also proves liveness.
At the bound that evidence changes the notice to "still running after N minutes".
Unknown or terminal evidence retains "closure wait exhausted"; immediate pages
retain their exhaustion wording. The returned `exhausted` flag, wait debt,
once-only receipt, retry cadence and ownership behavior remain unchanged.

At exhaustion, an atomic `paged=0 → 1` update reserves one SEV1 alert before
delivery. The alert names repo, PR, head and reason, with source
`hamclose-closure-wait` and deduplication key
`hamclose:<repo>:<prNumber>:<head>:<class>`.
A thrown delivery error resets `paged` to 0 so a later observation can retry
without restarting the deadline. An interrupted process after reservation can
leave `paged=1` without a delivered alert; this store has no automatic reservation
expiry. Operators must verify delivery before resetting that head/class reservation.

The transition from the legacy `waits` table deliberately accepts a one-time
reset: existing rows are not migrated, and the old table remains on disk but
is no longer read. Each head/class starts its deadline and page reservation
on its first new observation. Active bounded waits may therefore incur another
30-minute default window, and prior page reservations do not suppress new
class-specific pages. Subsequent process restarts preserve `waits_by_class` rows.

This store measures wait debt; it grants no merge or dispatch authority and
does not consume the independent orphan/recovery attempt budgets. No automatic
row pruning, completion reset or database deletion is implemented. Retained
rows continue to describe prior heads and repeat observations use their original
deadline and reservation. Each call closes its connection after observation and
any alert attempt. Offline tests inject the pager and use temporary databases.

### Shared decision anchors (NXA-05)

When a closer snapshot lacks durable progress timestamps, an anchor-only call
uses the existing `bounded-wait` row's first `started` value for the shared
next-action deadline. Later polls reuse it. This observation never reserves a
page or sends an alert, even if overdue. Persistence failure is diagnostic and
cannot refuse execution. Ordinary observations retain existing delivery,
debounce, refund and retry behavior and report the selected action and actor.
There is no new table, column or migration.

### Snapshot-refresh cycles (CLOSERREFRESHLOOP-01)

The same per-PR database also initializes `refresh_cycle` on observation. This
additive table retains one row (`id INTEGER PRIMARY KEY CHECK(id=1)`) with
`head TEXT NOT NULL`, `fingerprint TEXT NOT NULL` and `cycles INTEGER NOT NULL`.
The SHA-256 fingerprint covers PR/check/review observation states and values,
plus the same-head daemon decline reason and detail reasons, excluding pass
generation, observation clock and provenance. Object key order and unordered
label, check-rollup, required-context and decline-detail arrays are canonical;
all entry fields are retained, and other arrays keep their order. Both decline
reason and detail reasons are excluded for executions from older heads. The
canonical encoding change can restart an existing counter once at deployment;
it does not clear the independent successful page receipt.

Each settled snapshot-refresh outcome increments the unchanged head/fingerprint
count, capped at three. Head or fact changes replace the row with count one;
a settled non-refresh outcome deletes it. Background queue submissions leave
it untouched, so submission/settlement alternation cannot erase the debt.
SQLite immediate transactions serialize observations; closing/reopening the
database preserves the count across watcher restarts. Consumed background
outcomes count once in the ordinary result wrapper, not again at settlement.

At three cycles, the result carries `closureBlocker`:
`snapshot-refresh-no-progress: daemon:<stored reason> cycles=3`,
`needsOperator: true` and the existing bounded wait. The `snapshot-refresh`
wait class pages immediately through `observeClosureWait`; its per-PR/head
reservation and delivery-refund rules apply. A missing stored decline is named
`unknown`. Failed page delivery retains the saturated count for retry. Resetting
the counter never resets a successful page receipt. The table measures a loop;
it grants no authority and changes no lease or retry budget.

### Closure decision mismatches (PRIMARYREPAIRDISPATCH-01)

The same database initializes `decision_mismatch_cycle` with one row:
`id INTEGER PRIMARY KEY CHECK(id=1)`, `head TEXT NOT NULL`, and
`cycles INTEGER NOT NULL`. Each consumed `closure-decision-mismatch` increments
the count, capped at two. A different head replaces it with count one. Decision
key changes, queue submissions and process restarts retain same-head debt.
There is no completion reset or migration of older observations.

The first mismatch permits one successor resolution from the complete replacement
snapshot. The second, whether in that attempt or a later background tick, returns
`closure-decision-mismatch-escalated`, `needsOperator: true`, and
`closureBlocker: closure-decision-mismatch-no-progress: head=<head> cycles=2`.
It pages immediately using the `closure-decision-mismatch` wait class and the
existing per-PR/head reservation. Failed delivery leaves the saturated count
and refunds the page receipt for retry. This counter grants no merge or dispatch
authority and leaves caps and leases unchanged. Synthetic tests inject paging.

### Actor admission disagreements (CEILINGOWNER-01)

An impossible review assignment to a capped closure row uses `waits_by_class`
with class `actor-admission`. The existing first-observation clock, bounded
retry and once-only page reservation apply. `observeClosureWait` also returns
`firstObserved`, derived from the insert result; the caller uses it to emit one
`ama.next_action.contract_violation` diagnostic per PR/head across restarts.
At the ordinary closure-wait bound the result carries `needsOperator: true`.
The watchdog cannot requeue this refused actor while the wait owns escalation.
There is no new table, column, admission gate or configuration key.
