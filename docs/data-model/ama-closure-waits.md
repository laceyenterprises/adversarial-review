# Data Model - AMA Closure Waits

**Owner:** AMA bounded closure wait and exhaustion paging (HAMCLOSE-01)
**Store:** `data/ama-closure-waits/<sha256(repo#prNumber)>.db`
**Source of truth:** `src/ama/closure-wait.mjs`
**Runtime surfaces:** `src/reviewer-ci-admission.mjs`, `src/ama-closure-orchestration.mjs`, `src/ama/dispatch-closer.mjs`

## Purpose and schema

`observeClosureWait` tracks pending gates, live or uncertain ownership, lease
contention and deferred closure attempts. Each PR has a SQLite database named
by the SHA-256 hex digest of the literal `repo#prNumber` string. The canonical
daemon owns these databases. `CREATE TABLE IF NOT EXISTS` initializes
`waits_by_class`, keyed by `PRIMARY KEY(head, class)`:

| Column | SQLite definition | Meaning |
| --- | --- | --- |
| `head` | `TEXT` | Exact PR head SHA. |
| `class` | `TEXT` | `primary-change` for immediate primary-change pages, `final-round` for final-round stalls and cap exhaustion, `lane-busy` for the third repeated legacy lane-busy launch on a head, `ci-regression-ownerless` for immediate failed-CI remediation refusals, and `bounded-wait` for other waits. Lane-busy pages are immediate, retain contention refunds/backoff, retry failed delivery, and dedupe per PR/head across restarts. Primary-change receipts remain independent of final-round receipts. |
| `started` | `INTEGER NOT NULL` | First observation or latest launch/head progress in epoch milliseconds. |
| `reason` | `TEXT` | Latest wait reason, refreshed on every observation. |
| `paged` | `INTEGER DEFAULT 0` | Exhaustion page reservation: 0 available, 1 reserved/sent. |

## Lifecycle and recovery

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
