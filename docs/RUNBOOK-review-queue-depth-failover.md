# RUNBOOK — queue-depth failover for first-pass review (RSP-01)

A **break-glass lever**. It is disarmed on every host until an operator arms it,
and arming it is one config value.

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
shares its graded per-tick budget across drains. Depth re-evaluation suppresses
the separate burst-pressure trigger, so a depth spill spends only depth budget.
A candidate refused by a later gate, or deferred by pool admission, refunds its
reservation. A pool deferral uses reason `pool-admission-deferred`, restores the
preferred route, and can be re-evaluated in a later drain. Spill and refund route
changes refresh cross-model waiver metadata before spawn.

## This is a cost lever, not a parallelism knob

`agy` is serialized on purpose: it is cheap, and keeping review on it preserves
provider quota for the work that ships code — builds and remediations. Every
other reviewer class parallelizes **and spends that same quota**. So the
threshold is not "how much parallelism do we want". It is:

> the depth at which a backlog becomes expensive enough to justify spending build
> quota to clear it.

Consequences, all enforced in code:

- **Conservative by default.** Unset = disarmed = behaviour identical to before.
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
inherits the first-pass threshold; `0` disables only re-review spillover. Its
depth is open PRs with a completed, posted reviewer pass (`pass_kind` in
`first-pass` or `rereview`) and a durable `rereview_requested_at` wake (or
cleared `posted_at` after a head refresh) still awaiting admission. Only
`pending` rows without a completed posted pass on the current head count.
Rows already in `reviewing`, failed, awaiting an artifact, posted, or paused by
the review-cycle cap do not count. When the re-review threshold inherits the
first-pass threshold, the watcher logs that the lanes can spend separate spill
slots.

The classes it may spill to are the pre-existing
`ADVERSARIAL_REVIEW_REVIEWER_WORKER_CLASS_FALLBACK` list (default `['codex']`)
— this ticket did not introduce a second roster. `claude-code` is intentionally
not the default spillover class because the airlock launchd reviewer path cannot
bootstrap Claude's audit session reliably; operators can still opt it in with
the env override after proving that lane healthy.

### The unit: what "queue depth" counts

Depth is **open PRs that have never received a first-pass review**, read from the
existing `countOpenPrsAwaitingFirstPassReview` in `review-state-db.mjs` — the
same number the review-stall pager already reports. Defining a second, slightly
different "queue depth" beside it would give you two numbers that disagree during
exactly the incident where you read both. Its predicate:

- `pr_state = 'open'` (merged/closed PRs are not waiting for anything), **and**
- no completed `reviewer_passes` row with `pass_kind IN ('first-pass',
  'rereview')` and a non-empty `gh_comment_id` — GitHub-artifact evidence that a
  review really landed, deliberately preferred over `reviewed_prs.posted_at` /
  `review_status`, which are maskable by a stale success claim and are reset on
  re-entry, **and**
- `review_status NOT IN ('malformed', 'unroutable-bot-author',
  'argus-security-queued')` — work the dispatch loop explicitly refuses and no
  number of reviewers can drain.

Two things worth stating explicitly, because they decide what threshold to pick:

- **It counts first passes that are currently in flight.** A PR being reviewed
  right now has still never received a review. So the count cannot fall below the
  number of *first-pass* reviewers in flight, and a threshold at or under the
  first-pass pool ceiling (default 6, max 12) could be satisfied by a
  saturated-but-healthy pipeline and pin the lever on. Set it meaningfully
  **above** the pool ceiling.
- **It does not mix re-review churn into first-pass depth.** Re-reviews have a
  separate depth and budget, so a saturated re-review lane can spill without
  consuming the slots reserved for PRs still awaiting their first review.

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
cost ledger. The durable report is `data/review-queue-depth-failover.json`; it
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
- **Quota freshness is bounded.** Within one watcher tick, reviewer worker-class
  fallback shares `hq fleet quota status --json` results for 60 seconds. That
  includes fail-open probe errors, which are reused only for that same bounded
  window and emit `review-worker-class-fallback-fail-open` per affected PR.
- **The quota trigger is unchanged.** A quota-grounded primary still fails over
  at any depth, and does not consume the depth budget. The two triggers compose.
- **The pool ceiling is untouched.** More concurrent `gemini` reviewers contend
  for the same provider capacity; that is the ceiling this lever escapes, not one
  to raise.
