# Data Model — Explicit Re-review Intents

**Owner:** watcher review dispatch

**Store:** `data/reviews.db`, table `explicit_review_intents`

**Source:** `src/explicit-review-intent.mjs`, `src/review-state.mjs`

RETRIGGERDEDUP-01 adds this table during existing review-store initialization.
Accepted label events, CLI requests, rescue `rereview` decisions and remediation
rereview requests record a receipt in the same immediate transaction as the
review reset. Existing actor/provenance checks remain at request boundaries.

| Columns | Contract |
| --- | --- |
| `repo`, `pr_number`, `request_id` | Primary key. Replaying the request cannot reset or dispatch it again. |
| `head_sha`, `actor`, `requested_at` | Immutable request scope, requester and acceptance timestamp. |
| `expires_at` | Acceptance plus the existing rereview dispatch wait bound: 900 seconds by default, configurable with `ADVERSARIAL_REVIEW_REREVIEW_MAX_WAIT_SECONDS`. A disabled queue wait falls back to 900 seconds for intent expiry. |
| `state` | `pending`, `consumed`, `refused`, or `coalesced`. |
| `settled_at`, `reason` | Consumption/refusal time and refusal reason; coalesced receipts name the original request in `reason`. |
| `reviewer_session_uuid` | Consuming review claim, set only by the claim/head/session CAS. |
| `notified_at` | Successful visible refusal delivery; null retains notification debt across restart. |

A partial unique index permits one pending receipt per `(repo, pr, head)`.
Concurrent requests coalesce without extending the deadline. Receipts remain
for request idempotency; there is no automatic retention sweeper.

The watcher checks expiry before credential and admission holds. An exact-head
unexpired receipt permits one dispatch through reviewed-head dedup. The existing
head lease, durable reviewing claim and normal rereview ceilings still apply.
Consumption occurs immediately before runtime dispatch under a SQLite write
lock. Earlier capacity deferrals preserve the pending receipt and pending row.

Head movement, terminal PR, exhausted ceiling or elapsed dispatch deadline
refuses the request and posts a visible reason. Failed delivery retries across
restart. Consumed/refused receipts cannot authorize another dispatch.
Runtime dispatch failure moves the consumed receipt to refused and reports it
visibly; it never rearms that request.
Without an explicit `--head-sha`, the retrigger CLI resolves the live GitHub head
before using an empty-response cache fallback. Lookup failures refuse the request
without minting an intent. Explicit head requests retain their existing binding.

The fresh review records an observed `live-pack-edit-approved` waiver in its
body even when the live-pack evaluation throws, but only if guarded pack paths
were actually waived. Historical findings and normal merge eligibility remain unchanged.

Activation requires the watcher restart at deploy. SRE retains the next organic
unchanged-head request's fresh-review and intent-consumed log receipt within the
dispatch bound, or its visible refusal. Worker validation uses temporary stores.
