# Data Model - GitHub Rate Limit State

**Owner:** shared GitHub request throttle
**Store:** `data/api-cache/rate-limit-state.json`, overridden by
`GHO_RATE_LIMIT_SHARED_STATE_PATH`, and `<selected-store>.bindings/<digest>.json`
**Source of truth:** `src/rate-limit-throttle.mjs`
**Runtime surfaces:** `src/metered-gh.mjs`, `bin/metered-gh.mjs`,
`src/runtime-status.mjs`, `src/github-budget-monitor.mjs`, `src/api-telemetry.mjs`

The shared JSON document has `version: 2` and a `buckets` object keyed by
`githubBudgetKey(resource, credential)`. Authenticated keys are
`installation-<app-id>-<installation-id>/<resource>` for tokens whose metadata
positively identifies `github_app_installation` and matches both configured App and
installation pins in the broker client. Broker-verified registrations resolve in the
registering process and, through unexpired owner-checked binding files, in fresh
processes using the same selected store. PAT fallbacks, missing
source metadata and unpinned identities remain token-keyed. Rotated tokens for that
installation share observations. Other authenticated keys remain
`token-<digest>/<resource>` (normally `core` and `graphql`); the digest is the
first 24 hex characters of SHA-256 of the effective token. Raw tokens are never
stored. The `default` anonymous credential keeps bare resource keys. CLI token
selection prefers `GH_TOKEN` over `GITHUB_TOKEN`; Octokit uses the token actually
selected for its request, including dynamic provider tokens.

`data/api-cache/budget-deficits.json` is the watcher's diagnostic episode map,
keyed by installation/credential. Entries contain `since` (epoch milliseconds),
`resetAt` and `alerted`. A low observed balance starts an episode; after more
than 15 minutes it emits one deduplicated alert and persists the receipt.
An observed healthy balance clears it. Expired/unknown buckets do not trigger
alerts or prove recovery; another observed low window retains the same episode
and alert receipt. One watcher owns the atomically replaced
0600 file; it grants no merge authority. Each poll logs one line per known
installation with its resource balances.

`data/api-call-log/<UTC-date>.jsonl` additionally records `consumer` on logical
attempts and separate `github_request` rows with `unit: http_response`,
`requestCategory`, credential, resource, status and `budgetExempt` for 304.
These additive rows count actual metered CLI/Octokit responses; logical
attempts and GraphQL points are distinct units. Older missing consumer fields
mean unattributed. Child adapters inherit `GHO_API_CONSUMER` for correlation.
Broker verification also emits `unit: credential_binding` rows associating a
token digest with its validated `app`/`installation`, so a combined report can
group child env-token requests with the parent's installation. Bindings are
metadata, not HTTP requests or logical attempts.

Every admission preflight and every header observation names the credential
that sends the request (LAC-2075). This includes the outer telemetry wrappers
around a transport that also meters itself. A `gh` subprocess uses the token in
the child environment it receives: `buildGhEnv` passes `GH_TOKEN` before
`GITHUB_TOKEN`, while `buildAllowlistedGhEnv` injects `GITHUB_TOKEN` first.
Watcher Octokit calls use `GITHUB_TOKEN`, which is the dynamic provider's
source. Adapter reads use the token that the watcher broker signal binds through
`--pat-env`; without one they use `adapter:<selector>`. Bot-authored comment
and review writes use the posting bot token. Only a request that sends no token uses the
anonymous `default` bucket; an authenticated request never waits on that bucket
or charges it. A low or zero balance for the sending credential still defers
that request. Ambient `gh` login without an environment token also resolves to
`default`, because the parent process cannot distinguish it from an anonymous
request.

