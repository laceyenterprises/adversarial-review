# RUNBOOK — review queue failover (RSP-01 / REVIEWSPILL-01)

The depth lever is disarmed until an operator sets its threshold. The individual
wait bound operates independently, including when depth is disarmed.
REVIEWCORPFIRST-01 removes the per-tick spill count from that bound: every
past-bound PR may spill at its next admission point, limited by the alternate
reviewer's pool and credential capacity. Age reservations and refunds remain
accounted, but neither spend nor replenish the depth budget for pre-bound PRs.

## What it does

First-pass review is not single-threaded, but it is single-**class**, which
produces the same ceiling. Measured on this host, the last 60 reviewer spawns
were 100% `gemini` (the `agy` harness). `agy` is the one reviewer harness that
does not parallelize — it serializes — so six pool slots all queue behind one
provider and a backlog grows without bound.

`review-worker-class-fallback.mjs` already knew how to spill first-pass review to
another worker class, but its only trigger was provider quota. Worse, `gemini` is
not a tracked quota harness at all (`QUOTA_HARNESS_PROVIDER` covers openai and
anthropic), so that path returned `primary-provider-untracked` and did nothing —
a healthy-but-saturated gemini never yielded no matter how deep the backlog.

This lever adds the missing trigger: **queue depth**. Depth spills are decided
at pool admission in every drain, including the discovery launch wave and later
waves for deferred candidates. An engaged lane spills only when the pool's
Gemini seats are saturated and the overall reviewer pool still has room.
The pool keeps its wake priority, oldest-first ordering within each tier, and
re-review lane floor; spill routing does not predict a separate admission order.
Pipeline Gemini seats count even when the candidate's main route is not Gemini.
Unknown broker capacity uses the same conservative single-Gemini cap as normal
admission, so candidates beyond that slot can still spill.

Discovery launches remain enabled while the lever is engaged; no full repository
census or lifecycle sweep is required before admitting the first wave. Each lane
shares its graded per-tick budget across drains. While a subject's lane has
engaged depth pressure and unspent depth budget, discovery suppresses the
separate burst-pressure trigger and leaves depth routing to pool admission.
Depth re-evaluation also suppresses burst, so a depth spill spends only depth
budget. Burst discovery remains available when that lane is disengaged or its
depth budget is exhausted. Quota fallback remains available independently.
The intermediate discovery wave waits for retained wakes and overdue reviews
in later subjects or repositories to enter the candidate queue. This per-tick
barrier covers only repositories being polled and subjects whose state was
successfully fetched. Missing subjects, including externally closed PRs with
stale open database rows, and failed discovery reads release their barrier;
they cannot produce a candidate during that tick. This does not erase durable
wake priority: absent subjects retain it until a live read confirms closure or
head movement, and failed live reads preserve it for later polls.
Candidates whose pipeline still requires Gemini seats cannot spill their main
route, because that would not release Gemini capacity.
Spill reservations require a repository and a positive PR number; missing or
invalid coordinates fail before charging capacity or the cost ledger.
A candidate refused by a later gate, or deferred by pool admission, refunds its
reservation. A pool deferral uses reason `pool-admission-deferred`, restores the
preferred route, and can be re-evaluated in a later drain. Spill and refund route
changes refresh cross-model waiver metadata before spawn. A failed drain also
refunds reservations for every candidate it did not start; started candidates
settle their own reservations at spawn or refusal. The shared drain also refunds
a started candidate that returns `dispatched: false` or rejects admission; refunds
are idempotent with the candidate's cleanup and restore its preferred route.

### Claude account order

Every managed Claude reviewer, hammer and remediator lane tries the corporate
account first. Corporate reserve flags (`nearCap`, `active`, `paused`) alone do
not switch accounts. Fresh, independently measured quota and a serving broker
are still required. Provider/model exhaustion, typed quota exhaustion on reviewer
spawn, or a broker that explicitly cannot serve permits the primary account,
whose own evidence must admit it. Unknown or stale corporate evidence holds.
Worker-class fallback cannot admit Claude from aggregate quota alone when account
selection is absent or held. Primary Claude routes retain account selection even
when no worker-class fallback is configured or applied. The final Claude spawn
gate refuses missing evidence and rechecks account holds; either refusal releases
the claim, reservation and spill slot without spawning.
Reviewer spawn logs include `claude_account=corporate|primary`; that account is
also used for quota preflight and token minting/renewal.

