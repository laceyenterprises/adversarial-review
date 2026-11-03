# SEV3: authenticated GitHub reads deferred by the anonymous budget bucket

Ticket: LAC-2075 (recurrence; root rescue LAC-2132). Date: 2026-11-03.
Status: source qualification only. Review, exact-head CI, merge, deployment,
loaded acceptance and natural intake acceptance remain separate gates.

## Impact

A new watcher started at 08:45:41 UTC (PID 7439), and a new follow-up daemon
started at 08:45:31 (PID 99849). Both loaded the deployed adversarial-review
`c723` / parent `57c` build. Every poll then logged
`Failed to fetch PRs for <repo>: GitHub core budget deferred until
2026-11-03T09:56:43.000Z` for each watched repository. The previous cycle had
deferred until 08:46. At 09:12, agent-os PRs 10169, 10170 and 10171 and
adversarial-review PR 1702 existed publicly with no native review row or pass
row. Root evidence: `/private/tmp/os-rescue-20261103T054752Z/watcher-tail-0916.txt`.
Root rescue reported at 09:59 that the bucket reset at 09:56:43 did not clear
the condition. Poll 16 again deferred every repository, this time until
10:56:54, and none of the six open PRs had a native `reviewed_prs` row or pass
row. Waiting for the next reset does not restore intake.

## Confirmed

- **Anonymous bucket.** The deployed `data/api-call-log/2026-11-03.jsonl` has
  34 `rate_limit_throttle_seconds` rows. The recent ones are
  `credential=default`, `resource=core`, `remaining_at_activation` 57–59 and
  `floor=200`. Their `reset_at` values are 08:46:34, 09:46:13 and 09:56:43, and
  each is about an hour after that window's first activation. The watcher's
  09:56:43 deferral matches the `default/core` reset in those rows and in
  `rate-limit-state.json.throttled.json` (remaining 58, started 09:16:47).
- **Source defect.** GHSCOPE-01 keyed the throttle, `metered-gh` and the watcher
  Octokit hook by credential. Several outer wrappers still called
  `awaitThrottleIfNeeded()` with no credential, which means the `default`
  bucket, and recorded response headers without a credential. Those wrappers
  were watcher intake discovery (`github-pr` subject adapter `withApiTelemetry`),
  the watcher's own `withApiTelemetry`, `execGhJson` (read preflight plus
  success and error header parsing), the `github-api` adapter-read wrapper,
  comment dedup lookup and comment write, review-body capture, the live PR
  lifecycle lookup, and the raw-blob diff fetch. In a scoped poll, a
  `default/core` balance below the floor therefore deferred authenticated
  requests whose own budget was healthy or unknown.
- **The watcher's own token was not shown to be low.** In the same polls,
  credential-keyed `gh` children completed (8 and 6 per poll). The token-keyed
  low-budget closing shortcut did not fire. At 09:18:09 the persisted state held
  one authenticated bucket, `graphql` with 4,862 remaining, and no
  authenticated `core` bucket below the floor.
- **Offline reproduction.** `test/github-budget-credential-scope.test.mjs`
  uses disposable fake tokens and an isolated state file. All eight scenarios
  fail on `origin/main` and pass with this fix.

## Unproven

- **Source of the 60-limit `default` observations.** A balance of 57–59 in
  hourly windows is consistent with GitHub's unauthenticated per-IP quota. The
  candidates are a 401 from an expired token recorded without a credential by
  one of the wrappers above (LAC-2151 saw 401s after a token expired during a
  throttle sleep), or a request that genuinely sent no token. The telemetry rows
  carry no PID or request identity, so attribution would need credential or
  process inspection. That was not done, and no secret was read.
- **Actual quota exhaustion.** No evidence shows that any authenticated token
  ran out of `core` quota during the incident, and this report does not claim
  that none did.
- **The missing persisted bucket.** By 09:18 the persisted state no longer
  contained the `default/core` bucket, but sleeping processes still held it in
  memory. This was not investigated.

## Repair

Each preflight and header observation now names its sending credential. The
contract is recorded in
[github-rate-limit-state.md](../data-model/github-rate-limit-state.md).

- `gh` paths use `githubCredential` over the env they send.
- Octokit wrappers use `GITHUB_TOKEN`.
- Adapter reads use the new `githubAdapterReadCredential`. It is extracted from
  the label executor's existing derivation: a bound `--pat-env` token, otherwise
  `adapter:<selector>`.
- Comment writes use the selected bot token. They never use the parent's
  operator `GITHUB_TOKEN`.

The change adds no new throttle layer. The floor (200), the urgent-scope
reserve, zero-balance deferral, fail-closed review gates, exact-head
publication and identity attribution are unchanged. Requests that send no token
still use `default`.

**Deferred sibling.** The pre-write preflight in `reviewer.mjs`
`postGitHubReview` still calls `awaitThrottleIfNeeded()`, which uses the
`default` bucket. Open PR 1702 (LAC-2151) inserts its write-boundary hook on the
next line, and its regression anchors that exact text. Editing the line here
would conflict with that PR and break its test. Once PR 1702 merges, a one-line
follow-up should pass `githubCredential({ token })`. Until then, an unscoped
review post can still wait on the anonymous bucket. Reads after the review is
generated, such as `fetchPullRequestHeadAndState`, go through the repaired
`github-api` paths.

## Recursive-recovery rationale

This is the recovery exemption in Agent OS
`docs/RUNBOOK-convergence-loop-merge-rules.md`. The watcher is already broken:
it cannot take in new PRs, so it cannot review this gate-keeper fix through the
ordinary convergence loop. The 2026-05-11 incident set the precedent
(`docs/POSTMORTEM-adversarial-pipeline-down-2026-05-11.md`;
adversarial-review PRs #76 and #78).

The exemption is scoped to this change.

- **What the patch does.** It only repairs credential isolation: which bucket
  each existing preflight and observation names. It does not waive a policy and
  does not refactor anything.
- **Tested restoration.** `recovery replay: the deployed watcher composition
  resumes intake while the anonymous bucket is below the floor` drives the real
  `createWatcherOctokit` (dynamic `GITHUB_TOKEN` provider) into the real
  `github-pr` subject adapter under a poll budget scope, with the witnessed
  `default/core` balance below the floor. On `origin/main` it fails with the
  witnessed `GitHubBudgetDeferredError`. With this patch, discovery sends the
  watcher token and returns. A genuinely low watcher token still defers before
  any request is sent.
- **Who decides.** Root rescue independently audits the source and runs the
  required qualification. It owns exact-head landing and native promotion.
  Every other PR still requires its ordinary first cross-model review. Nothing
  here merges code, restarts a daemon, resets a budget, deletes a lock or
  substitutes a credential.

## Acceptance (not performed here)

This change made no live restart, budget reset, lock deletion, raw DB write or
credential read.

- **Loaded acceptance.** After normal merge and deployment, the runtime owner
  records that the watcher and the follow-up daemon loaded a build containing
  this commit.
- **Natural intake acceptance.** Separately, a later organic poll shows intake
  proceeding for watched repositories, with no `budget deferred` line tied to a
  `default` reset, while the `default` bucket is still below the floor. New PRs
  then receive native review rows.

Source merge, local tests and dispatch do not establish either kind of
acceptance.