Each bucket contains normalized `resource`, non-negative `remaining`, ISO
`resetAt` and `observedAt`, optional positive `limit` (the bucket's
`x-ratelimit-limit`), optional positive `rateLimitedCalls`, optional
`credential` (omitted for `default`) and optional `credentialSelector` (the
adapter's broker role). When two observations share a reset window, the merged
bucket keeps the newer known `limit`. The counter belongs to that credential/resource reset
window; a new window starts a new counter. Expired observations are discarded on
reads. Version 1 resource-keyed and legacy single-observation documents remain
readable as anonymous observations; they do not throttle authenticated budgets.
When a healthy bucket transitions to zero remaining, a failure without a quota
limit retains the active observation's known `limit`, including when the failure
uses a different or guessed reset. A limit supplied by the failure takes precedence.

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

A throttle floor never exceeds what the bucket can hold
(WATCHERANONBUCKET-01). `githubBudgetFloor` uses the configured
`GHO_RATE_LIMIT_THROTTLE_FLOOR` (default 200), capped at 10% of the bucket's
recorded `limit` and never below 1. The anonymous quota is 60 per hour, so its
effective floor is 6. Without the cap, every anonymous admission sat below 200
until reset and again after the next observation. A bucket without a recorded
`limit` keeps the configured floor. An unknown bucket (no observation) admits.
Async preflights, the synchronous `meteredExecFileSync` read and the watcher's
low-budget closing shortcut all apply the same effective floor. A
`GitHubBudgetDeferredError` carries `credential` and names the bucket key in its
message (`credential=default`, `token-<digest>` or `adapter:<selector>`), with
`remaining`, the limit when known, and the effective floor. The un-scoped
throttle status file (`<store>.throttled.json`) records the same `credential`.
Tokens never appear; only their digest key does.

GitHub budget deferral applies to GitHub I/O. Local operator-alert enqueueing
and non-GitHub alert delivery continue during deferred or rate-limited ticks.
Each async budget scope evaluates the current resource observation independently:
below the throttle floor, ordinary scopes defer immediately, while urgent closing
scopes may use positive remaining capacity. Zero remaining defers both, including
hammer binary reads: they return a budget deferral immediately rather than
sleeping until reset. Nested closer scopes
propagate deferred/rate-limited accounting to their parent even when a caller
swallows the error; urgency remains local to the nested operation. Only
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

## Store ownership (GHSTATEOWNER-01)

The store and its temporary file are written `0600`, so the store is private to
the uid that wrote it. The deployed `data/api-cache` directory may still be
group-writable to several operating-system owners. The shared store therefore
belongs to the uid that owns the file or, before it exists, the uid that owns
its directory. Any other caller keeps its observations in an owner-scoped
sibling, `<store without .json>.uid-<uid>.json` (for example
`rate-limit-state.uid-502.json`), with its own `.lock` and `.throttled.json`.
It never locks, writes or renames over the shared store. A caller whose
ownership check fails with anything other than `ENOENT` also uses its
owner-scoped store, because it cannot prove it owns the shared one. A platform
without uids keeps the single shared store. The uid comes from process and
file metadata, never from a credential, and does not attribute any bucket to
a credential.

Reads classify each store. Only `missing` (`ENOENT`) means no observations.
`unreadable` (`EACCES`, `EPERM` or any other read error) means the observations
are unknown. `malformed` means the document held nothing usable. A
non-owning caller reads its own store and also tries the shared store. A
readable shared store merges conservatively under the rules above, and buckets
stay keyed by credential digest. An unreadable one contributes nothing and is
reported, not treated as empty. Admission then uses the caller's own
evidence: an unknown bucket still admits, and GitHub's own responses record
into the caller's store. A writer never renames over a store it could not read.
`recordResponseRateLimit` and `recordRateLimitedCall` reject with
`GITHUB_BUDGET_STORE_UNREADABLE` (`storeCode` carries the errno) rather than
replace observations they never saw, including active zero-balance holds. A
malformed own store is still replaced by the owner's next write. The caller's
own unreadable or malformed store is warned once per process; the warning
names the path and errno only. A foreign unreadable shared store is the
designed boundary and is reported through status, not logged.

`readGitHubBudgetStoreStatus` (exposed as `githubBudgetStore` in
`runtime-status`) reports `scope` (`shared` or `owner`), `uid`,
`sharedOwnerUid`, the caller's store `{ path, status, code? }` and, for an
owner-scoped caller, the shared store's classification. The rendered status
adds a `GitHub budget store:` line only when the scope is `owner` or a store is
unreadable or malformed. `readGitHubBudgetStatus`, the synchronous
`meteredExecFileSync` preflight (`readGitHubBudgetBucketsSync`) and the async
throttle all use the same resolution.

Owners therefore do not share observations through a store they cannot read.
Cross-owner coordination is limited to a shared store its readers can actually
read. A foreign file already sitting at the shared path is left in place:
each caller keeps using its own owner-scoped store, and status names the
shared store's owner uid. Removing it is an operator decision.

Installation bindings persist in `<selected-store>.bindings/<digest>.json`, where
`selected-store` uses the same GHSTATEOWNER-01 plan as observations: the shared
path for its owner, otherwise the caller's `.uid-<uid>.json` sibling. Only
broker-verified identities are written. Each file contains `{ digest, credential,
expiresAt }`: the 24-character token digest, `installation-<app>-<installation>`,
and epoch-millisecond expiry capped at one hour from registration (or the
broker's earlier token expiry). Files are atomically written `0600`; new binding
directories are created `0700`. Writes prune readable expired digest files.
Raw tokens are never persisted.

Readers reject symlink directories, group/other-writable directories, symlink
files, foreign directory/file owners, malformed identities and expired bindings.
File ownership is checked on the opened descriptor. With no platform uid,
owner comparison is unavailable. Unavailable bindings fall back to token-digest
isolation; registration remains usable in the registering process. Private
bindings are shared across processes of the same uid, not across deployment
uids. Operators can inspect the selected store's adjacent directory and remove
expired files; write-time pruning normally handles rotation cleanup. Missing
bindings are cached for one second per store path and digest (at most 256
entries), so fresh cross-process registrations may take one second to become
visible after a miss. Successful disk resolutions are revalidated on each lookup.
Budget
deferrals retain the last validated ETag and enter the bounded transient-read
path. A missing observation breaks the deficit interval, and an alert receipt
is deduplicated by credential and episode start.
