# Controlled burst reviewer capacity lease (RPL-07)

**Source of truth:** `src/reviewer-burst-lease.mjs`, `src/reviewer-burst-cli.mjs`,
and the lease record at `data/reviewer-burst-lease.json`.

## What this is

The steady-state review posture is AGY-first and deliberately cheap: one
serialized Gemini/AGY reviewer, so provider quota goes to the work that ships
code. A **burst lease** is the operator's explicit, short, bounded way to buy
extra review capacity for a demo, an urgent active pack, or a backlog burn-down
— and to have that capacity go away on its own afterwards.

**It is off by default.** With no lease record, every integration point behaves
exactly as it did before RPL-07. There is no config key to arm and no knob to
leave elevated: a burst exists only while its lease record does.

## Quick reference

```bash
# What is the pipeline spending right now?
adversarial-review burst status
adversarial-review burst status --json

# Buy 2 extra reviewer slots for 30 minutes, scoped to one repo and one pack.
adversarial-review burst request \
  --repo laceyenterprises/agent-os \
  --pack app-standup-demo \
  --reason "pack-sprint app-standup-demo" \
  --ttl 30m --slots 2 --budget 20

# ROLLBACK — end the burst immediately.
adversarial-review burst revoke --reason "demo finished"
```

`npm run burst -- status` works too. `burst status` is a pure read and is safe
to point at a live deployed tree.

## What a lease actually changes

Two things, both bounded:

1. **The first-pass reviewer pool ceiling** rises by the granted slots
   (`resolveFirstPassReviewerPoolConfig({ burstSlots })`), then is re-clamped to
   the same system maximum a non-burst host is already held to. Those slots
   exist so the extra reviewers have somewhere to run.
2. **An additional spill trigger** is handed to
   `resolveReviewerWorkerClassWithFallback`. A healthy-but-saturated AGY primary
   is allowed to yield first-pass review to an entitled, quota-available
   fallback worker class for in-scope subjects, with
   `reason: 'burst-lease-pressure'`.

This is the same mechanism the RSP-01 queue-depth lever uses
(`src/review-queue-depth.mjs`); the two levers compose, and depth wins the
attribution when both are live so RSP-01's behaviour — including its reason
string and its own cost ledger — is unchanged by this ticket.

### What a lease does **not** change

It does not raise the Gemini/AGY in-flight cap. AGY reviewers check out from a
shared, typically single-account credential pool; dispatching more concurrent
AGY reviewers than there are credentials just makes them contend on the checkout
lease and lose. The AGY steady slot stays at 1 and stays the default — a burst
buys capacity for the *fallback* classes, which is what
"`fallback_allowed: ... only if AGY soft ceiling trips`" means in the RPL spec's
mockup.

## Bounds

| Bound | Default | Ceiling | Where it comes from |
|---|---:|---:|---|
| Additional slots | 2 | 4 | `--slots`; ceiling `ADVERSARIAL_REVIEWER_BURST_MAX_SLOTS` |
| TTL | 30m | 4h | `--ttl`; ceiling `ADVERSARIAL_REVIEWER_BURST_MAX_TTL_MS` |
| Dollar budget | $20 | $100 | `--budget`; ceiling `ADVERSARIAL_REVIEWER_BURST_MAX_BUDGET_USD` |
| Burst-bought reviews | 6 × granted slots | — | `--max-reviews` |
| Repo scope | **required** | — | `--repo` (repeatable) |
| Pack scope | none (whole repo scope) | — | `--pack` (repeatable) |

A request is clamped to the ceilings, never refused for exceeding them, and the
granted values are what `burst status` reports.

There are deliberately **no `config.yaml` keys**. A lease is operator state, not
configuration, and every new top-level config key is a review-pipeline timebomb
until all three strict loaders (Python `_schema_v1`, this repo's Node
`config-loader.mjs`, and `agent-os-config-loader.sh`) learn it in the same
change — the multi-loader-parity failure that crash-looped the watcher on
2026-07-17. The system ceilings above are read from this process's env.

### The budget guard has two limbs

Only one of them is always measurable, so there are two:

- **Review count** (`maxBurstReviews`) — always enforceable. A lease can only
  buy this many non-primary reviews, counted when a burst-driven fallback
  actually lands on a route (not when one is merely attempted).
- **Observed dollars** (`budgetUsd`) — checked against
  `reviewer_passes.token_cost_usd` for passes started at or after activation in
  the lease-scoped repos. This is the burst *window* cost in the burst *repos*,
  not an attempt to attribute individual passes to the lease; attribution would
  need a per-pass flag nothing writes, and guessing it would produce a number
  that disagrees with the provider bill. The exact unit string is exported as
  `BURST_SPEND_UNIT` and printed in the lease record.

