# Data Model - GitHub Rate Limit State

**Owner:** shared GitHub request throttle
**Store:** `data/api-cache/rate-limit-state.json`, overridden by
`GHO_RATE_LIMIT_SHARED_STATE_PATH`
**Source of truth:** `src/rate-limit-throttle.mjs`
**Runtime surfaces:** `src/metered-gh.mjs`, `bin/metered-gh.mjs`,
`src/runtime-status.mjs`

The shared JSON document has `version: 2` and a `buckets` object keyed by
`githubBudgetKey(resource, credential)`. Authenticated keys are
`token-<digest>/<resource>` (normally `core` and `graphql`); the digest is the
first 24 hex characters of SHA-256 of the effective token. Raw tokens are never
stored. The `default` anonymous credential keeps bare resource keys. CLI token
selection prefers `GH_TOKEN` over `GITHUB_TOKEN`; Octokit uses the token actually
selected for its request, including dynamic provider tokens.

Each bucket contains normalized `resource`, non-negative `remaining`, ISO
`resetAt` and `observedAt`, optional positive `rateLimitedCalls`, optional
`credential` (omitted for `default`) and optional `credentialSelector` (the
adapter's broker role). The counter belongs to that credential/resource reset
window; a new window starts a new counter. Expired observations are discarded on
reads. Version 1 resource-keyed and legacy single-observation documents remain
readable as anonymous observations; they do not throttle authenticated budgets.

Writes hold the adjacent `.lock` directory, sync a temporary file and rename it
over the store. Concurrent responses for the same window retain the lowest
remaining count and increment rate-limited counters under the lock.
An active zero-balance limit whose reset GitHub reported (a `Retry-After` or a
reset header) takes precedence over positive primary-quota observations
regardless of their reset ordering; healthy responses cannot clear that hold
before expiry. A zero-balance window created without any reset evidence carries
`resetUnknown: true` (the conservative default below); its reset is a guess, so
a newer healthy observation for the same credential and resource replaces it.
When both observations have zero balance, the later
reset wins. Rate-limited responses force `remaining: 0` even if GitHub reports
positive primary capacity, and a usable `Retry-After` selects the secondary-limit
reset ahead of the primary reset header.

When a rate-limited call provides no usable response headers,
`recordRateLimitedCall` reuses the active window only when its balance is already
zero, and increments its counter. If that window is healthy, absent or expired,
it creates an observation with
`remaining: 0`, `observedAt` equal to the local clock and a conservative reset
60 seconds later. This fallback is local backpressure evidence, not a measured
GitHub reset. Concurrent first failures reuse the window under the same lock.
Other credential/resource buckets remain independent. The recorded reset is also
returned to the caller's scope so local admission and persisted readers agree.

`readGitHubBudgetStatus` reports all observed compound keys. Its conventional
`core` and `graphql` fields select the active credential from the supplied runtime
environment; missing or expired evidence is displayed as unknown rather than
falling back to another credential's budget.

GitHub budget deferral applies to GitHub I/O. Local operator-alert enqueueing
and non-GitHub alert delivery continue during deferred or rate-limited ticks.
Each async budget scope evaluates the current resource observation independently:
below the throttle floor, ordinary scopes defer immediately, while urgent closing
scopes may use positive remaining capacity. Zero remaining defers both. Only
un-scoped callers share in-process sleep promises; scoped callers never join
another caller's wait or inherit its deferral decision.

Synchronous `meteredExecFileSync` calls use the effective caller environment for
budget reads, the throttle floor, and the `wait`, `record`, and `limited` bridge
processes. Explicit `options.env` budget settings take precedence; missing budget
settings inherit from `process.env`. An isolated caller's observations therefore
stay in its selected store, including failures without rate-limit headers.

The `bin/metered-gh.mjs exec` bridge preserves ordinary command exit codes.
Signal failures use the shell status `128 + signal number`. If the bridge
receives SIGTERM or SIGINT, it kills the active child with SIGKILL but reports
the original interruption as 143 or 130, respectively. Child-originated
signals retain their own status (for example, SIGALRM is 142). Errors without
a numeric exit status or recognized signal fall back to 1.