Typed corporate reviewer exhaustion persists an account-scoped cooldown before
capacity is released. Subsequent admissions can use independently verified
primary capacity until the provider reset (15 minutes when no reset is supplied,
bounded to seven days). This does not alter Gemini cooldowns or take Argus seats.

Codex reviewer routes follow the same corporate-first policy for direct reviews,
spills, and every fallback. Unknown or stale corporate quota or broker evidence
holds; confirmed exhaustion or explicit broker unavailability permits independently
admitted personal capacity. Typed corporate Codex exhaustion persists its own
account cooldown before releasing capacity. Codex spawns log
`codex_account=corporate|primary`, and the selected provider binds quota preflight,
token minting and renewal. See [Codex account routing](CCX-04-corporate-review-fallback.md).

After deploy, SRE confirms the watcher restarted, observes corporate Codex spawn
logs while that account has capacity, and checks a long first-pass queue admits
multiple overdue spills per tick. With an alternate slot free, no PR should wait
more than about 15 minutes beyond its bound; investigate stale account evidence,
credential holds and admission refusals when that observation fails.

## This is a cost lever, not a parallelism knob

`agy` is serialized on purpose: it is cheap, and keeping review on it preserves
provider quota for the work that ships code — builds and remediations. Every
other reviewer class parallelizes **and spends that same quota**. So the
threshold is not "how much parallelism do we want". It is:

> the depth at which a backlog becomes expensive enough to justify spending build
> quota to clear it.

Consequences, all enforced in code:

- **Depth is opt-in.** An unset threshold disables depth pressure; age pressure
  still bounds individual waits.
- **Graded, not a flood.** Each *full multiple* of the threshold sitting in the
  queue buys exactly **one** concurrent non-primary reviewer
  (`floor(depth / threshold)`). Depth 1.9× the threshold still spends one.
- **Disengages on recovery.** A lever, not a ratchet: once depth falls back under
  the threshold, review returns to `agy` and quota returns to builds.
- **Reports its cost.** Not just "spillover engaged" — the number of non-`agy`
  reviews the lever actually bought.

Long run, the operator's stated exit from this trade is OMB (a local model
backend), at which point parallel review stops competing with builds. That is why
this stays a lever rather than becoming the default path.

## The knob

| | |
|---|---|
| CFG key | `watcher.first_pass_review_queue_depth_failover_threshold` |
| Canonical env | `AGENT_OS_WATCHER_FIRST_PASS_REVIEW_QUEUE_DEPTH_FAILOVER_THRESHOLD` |
| Legacy-style alias | `ADVERSARIAL_REVIEW_FIRST_PASS_QUEUE_DEPTH_FAILOVER_THRESHOLD` |
| Type | integer ≥ 1, or `null` |
| **Default** | `null` — **disarmed** |
| Unit | see below |

Re-reviews use the parallel key
`watcher.rereview_queue_depth_failover_threshold` and canonical env
`AGENT_OS_WATCHER_REREVIEW_QUEUE_DEPTH_FAILOVER_THRESHOLD`. When absent it
inherits the first-pass threshold; `0` disables only re-review depth spillover.
Both lanes measure the same actionable queue, with separate thresholds and
spill budgets. A requested re-review contributes pressure to both lanes.

Both queue-depth lanes exclude open PRs carrying `no-merge-hold`,
`do-not-merge`, or `merge-agent-skip`, matching enforced merge-action holds.
`no-merge`, `no-auto-merge`, `hold`, and pipeline-owned state labels remain
countable. Engage/disengage and spill logs include `held: N`, read once per
armed lane plan and reused for that tick. An unreadable held count logs a
specific warning and `held: unknown` without disabling depth pressure.

Depth uses the existing `ADVERSARIAL_REVIEW_REVIEWER_WORKER_CLASS_FALLBACK`
list (default `['codex', 'claude-code']`). Age uses the original cross-model
reviewer replaced by Gemini. Entitlement, quota and writer-diversity checks
apply to both triggers.

### The unit: what "queue depth" counts

