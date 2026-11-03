# WATCHERANONBUCKET-01

A throttle floor never exceeds the observed bucket limit. Header observations
now record `x-ratelimit-limit` as the bucket's `limit`. `githubBudgetFloor`
caps the configured floor at 10% of that limit, and never below 1, so a zero
balance still defers. The anonymous 60/h quota therefore admits at remaining 58
instead of deferring until every reset. Async preflights, the synchronous gh
read and the watcher's low-budget closing shortcut share the effective floor.
A bucket with no recorded limit keeps the configured floor. An unknown bucket
admits.

`GitHubBudgetDeferredError` now carries `credential` and names the bucket key
in its message, with the remaining balance, limit and effective floor. Operators
can tell an anonymous `default` deferral from a genuinely low `token-<digest>`
or `adapter:<selector>` bucket. The un-scoped throttle status file records the
credential too.

`test/watcher-anonymous-bucket-floor.test.mjs` replays the deployed watcher
composition: real `@octokit/rest` with only fetch replaced, both
`GITHUB_TOKEN` and `GH_TOKEN`, the broker signal, adapter reads, and an
anonymous `core` 58/60 observation beside healthy authenticated buckets.
Intake discovery and reviewer-side reads proceed. See
[`docs/data-model/github-rate-limit-state.md`](../../docs/data-model/github-rate-limit-state.md).
