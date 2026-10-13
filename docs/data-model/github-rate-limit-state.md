# Data Model - GitHub Rate Limit State

**Owner:** shared GitHub request throttle
**Store:** `data/api-cache/rate-limit-state.json`, overridden by
`GHO_RATE_LIMIT_SHARED_STATE_PATH`
**Source of truth:** `src/rate-limit-throttle.mjs`
**Runtime surfaces:** `src/metered-gh.mjs`, `bin/metered-gh.mjs`,
`src/runtime-status.mjs`

The shared JSON document has `version: 1` and a `buckets` object keyed by
normalized GitHub resource names (normally `core` and `graphql`). Each bucket
contains `resource`, non-negative `remaining`, ISO `resetAt` and `observedAt`,
and optional positive `rateLimitedCalls`. The counter belongs to that resource's
reset window; a new window starts a new counter. Expired observations are
discarded on reads. Legacy single-observation documents remain readable.

Writes hold the adjacent `.lock` directory, sync a temporary file and rename it
over the store. Concurrent responses for the same window retain the lowest
remaining count and increment rate-limited counters under the lock.

When a rate-limited call provides no usable response headers,
`recordRateLimitedCall` retains the active resource window and increments its
counter. If that window is absent or expired, it creates an observation with
`remaining: 0`, `observedAt` equal to the local clock and a conservative reset
60 seconds later. This fallback is local backpressure evidence, not a measured
GitHub reset. Concurrent first failures reuse the window under the same lock.
Other resource buckets remain independent.

GitHub budget deferral applies to GitHub I/O. Local operator-alert enqueueing
and non-GitHub alert delivery continue during deferred or rate-limited ticks.
