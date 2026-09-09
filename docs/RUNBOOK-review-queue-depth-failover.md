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

This lever adds the missing trigger: **queue depth**.

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
- no `reviewer_passes` row with a non-empty `gh_comment_id` — GitHub-artifact
  evidence that a review really landed, deliberately preferred over
  `reviewed_prs.posted_at`/`review_status`, which are maskable by a stale success
  claim and are reset on re-entry, **and**
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
- **It does not count re-review churn at all.** A PR with a delivered pass is
  excluded even while a re-review runs for it. Observed here on 2026-09-06: 9
  open PRs and 6 reviewers in flight, but depth `0` — every open PR had already
  been first-passed, so that backlog was re-review, and the lever correctly would
  not have engaged at any threshold.

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
cost ledger. The durable report is `data/review-queue-depth-failover.json`.

Log lines (stable, greppable prefixes):

```
[watcher] review-queue-depth-failover engage depth=… threshold=… spill_slots=… engagement_spillover_reviews=…
[watcher] review-queue-depth-failover disengage depth=… … engagement_spillover_reviews=…
[watcher] review-queue-depth-spillover repo=… pr=… from=gemini to=codex depth=… slot=1/2 total_spillover_reviews=…
[watcher] review-worker-class-fallback repo=… pr=… from=… to=… reason=queue-depth-pressure queueDepth=… queueDepthThreshold=…
```

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
- **The quota trigger is unchanged.** A quota-grounded primary still fails over
  at any depth, and does not consume the depth budget. The two triggers compose.
- **The pool ceiling is untouched.** More concurrent `gemini` reviewers contend
  for the same provider capacity; that is the ceiling this lever escapes, not one
  to raise.