Depth counts open PRs awaiting admission for either a first pass or a requested
re-review (`pending` or `pending-upstream`). It excludes drafts, operator holds,
malformed and Argus-only rows, and reviews already running. Genuine posted-pass
evidence distinguishes the two populations; a posted review on the current head
excludes a requested re-review. The first-pass stall pager retains its existing
undelivered-review count. The CLI and both spill lanes use
`countOpenPrsAwaitingReview` / `SQL_COUNT_OPEN_AWAITING_REVIEW`.

Draft evidence is persisted from subject discovery in `reviewed_prs.is_draft`.
No new configuration key is needed.

### Individual wait bound

At every shared drain (poll and capacity-freed, also used by startup polling),
the pool evaluates each candidate in its live admission order. A Gemini-primary
candidate past 480 seconds for a first pass or 900 seconds for
a re-review is evaluated for cross-model spill even when Gemini seats are free.
The existing `ADVERSARIAL_REVIEW_FIRST_PASS_REVIEW_MAX_WAIT_SECONDS` and
`ADVERSARIAL_REVIEW_REREVIEW_MAX_WAIT_SECONDS` overrides apply; zero disables
the corresponding age trigger. The current head's durable wait marker wins over
historical discovery timestamps.

Age pressure shares each lane's per-tick budget and reservation/refund accounting.
When depth grants no slots, age permits one escape slot per lane per tick.
A refused candidate refunds its slot before the next candidate is evaluated; a
full overall pool does not prepare spills it cannot admit.
Argus keeps its seats; PR reviews spill to independent reviewer capacity.
Pipeline candidates that still require Gemini retain their seat requirements.
`review-wait-decision` records one decision per overdue candidate per drain,
including the reviewer/account or the blocking reason.

## Arming it

Prefer the env var — it needs no shared-config edit:

```sh
# in the watcher's launchd environment
AGENT_OS_WATCHER_FIRST_PASS_REVIEW_QUEUE_DEPTH_FAILOVER_THRESHOLD=18
```

then bounce the watcher (adversarial-review daemons do **not** hot-reload).

> **Before writing this key into the shared top-level `config.yaml`**, land the
> companion entries in the Python (`platform/agent-os-config`) and shell
> (`modules/worker-pool/lib/agent-os-config-loader.sh`) schemas. Those loaders
> are strict: a loader that does not know the key crash-loops its daemon. The env
> var above has no such dependency — it is resolved from this repo's Node schema
> and needs no YAML entry at all.

## Verifying / observing it

```sh
npm run review-queue-depth            # human
npm run review-queue-depth -- --json  # machine
```

Prints live depth, threshold, armed/engaged state, graded spill slots, and the
cost ledger. The CLI opens the database read-only. Legacy snapshots missing
schema fields report unknown depth (`depth: null` and `depthError` in JSON),
leave spillover disengaged, and identify schema convergence by the owning watcher
as the required action; the diagnostic never migrates the database.
The durable report is `data/review-queue-depth-failover.json`; it
keeps independent `lanes["first-pass"]` and `lanes.rereview` engagement state,
transitions, and current-engagement cost, with top-level fields retained as a
compatibility summary. Top-level `engagementSpilloverReviews` is the live
net engagement count across lanes (spill admissions minus refunds), unlike the
historical snapshots of the same name in `transitions[]`.

Log lines (stable, greppable prefixes):

```
[watcher] review-queue-depth-failover engage pass_kind=… depth=… threshold=… spill_slots=… engagement_spillover_reviews=…
[watcher] review-queue-depth-failover disengage pass_kind=… depth=… threshold=… spill_slots=… engagement_spillover_reviews=…
[watcher] review-queue-depth-failover rereview threshold inherited from first-pass=…; both lanes may spend separate spill slots
[watcher] review-queue-depth-spillover repo=… pr=… from=gemini to=codex pass_kind=… depth=… slot=1/2 total_spillover_reviews=…
[watcher] review-queue-depth-wait oldest_first_pass_age_ms=… first_pass_waiting=…
[watcher] review-queue-depth-spillover-refund repo=… pr=… pass_kind=… reason=pool-admission-deferred remaining=…
[watcher] review-queue-depth-route repo=… pr=… from=… to=… reason=…
[watcher] review-worker-class-fallback repo=… pr=… from=… to=… reason=queue-depth-pressure queueDepth=… queueDepthThreshold=…
[watcher] review-worker-class-fallback quota-status timing duration_ms=… attempts=… outcome=…
[watcher] review-worker-class-fallback-fail-open repo=… pr=… source=quota-status error=…
[watcher] poll-cycle timing source="…" ok=… timed_out=… duration_ms=…
```

