# Data Model - Reviewer Generated Reviews

**Owner:** hosted reviewer delivery (REVPOSTSTALL-01)
**Store:** `data/reviewer-generated-reviews/`
**Source of truth:** `src/reviewer-generated-review-delivery.mjs` (`createGeneratedReviewDelivery`)
**Runtime surface:** `src/reviewer.mjs` (`main`, `postGitHubReview`)

## Purpose and key

A hosted reviewer writes one record when a model reply passes the posting
contract. The write happens after `review completed` and before
`Review generated`, so it always precedes the pre-post side calls (token
refresh, current-head verdict mode, scope review, head grounding). If delivery
stalls before the GitHub write, the next same-head claim posts this preserved
review through the normal post path instead of rerunning the model.

Files are
`<repo-slug>-<prNumber>-<headSha>-<passKind>-<reviewerModel>-<originSessionUuid>.json`,
where `/` in the repository becomes `--`. Each generation gets its own file, so
a later generation never overwrites the evidence of an earlier one. Without an
exact 40-hex reviewer head, nothing is written.

The store holds model output only. It holds no tokens, broker material,
reattach handles or lease secrets. Attribution is the validated, secret-free
`reviewer-attribution` projection. Files are written atomically with mode
`0600`.

## Reuse binding

A record is reused only when every binding field equals the new claim's value:
`repo`, `prNumber`, `headSha`, `passKind`, `reviewerModel`, `botTokenEnv`,
`reviewAttemptNumber`, `promptStage`, `verdictOnly` and `diffSha256` (the
SHA-256 of the exact diff given to the model). `reviewerModel` and `botTokenEnv`
record the producer that actually ran. An oversized-route fallback that
switched reviewer family therefore never matches the pre-dispatch route.

`rawReviewText` must also match `rawReviewSha256`, and stored attribution must
validate again. Otherwise the record is not reused. Mismatched records are left
in place as evidence. The newest matching reusable record wins.

## Fields

| Field | Shape | Contract |
|---|---|---|
| `schemaVersion` | integer | `1`. |
| binding fields | see above | Exact-match reuse key. |
| `originSessionUuid`, `originReviewDbAttemptNumber` | string, integer or null | The session and launch attempt whose model run produced the review. |
| `generatedAt` | ISO-8601 | When the reply passed the posting contract. |
| `deliveryState` | `pending-delivery`, `deferred`, `write-started`, `delivered` | See lifecycle. |
| `rawReviewText`, `rawReviewSha256` | string, hex | Model reply and its digest. |
| `reviewText`, `needsSanitize`, `chunked`, `elisions` | as produced by dispatch | Replayed through the same sanitize/reply-contract path on redelivery. |
| `execution` | object or null | Original execution metadata; posted review attribution stays with the original run. |
| `reviewerAttribution` | object or null | Validated original attribution; a redelivery posts with this value, never the retry session's. |
| `deferrals[]` | `{sessionUuid, at, phase, elapsedMs, deadlineMs}` | One entry per delivery deadline expiry before a GitHub write. |
| `redeliveries[]` | `{sessionUuid, reviewDbAttemptNumber, startedAt}` | One entry per claim that reused this record. |
| `writeStartedAt`, `writeStartedSessionUuid` | ISO-8601, string | First GitHub write boundary reached for this record. |
| `deliveredAt`, `deliveredSessionUuid`, `deliveryPhases[]` | ISO-8601, string, array | Successful post and the measured pre-write phase timings. |

## Lifecycle

```
pending-delivery --deadline before write--> deferred
pending-delivery|deferred --GitHub write boundary--> write-started
write-started --post and capture returned--> delivered
deferred --same-binding claim--> (redelivery; same transitions)
```

Only `pending-delivery` and `deferred` records are reusable. A
`write-started` record is never redelivered blindly: the earlier write may
have landed, and the existing post reconciliation, capture and watcher
ownership controls own that ambiguity. In that case the next claim runs the
reviewer normally, as before this change. A `delivered` record is never posted
again.

## Persistence and retention

Initial preservation and delivery bookkeeping are best-effort. Once a reusable
record exists, changing it to `write-started` must succeed before the GitHub
write is allowed. A failed checkpoint refuses publication and emits the existing
uncharged `[reviewer-stalled]` marker so the exact-head reply stays recoverable.
A failed `delivered` update leaves the durable `write-started` record non-reusable.
An initially unavailable store with no saved record keeps ordinary delivery. The store is not part of the repository-rename continuity
journal. After a rename the old-slug record no longer matches, and the next
claim reruns the model (fail-closed). There is no automatic retention sweeper.
The reviewer operator archives records after PR closure, keeping records for
open heads.