If cost telemetry is unreadable the status prints
`observed_spend: unreadable (review-count cap still applies)` and the lease is
**not** treated as having spent `$0`. An unknown spend never silently passes the
dollar guard.

The dollar figure **trails** real spend, because `token_cost_usd` is written when
a pass ends: every in-flight reviewer is legitimately uncosted. That is why the
review-count cap, not the dollar ceiling, is the limb that *guarantees* a bound.
Read the dollar number as "what has settled so far", not as "what this burst has
committed".

Exhausting either limb ends the lease with an `expired` event.

## Refuse or degrade

A request runs an authoritative safety check once, over three signals:

| Signal | Source | Refuses when | Degrades when |
|---|---|---|---|
| Quota | `hq fleet quota status --json`, filtered to entitled fallback classes | unreadable, or every fallback class grounded/unentitled | some classes grounded — the grant is capped at the classes that can absorb it |
| Posting | review-pipeline health (`reviewer`, `outage`) | ledger unreadable, an active review outage, or ≥50% reviewer failure over the window (≥3 attempts) | ≥25% failure over the window — slots halved |
| Reviewer health | review-pipeline health (`reviewerSlots.states`) | unreadable, or ≥2 `stale`/`impossible` slots | 1 stuck slot — slots halved |

**Quota fails CLOSED here**, unlike the steady-state paths, which fail open to
"keep reviewing on the cheap class". The thing being decided is whether to
*start spending*; an unreadable quota state is not permission to spend.

Scope and reason are hard preconditions checked *before* safety: a request with
no `--repo` or no `--reason` is refused outright. A repo-less burst is the
"hidden global concurrency knob" the RPL spec forbids, and no amount of pipeline
health makes one acceptable.

Continuously, on every routing decision, the watcher re-checks only the cheap
limbs (TTL, scope, budget) — live quota safety is already enforced downstream
for free, because a burst spill still has to pass
`resolveReviewerWorkerClassWithFallback`'s entitled + quota-available test. A
provider that grounds mid-burst stops the spend with no extra probing.

## Decay

Expiry is **derived from the clock on read**, not from a scheduled job. A lease
ends on time even if the watcher is down, the CLI never runs again, and the
`expired` audit event is never written. Nothing has to be running for a burst to
decay; the event is an audit nicety, not the mechanism.

A lease also decays on:

- `review-cap-reached` — the review-count limb is spent
- `budget-exhausted` — observed spend reached the dollar ceiling
- `unreadable-expiry` — a corrupt lease is a decayed lease, never a forever one
- `no-slots-granted` — a lease that somehow holds zero slots

## Duplicate requests

A request made while a lease is active **updates that lease in place**. It:

- keeps the lease id and the usage/spend ledger, so re-requesting just before
  the budget trips is not a free way around the budget;
- extends the TTL from the moment of the update;
- **re-declares scope in full** — repos and packs are exactly what the new
  invocation passes, not a union with the previous ones. The CLI prints a
  `scope re-declared:` line whenever this changes the blast radius.

## Pack scope

A pack token matches a PR when any of these hold (all case-insensitive, and a
token only ever matches a *whole* label or a *whole* ticket id / ticket prefix):

- a PR label equals the token, or equals `pack:<token>` / `pack/<token>`
- the Linear/plan ticket id equals the token (`rpl-07`)
- the **alpha prefix** of that ticket id equals the token (`rpl`) — how a
  ten-ticket pack is named in practice
- a ticket id in the PR title or head branch satisfies either of the above

## Visibility

- `adversarial-review burst status [--json]` — the operator surface.
- `adversarial-review pipeline-health --json` — `snapshot.reviewerBurst`.
- `adversarial-review pipeline-health --prometheus` —
  `review_pipeline_reviewer_burst_active`,
  `review_pipeline_reviewer_burst_slots`,
  `review_pipeline_reviewer_burst_reviews_granted`,
  `review_pipeline_reviewer_burst_ttl_remaining_seconds`.
- Sentinel finding `review:reviewer_burst_lease_active` fires for the life of
  the lease. It is a state annunciator, not a defect alarm: elevated spend that
  is invisible on the operator surface is exactly the hidden knob the spec
  forbids. It clears on its own when the lease decays.
- The lease record itself keeps the last 50 audit events
  (`requested`, `activated`, `denied`, `expired`, `revoked`) and the last 10
  ended leases, so "why did last Tuesday cost $40" is answerable without
  grepping a 245 MB watcher log.

## Rollback

```bash
adversarial-review burst revoke --reason "<why>"
```

Exits `0` on success, `1` if there was no active lease. Capacity returns to the
AGY-first steady state on the watcher's next tick; no daemon restart, signal, or
config edit is involved. If the CLI is unavailable, deleting
`data/reviewer-burst-lease.json` has the same effect — an absent record reads as
"no burst" — though it loses the audit trail, so prefer `revoke`.
