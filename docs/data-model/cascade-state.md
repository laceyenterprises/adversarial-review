# Data Model - Reviewer Cascade State

**Owner:** reviewer transient-failure backoff and route selection
**Store:** `data/cascade-state/`
**Source of truth:** `src/reviewer-cascade.mjs`
**Runtime surface:** `src/reviewer-cascade.mjs`, `src/watcher.mjs`, `src/reviewer-route-selection.mjs`, `src/review-pipeline-health.mjs`

## Purpose

`data/cascade-state/` stores one durable JSON file per GitHub PR that has hit a
transient reviewer-spawn failure. The watcher consults this state before
claiming another reviewer attempt so provider outages, OAuth failures, reviewer
timeouts, and similar infrastructure failures do not burn
`reviewed_prs.review_attempts` or tight-loop on a struggling reviewer lane.

The file is PR-scoped, not reviewer-scoped. Its `nextRetryAfter` value holds
the PR against every eligible reviewer until the exponential backoff window
expires. Model-specific fields exist only to inform routing decisions about a
particular reviewer model once the PR-level hold is clear.

## Files

Directory: `data/cascade-state/`

| File | Shape | Contract |
|---|---|---|
| `<encodeURIComponent(repo)>__<prNumber>.json` | Cascade state object | Durable per-PR transient-failure state. The writer uses tmp+fsync+rename so readers never rely on a torn JSON file. Missing or unreadable files are treated as no cascade state. |

## State Object

| Field | Shape | Contract |
|---|---|---|
| `consecutiveTransientFailures` | number | PR-level consecutive transient failure count, clamped at the cascade failure cap. This drives the `1, 2, 4, 8, 15` minute backoff schedule. |
| `consecutiveCascadeFailures` | number | Legacy cascade-only count. Readers fold it into new counters when old state is encountered; new writes use `consecutiveTransientFailures`. |
| `transientFailureBreakdown` | object from failure class to count | PR-level, reviewer-agnostic failure totals. These counts explain the PR-level hold and remain flat across all reviewer models. |
| `transientFailureBreakdownByModel` | object from normalized model name to failure-class counts | Model-specific failure totals used only for model-specific routing and fallback decisions. These counts must not replace the flat PR-level hold counters. |
| `lastFailureModel` | string or null | Normalized reviewer model from the latest attributed failure, or the prior value when a new failure has no model attribution. |
| `lastFailureClass` | string | Normalized transient failure class from the latest recorded failure. Unknown classes normalize to `cascade`. |
| `lastFailureReason` | string or null | Trimmed diagnostic reason for the latest failure, when supplied. |
| `lastFailureAt` | string | ISO-8601 timestamp used as the failure anchor exposed by health reporting. Unusable input timestamps are replaced with the current time before writing. |
| `nextRetryAfter` | string | ISO-8601 PR-level backoff expiry. This is always computed from the cascade backoff schedule, never from a provider-supplied reset hint. |
| `providerRetryAfter` | string | Optional diagnostic provider reset hint. It is recorded only when supplied, is replaced on each write, and never gates reviewer dispatch. |
| `backoffMinutes` | number | Backoff duration used to compute `nextRetryAfter`. |
| `capExhaustedAlertedAt` | string | Optional debounce marker for a cascade-cap-exhausted alert. |
| `capExhaustedAlert` | object | Optional diagnostic payload containing failure class, attempts, cap, and reason for the cap-exhausted alert. |
| `operatorDecisionAlertedHeadSha` | string or null | Optional per-head debounce key for operator-decision-required alerts. |
| `operatorDecisionAlertedAt` | string | Optional timestamp for the operator-decision-required alert debounce. |
| `operatorDecisionAlert` | object | Optional diagnostic payload for the operator-decision-required alert. |

## Mixed-State Semantics

- Old files may contain only `consecutiveCascadeFailures`. On the next failure,
  the writer treats that legacy value as the existing PR-level count and, when
  no `transientFailureBreakdown` exists yet, folds it into
  `transientFailureBreakdown.cascade` exactly once.
- Files without `transientFailureBreakdownByModel` are valid. Model-specific
  routing reads the attributed count for the selected model plus the flat-map
  remainder not already attributed to any model, so a mixed old/new deployment
  does not erase pre-upgrade failure evidence.
- `transientFailureBreakdown` remains the reviewer-agnostic PR-level hold
  counter. `transientFailureBreakdownByModel` is for model-specific route
  selection only; it must not change the PR-level backoff window.
- `lastFailureModel` is diagnostic and attribution-oriented. A failure without
  reviewer model attribution preserves the prior value instead of inventing a
  model owner for the new failure.
- Each `recordCascadeFailure` write replaces the whole state object except for
  fields explicitly carried forward by the source-of-truth module. A missing
  `providerRetryAfter` on a later write intentionally clears any older provider
  hint.

## Operational Contract

- `shouldBackoffReviewerSpawn` returns a backoff when `nextRetryAfter` is in
  the future. Malformed `now` or `nextRetryAfter` timestamps fail closed and
  keep the PR parked rather than tight-looping.
- `clearCascadeState` removes the per-PR file after a successful reviewer path
  no longer needs the transient-failure hold.
- Operator-alert debounce fields share this per-PR file so alert state follows
  the same durable owner and atomic-write behavior as the backoff state.
- The files contain transient failure diagnostics and no secrets or review
  bodies.
