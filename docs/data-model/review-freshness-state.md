# Data Model - Review Freshness State

**Owner:** review-freshness liveness alert
**Store:** `data/review-freshness/`
**Source of truth:** `src/review-freshness-detector.mjs`
**Runtime surface:** `src/review-freshness-detector.mjs`, `src/watcher.mjs`

## Purpose

`data/review-freshness/` holds the small filesystem state used by the
adversarial-review watcher to debounce self-pages when the reviewer pipeline is
not publishing reviews while open PRs are still awaiting first-pass review.

The production watcher uses the review database's normalized `posted_at` values
as the primary last-posted-review baseline. These files are only fallback and
debounce state; a per-PR `review_status` value is never trusted as evidence that
a review landed.

## Files

Directory: `data/review-freshness/`

| File | Shape | Contract |
|---|---|---|
| `last-posted-review.json` | `{ "atMs": number, "at": string }` | Cold-start fallback baseline. Written only for a real posted review or to seed the detector when no baseline exists yet. |
| `last-stall-alert.json` | `{ "atMs": number, "at": string }` | Debounce marker written only after alert delivery succeeds. Delivery failures do not update it, so the next tick can retry. |

`atMs` is epoch milliseconds. `at` is the corresponding ISO-8601 UTC timestamp
for operator readability.

## Operational Contract

- The watcher passes `latestPostedReviewAtMs()` from `data/reviews.db` as the
  primary freshness baseline. The filesystem `last-posted-review.json` value is
  consulted only when no primary value is supplied or available.
- Pending work is counted from open PR rows with `posted_at IS NULL`. This keeps
  the page unmaskable: a stale or mistaken `review_status='posted'` cannot hide
  a PR that never received a real published review.
- Missing, unreadable, or malformed state files are treated as absent and must
  never suppress a real stall alert.
- State writes are best-effort. Failure to write `last-posted-review.json` does
  not break review posting, and failure to write `last-stall-alert.json` may
  over-page but must not create silence during an actual stall.
- The files contain no secrets or review content.