`oldest_first_pass_age_ms` measures time since creation of the oldest queued
first-pass candidate in that drain (zero when none is present), rather than time
since its last enqueue. Compare the live engagement count with spills minus
refunds when verifying cost accounting.

## Disarming it

Unset the env var (or set the CFG key back to `null`) and bounce the watcher.
There is no drain step: the lever holds no state that outlives a tick, and depth
recovery already returns review to `agy` on its own.

## Invariants that hold regardless of depth

- **Writer diversity.** A class-X PR is never first-pass reviewed by class X,
  even when that is the only way to satisfy the depth. The check routes through
  `isCrossModelReviewWaived` in the github-pr routing adapter, so it is
  writer-*family* aware — a `clio-agent` PR (whose writer is codex) will not draw
  a `codex` reviewer, which a naive worker-class string compare would have
  allowed.
- **Entitlement + quota.** A fallback class is only selected if its GitHub
  reviewer bot token is present *and* its provider has quota. Spilling onto a
  class that cannot boot converts a slow queue into a stalled one.
- **One shared reviewer quota read per poll.** AFH grounding and worker-class fallback
  share one `hq fleet quota status --json` result throughout discovery,
  admission and posted-review handling, even when a poll exceeds 60 seconds.
  The next poll refreshes it. The shared read retries a transient subprocess
  failure once after 250 ms, with a quarter of the initial timeout; permanent
  errors are not retried. A failed refresh can select AFH's last good provider
  evidence only when it is at most ten minutes old at refresh time. That selection
  stays pinned for the rest of the poll and for capacity-freed refills using its
  contexts until the next poll replaces them; ten minutes is not a wall-clock
  reuse deadline. Managed account evidence remains held throughout stale reuse.
  Stale snapshots expose quota failure status without stdout to worker-class
  fallback, and quota exec consumers receive the original subprocess error,
  including its code, killed flag and stderr. They cannot admit a managed account
  from cached stdout. With no usable snapshot, routing keeps its existing
  fail-open behavior for the whole poll.
- **The quota trigger is unchanged.** A quota-grounded primary still fails over
  at any depth, and does not consume the depth budget. The two triggers compose.
- **The pool ceiling is untouched.** More concurrent `gemini` reviewers contend
  for the same provider capacity; that is the ceiling this lever escapes, not one
  to raise.

Discovery defers the posted-review SQL lookup until an engaged depth lane needs classification or the subject reaches pool admission. Early held/skipped subjects with no engaged depth lever do not pay that query cost.


## Startup and quota observability (STARTADMIT-01)

After repository scope is refreshed, the first poll prepares domain/repo policy
contexts and refills durable pending rows before per-subject discovery. This
uses the same bounded refill and admission drain as capacity-freed handoffs.
Live subject checks, operator holds, draft checks, credential limits, claim CAS,
same-head deduplication and spawn-boundary freshness still apply. A route change
must acquire the new route's reservation before spawning.
Wake payloads are read when admission or discovery uses a context, after
lifecycle/session recovery, rather than while constructing it. Drain state is
re-read after recovery and again at admission, so a drain cleared during
recovery allows startup refill in that same poll.
Discovery owns separate per-repository PR collections for stuck-merge-agent
scans and phantom-handoff reconciliation; durable refill does not add records
to those collections when it processes the same PR.

`watcher first reviewer spawn: startup_to_spawn_ms=<milliseconds>` records the
first actual runtime spawn since watcher process start. Each poll logs
`quota-status reads per poll: poll=<sequence> reads=<count>`; an idle poll can
report zero. The count includes actual subprocess attempts, so a transient retry
can report two. Refusals do not count as reviewer spawns.

After deployment, the SRE session confirms that the watcher restarted. With a
normal backlog, confirm the first spawn occurs within about a minute and the
posted-review phase stops logging `budget insufficient` under a normal queue.
