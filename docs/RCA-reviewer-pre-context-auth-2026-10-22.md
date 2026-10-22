# LAC-2082 — reviewer bot 401 before required context capture

Severity: SEV2. Incident evidence: 2026-10-22 14:02 UTC.
Source fix and synthetic validation do not establish deployment or live recovery.

## Impact and evidence boundary

[LAC-2082](https://linear.app/laceyenterprises/issue/LAC-2082) records agent-os
#8922 and #8931 parked `pending-upstream` with `github-auth-outage`, failing
`gh` required PR-context GraphQL capture with `Bad credentials (HTTP 401)`.
Their last attempts were 13:58:13Z and 13:53:39Z respectively. Initial reviews
on #8935/#8936 had the same pre-context failure. #8934's provider quota outage
is separate. Operator GitHub reads worked, which says nothing about the
reviewer's selected bot credential. These observations come from the dispatch
and its read-only rescue evidence at `/private/tmp/os-rescue-20261022-131950`;
this source worker did not rerun or take ownership of those PRs.

Before editing, the worker read the ticket and comments, both owner runbooks,
and [the 2026-09-07 token-refresh RCA](INCIDENT-2026-09-07-reviewer-token-refresh-silently-disabled.md).
HCP memory searches for reviewer 401/broker-refresh and then GraphQL/cache-remint
returned available with zero records. Linear shared-context lookup returned
`Tool get_agent_context not found`; it is unavailable evidence, not evidence of
no prior incident.

## Source ownership and causal chain

The provisioned source base is adversarial-review
`98879da99e3ff0eadcfef30bfbbe73488b6e1759`. The configured host checkout
`/Users/airlock/agent-os/tools/adversarial-review` reported the same HEAD and no
local modifications to `reviewer.mjs`, `reviewer-broker-refresh.mjs` or
`github-api.mjs`. The start script points there. This verifies on-disk source,
not loaded process code: process inspection was denied (`ps`: Operation not
permitted), and no active service was restarted or changed.

1. The startup wrapper enables per-role broker flags. Watcher tick preflight
   refreshes reviewer tokens against real expiry and a subprocess handoff floor.
   This contains the earlier 2026-09-07 flag-wiring defect, but does not prove
   GitHub still accepts a token before its advertised expiry.
2. The local AgentRuntime composes cli-direct, which copies `process.env` into
   the reviewer child. Its model-OAuth stripping does not remove reviewer broker
   flags, routing, expected IDs or the broker-secret file path. Tokens in this
   snapshot cannot be repaired by a later parent refresh.
3. `reviewer.mjs` pinned the selected token into both GitHub env variables, then
   called `fetchPRContext` before model execution. The optional adapter can fall
   back to `github-api.mjs::fetchGraphqlReviewContext` →
   `runGraphqlWithTelemetry` → `execGhJson`. That executor retries transport
   failures, but rejects 401 immediately. It never reaches `gh-cli.mjs`'s
   watcher-token refresh hook. Using that hook here would refresh the wrong
   role (normally merge-agent).
4. Required-context failure exited the child before its separately implemented
   review-post auth refresh. No amount of retry logic limited to posting could
   repair this first read. Settlement already correctly holds the 401 as an
   outage without consuming a review attempt, so natural retries could repeat
   the same stale credential rather than converge.
5. `resolveReviewerAppToken` previously requested `/token?provider=...` without
   broker cache invalidation. The broker source owner, Agent OS
   `platform/oauth-broker/src/oauth_broker/server.py::token/_serve_token`, reads
   `force=1` and passes it to `cache.get(..., force=force)`. This was verified
   read-only in the host Agent OS checkout at
   `bfd00e5af4e017c57a9ed47b59c4d6807ba2f972`. Re-fetching a cached rejected token
   is not a remint. No broker source change is required.
6. The broker's `providers/github_app.py::_fallback_pat_token` can stamp a
   configured PAT fallback with the same App/installation IDs and
   `credential_source=github_pat_fallback`. The canonical reviewer route now
   rejects that evidence explicitly, including periodic reviewer refresh and
   posting resolution. This is a verified source capability, not evidence that
   the incident used a PAT fallback. Other broker roles retain their policy.

This establishes a source recovery gap for an expired or rejected selected
token. It does **not** establish whether the incident token expired, was revoked
early, or whether an App key/installation was revoked. No credential bytes or
live authenticated broker request were collected to guess that distinction.

## Bounded fix and preserved contracts

Required context capture now delegates from `reviewer.mjs` to the leaf
`reviewer-context-auth.mjs`, keeping the existing reviewer decomposition bound.
It pins the explicit dispatch-selected bot and
refuses a missing token before GitHub access. A GitHub authentication rejection
permits exactly one selected-role broker resolution only with that role's
broker flag enabled. The canonical resolver accepts `force: true` and sends
`force=1` to the broker. Provider and configured App/installation pins remain
mandatory checks on the response. Candidate resolution is isolated until the
token differs from the rejected token and has known future expiry. Only then
does it replace and re-pin the selected token in the child.

The retry restarts context capture rather than mixing partial comment pages
from two passes. A second authentication rejection, broker failure, invalid
metadata, unchanged token or expired/unknown-expiry replacement stays an auth
outage. The existing outage settlement and scheduling gates retain ownership,
claim CAS, budgets, terminal-PR guards, cross-model routing and exact-head review
attribution. A posting auth refresh also uses the same canonical forced broker
request, retaining its separate retry bound. No new configuration key, durable
state, lifecycle transition, CI job or merge authority is introduced.

## Regression and rollout evidence

`test/reviewer-context-auth.test.mjs` exercises the real GraphQL context reader
with synthetic GitHub 401 and broker responses for Claude, Codex and Gemini.
It verifies selected provider/force routing, both GitHub env pins, untouched
sibling tokens, successful context head preservation and exact-head posting
with the replacement. Negative cases cover repeated 401, static/missing tokens,
wrong provider/App/installation, unchanged and expired/unknown-expiry replacements,
PAT fallback with matching App IDs,
broker authorization rejection, ordinary 403/404, provider quota and partial-page
restart. Existing token-refresh, posting, identity-pin and outage-budget suites
cover sibling sites and the established automatic hold behavior. The change is
deterministic; no probabilistic concurrency mechanism is introduced.

Validation commands and results are linked on LAC-2082 with the published source
PR. Final scoped validation (context auth, broker refresh, reviewer, reviewer
fence, GitHub-auth outage budget, identity pins, ARC-10 decomposition and SMV)
passed **329/329** tests. The earlier focused run including the unchanged
watcher claim-loop suite passed **408/408**. Lint passed with zero errors;
contract typechecking and the byte-equivalence research demo passed.

The full `npm test` attempt hit its built-in 900-second bound after reporting
12,728 tests. It exposed the reviewer size limit and three posting fixtures
whose old URL expectations needed `force=1`; all four now pass in the final
scoped run. `hamclose-ownership.test.mjs` also ended with a pending-Promise
cancellation, and full-suite completion remains unproven. That ownership code
and suite were not changed or taken over. No full-suite green result is claimed.

Merge still requires normal cross-model convergence and green checks;
this worker does not merge or deploy it. After normal deployment, record a
naturally scheduled reviewer attempt that fetched required context and posted
under its selected bot identity, including session, reviewed SHA, review ID,
login and `commit_id`. Until that evidence exists, live recovery is unproven.

If mint evidence proves a revoked key, the operator action is to rotate that
same reviewer's App signing key through its existing secret source. A suspended
installation requires organization-owner unsuspension; a removed installation
requires reinstalling the same App on the affected repository and reconciling
changed installation IDs with the broker and expected pins through normal
deployment. Follow [the owner runbook](RUNBOOK-gemini-reviewer-app.md#required-pr-context-reads-lac-2082).
There is no source workaround for revoked authority. No operator credential
substitution, live DB edit, review reset/retrigger, worker cancellation, role pin,
deployed edit, service restart or manual/admin merge was performed.
