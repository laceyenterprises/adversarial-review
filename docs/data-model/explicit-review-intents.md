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
| `expires_at` | Legacy column name: acceptance plus a load-scaled waiting-notice threshold (900-second nominal, configurable with `ADVERSARIAL_REVIEW_REREVIEW_MAX_WAIT_SECONDS`; zero uses the nominal fallback). It never expires pending intent, including existing rows. |
| `state` | `pending`, `consumed`, `refused`, or `coalesced`. |
| `settled_at`, `reason` | Consumption/refusal time and refusal reason; coalesced receipts name the original request in `reason`. |
| `reviewer_session_uuid` | Consuming review claim, set only by the claim/head/session CAS. |
| `notified_at` | Successful waiting/refusal notice delivery; null retains notification debt across restart. Settlement clears an earlier waiting receipt so the terminal notice can be delivered. |

A partial unique index permits one pending receipt per `(repo, pr, head)`.
Concurrent requests coalesce without changing the waiting threshold. Receipts remain
for request idempotency; there is no automatic retention sweeper.

The watcher observes waiting before credential and admission holds. An exact-head
pending receipt permits one dispatch through reviewed-head dedup regardless of age. The existing
head lease, durable reviewing claim and normal rereview ceilings still apply.
Consumption occurs immediately before runtime dispatch under a SQLite write
lock. Earlier capacity deferrals preserve the pending receipt and pending row.

Head movement, terminal PR or exhausted ceiling refuses the request and posts a visible reason.
Capacity, queue depth and credentials defer it indefinitely for that head. After the
waiting threshold the watcher posts one informational notice and retries every tick. Failed delivery retries across
restart. Consumed/refused receipts cannot authorize another dispatch.
A positively unstarted launch returns its consumed receipt to pending under the
same session CAS and releases the claim without charging a review attempt. A failure
after process start retains the existing consumed/refused behavior.
Without an explicit `--head-sha`, the retrigger CLI resolves the live GitHub head
before using an empty-response cache fallback. Lookup failures refuse the request
without minting an intent. Explicit head requests retain their existing binding.

The fresh review records an observed `live-pack-edit-approved` waiver in its
body even when the live-pack evaluation throws, but only if guarded pack paths
were actually waived. Historical findings and normal merge eligibility remain unchanged.

Before dismissal, the watcher refreshes live PR head/state, reconciles moved/closed
requests even during admission holds, and defers on unreadable state. Discovery
snapshots cannot authorize dismissal against a newer head.
For an open queued or running exact-head intent, the watcher dismisses only configured
reviewer bots' strictly superseded Request changes using the SVD-02 filter. Current-head,
unknown-head and human reviews remain. Dismissal adds no review or merge authority;
exact-head zero-finding attestation, strict mode, leases and hammer gates are unchanged.
The watcher keeps a bounded process-local cache (512 PRs per database handle).
Live probes and failed dismissal retries run at most once per five minutes for
an unchanged request and discovery head. Successful dismissal checks run once
per request/head while cached; periodic live probes still settle moved/closed
requests during holds. A new request, changed discovery head, eviction or restart
permits a fresh check. This adds no persistent columns or lifecycle states.

After the normal float and separately authorized watcher restart, SRE verifies no new
deadline refusals, no superseded bot block on queued remediated heads, and about zero
capacity-related refusal comments over 24 hours. Worker validation uses temporary stores.

LABELREARM-01 also records waiver-observation requests here. `request_id` is
`operator-waiver-observation:` plus the JSON array of current head and sorted
`[label, eventId]` pairs. `actor` retains the corresponding actor logins. The
review row reason is `operator-waiver-observation: <labels>`. Only a latest
delivered current-head review with exclusively registered gated blockers and
live label applications after that review can create this intent. A transaction
rechecks the posted review snapshot before resetting it. Existing receipt
states, wait observation, claim consumption and retention apply without schema changes.

The waiver observer checks cached label presence before sharing the discovery
cycle's asynchronous operator observation. Present labels are reobserved each
cycle to detect new event IDs; accepted intent remains durably deduplicated.
Only newly accepted intent clears lane and alert state. Refused, spent and
already-pending requests preserve both. The observer never requeues an old
stopped job or changes its stop provenance or round budget. Labels applied
before the gated review require removal and reapplication. No store shape or
receipt lifecycle changes are introduced.
