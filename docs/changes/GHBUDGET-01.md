# GHBUDGET-01

## Summary

Lifecycle polling now revalidates PR head/state through authenticated REST
conditional requests. An unchanged response uses a matched ETag/body after a
304 rather than spending primary quota on another full head read. Fresh
responses still own head changes and merged/closed terminal transitions.

Closer identity and hammer merge-precondition reads enter the existing urgent
budget scope. Polling retains its existing floor; an exhausted or explicitly
limited bucket still refuses critical reads. Tokens whose App/installation
identity the broker verified share the same budget key across rotations.

API telemetry identifies its calling consumer and counts actual HTTP responses
separately from logical attempts. Child adapters inherit that consumer tag.
Each poll logs known installation balances and persists deficit episodes,
alerting once after more than 15 minutes below the polling floor. Healthy
observations rearm the alert; restarts retain its receipt.

Synthetic tests simulate 60 unchanged polls: 60 full reads before, one initial
200 plus 59 budget-exempt 304s after (98.3% fewer charged reads for this path).
Live savings require the declared two-hour SRE receipt after deployment.

## Interface changes

Broker installation binding requires positive installation-token source metadata
and both matching configured identity pins. Nested closer scopes preserve parent
fairness accounting on deferral and rate limits without widening parent urgency.
Hammer binary reads immediately defer at zero balance instead of waiting for reset.
The canonical catalog lists the deficit store and installation keys; the unused
fragment is removed. API stats separates HTTP responses and credential bindings
from its legacy logical-call totals.

## Deployment receipt

After deployment, SRE floats this repository, restarts the watcher through the
documented owner path, and retains two natural hours with no zero-balance
deferrals, head-state calls/hour reduced by more than half, and a green-CI
closer-pushed head reaching its closer within one poll window. Retain actual
HTTP/304 counts to distinguish savings from a category change.
The existing `post-merge-verify.json` declaration retains this SRE obligation.

## Verification

CI remediation updates the lifecycle and startup-admission fixtures to serve
the REST pull response used by production polling. An integration fixture
drives `syncPRLifecycle` through an open 200, a matched 304 and a fresh merged
200, checking that only the fresh terminal response finalizes the row.
Polling authors retain the normalized `{ login }` interface.
Closer identity tests now distinguish retryable transport/server failures from
an explicit rate limit: the latter defers further reads at zero balance.

- CI remediation: `bash bin/run-bounded.sh --timeout 600 --tail-bytes 8192 -- node test/run-tests.mjs test/github-api.test.mjs test/watcher-auto-refresh-stale-posted-review.test.mjs test/ghbudget-01.test.mjs test/watcher-claim-loop.test.mjs`: 291 passed on Node 26 after the fresh-main rebase. The initial 180-second claim-loop run timed out; the completed run took 248 seconds.
- Rechecked lint (zero errors, 152 existing warnings), contract typechecking,
  the 91-entry data-model catalog, the offline demo and `git diff --check`.
- `node test/run-tests.mjs test/ghbudget-01.test.mjs test/reviewer-broker-refresh.test.mjs test/api-stats.test.mjs test/rate-limit-throttle.test.mjs test/github-budget-credentials.test.mjs test/github-budget-credential-scope.test.mjs`: 112 passed, offline.
- `node scripts/validate-data-model-catalog.mjs`: 91 entries validated.
- `npm run lint`: zero errors (152 existing warnings).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: byte-stable offline demo passed.
- `git diff --check`: passed. Full-suite validation remains with PR-head CI.
