# SEV0: false GitHub rate-limit observations stopped the review factory

Ticket: GHFALSEZERO-01. Incident date: 2026-11-14. All times UTC.
This public report uses neutral descriptions and synthetic regression fixtures;
it contains no production identifiers, credential fingerprints or host paths.

The operator declared: "This is a sev0. The whole factory is offline without these reviews".
Polling, reviewing and automated merging across repositories shared the affected
credential budget. The observation was false: recovery measured 5,032 remaining
out of 5,400 in the same reset window. The available evidence establishes neither
an API drain nor abuse. No live state was changed while implementing this fix.

## Timeline

| Time | Observation |
| --- | --- |
| 18:40:07 | Two first-pass reviews start. One diff contains “rate limit” four times; the other contains none. |
| 18:40:11–12 | The reviewer core bucket is recorded as 0/5,400, reset 19:40:02. Both reviewers sleep about 3,589 seconds inside the unscoped throttle, holding both credential slots; two more reviews are deferred. |
| 19:40:02 | Reviewers wake and encounter expired-token 401s. Retained logs show refresh choosing the watcher's role. |
| 19:40:05.9 | A reviewer core request returns 404. The retained HTTP row categorizes it as `other`. |
| 19:40:06.7 | The watcher credential is recorded as zero with reset 20:32:17 and `rateLimitedCalls: 1`. A reviewer sleeps about 3,129 seconds. Polling for every repository is deferred. |
| 19:50:46 | SRE removes the forced-zero entry under its lock, retaining a backup, and restarts the watcher. |
| 19:51:43 | The first real response reads 5,032/5,400, reset 20:32:17. The earlier zero was manufactured locally. |
| 19:54 | SRE terminates the orphaned sleeping reviewer, whose row was already failed-orphan, to prevent another stale write on waking. |

Daily logs contain roughly 1,200–5,600 core calls per hour across **all**
credentials; that aggregate does not establish exhaustion of this installation.
The recovery reading in the identical window is direct contradictory evidence.

## Root cause

`isGitHubRateLimitError` accepted `rateLimited`, status 429, or a regex matching
`rate limit`, `too many requests`, or `HTTP 429` anywhere in an exception's
message, stderr, stdout, or response message. A failed CLI command can carry PR
content in those fields. That content was treated as transport authority.

`extractRateLimitObservation(..., { rateLimited: true })` then forced remaining
to zero, even when response headers reported positive capacity. Without
`retry-after`, it reused the primary hourly reset. The shared state file made
this false reading authoritative to every process using that credential.
A reviewer-side 401 refresh selected the watcher's role, extending the failure
from reviewer slots to discovery and closure across repositories. Processes
trusted the stored zero without checking the live budget before an hour-long
sleep or deferral.

### Command reconstruction and remaining evidence gap

Retained reviewer run stderr stops at “fetching diff” and subsequently shows a
401 refresh with the watcher role. The command is `gh pr diff <synthetic-pr>
--repo fixture/repo`, called by `fetchPRDiff` through `execGhWithRetry` and the
metered CLI wrapper. The non-phrase review later logs a completed 12,475-byte
diff; the phrase-bearing review never logs completion. Neither retained run
logs a “diff too large” warning or entry into the PR-files fallback. The outer
logical `diff_fetch` row appears only when this nested call returns, so it does
not retain the error that caused the nested throttle sleep.

The initial failed response/output at 18:40:11 and the offending output at
19:40:06 were **not retained**. The physical HTTP rows lack per-command or PR
correlation. Consequently the nearby 19:40:05.9 404 cannot conclusively be
assigned as the triggering failure, nor can an exact matched output fragment
be recovered. “rate limit” is the proven unsafe trigger and is present in one
input diff; attributing that specific fragment to the lost exception would go
beyond the evidence. This remains an incident evidence gap, not a claim that
the exact original exception was recovered.

The synthetic regression runs the real `fetchPRDiff` call path with a failed
`gh pr diff`, status-text 404 and a content-bearing stdout diff containing
“rate limit”. The previous classifier matched that stdout and the recorder
forced zero; the corrected path leaves the bucket untouched, does not retry,
and does not enter the files fallback. Separate 500, 401, conditional-request
and Octokit-hook cases cover the sibling paths. New structured observation and
confirmation rows retain the evidence needed to distinguish future cases
without retaining PR content.

## Diagnostic history, including the incorrect initial diagnosis

The operator requested, verbatim: "I want you to put your misdiagnosis into the report as well. We need to find a way to clamp down on that since you were about to add +500LOC on a faulty assumption".

At approximately 19:31 the on-call responder diagnosed the review-lane stall as
"the reviewer credential's hourly GitHub allowance was used up by some consumer the call log doesn't show"
and told the operator so. Contradicting evidence was already in hand and was
not reconciled: the call log contained only 29 calls on that credential for the
whole day; the reset implied a window beginning about nine seconds before the
zero (requiring about 5,400 calls in nine seconds); and `rateLimitedCalls: 1`
identified the forced-zero path.

At approximately 19:36, REVIEWTHROTTLESLEEP-01 was dispatched with item 3 to
attribute the supposed exhaustion. Its other items stand on proven evidence.
At approximately 19:45, seeing the watcher credential at zero, the responder
again inferred a hidden drain: "hundreds of one-call tokens hide the drainer".
A roughly three-hour, two-repository change was dispatched to re-key all GitHub
budgets by App installation and add per-consumer attribution: several hundred
lines premised on exhaustion that had not occurred.

At approximately 19:49–19:51, reading the roughly 25-line observation writer
revealed the forced zero. Clearing it returned the true 5,032/5,400 reading.
The large change was cancelled at 19:54, after about nine minutes of worker
time and before any PR. This ticket supersedes that cancelled work; reviewer
identity isolation and truthful attribution remain valid requirements.

The responder reasoned from the symptom (zero) to an environmental cause
(a drainer), without first reading the signal producer or checking physical
possibility. A code-changing fix was dispatched while a contradiction remained
unexplained.

The corrective SRE process is **proof-first briefs**: every fix brief states its
causal claim, a probe that could falsify it, and the result. An unexplained
contradiction makes the task diagnosis-only: reproduce or falsify first, stop
with a report if falsified, and write code after confirmation. Briefs state an
expected change size; exceeding twice that size requires stopping and reporting.
This is a process action, not a new product gate or implementation in this repo.

## Fix and operational contract

Only response status, the six allowed rate headers, and parsed GitHub API error
envelopes can classify a limit. Status 429 is a limit; status 403 requires a
zero remaining header, retry-after, or a documented GitHub API error. CLI debug
HTTP envelopes are buffered privately and discarded after constructing metadata;
stdout, stderr prose and exception messages never establish a limit. A GraphQL
`RATE_LIMITED` type is accepted only in a parsed GraphQL HTTP response body.

Primary zero observations retain the primary reset. Secondary observations
preserve the measured primary balance and carry `secondaryUntil` and
`secondaryAttempts`: honor retry-after, otherwise 60/120/240/300 seconds.
Headerless trusted secondary events have unknown primary remaining, not zero.
A newer positive response can correct an older zero.

Before sleeping or deferring more than two minutes, admission probes
`GET /rate_limit` with the exact sending credential, bypassing its own throttle.
Contradictory live readings replace the stored false zero; both observations
are logged. An unavailable probe bounds that admission hold to two minutes,
then requires another admission decision. A primary probe cannot clear a real
secondary hold. The synchronous bridge and watcher discovery shortcut use the
same admission confirmation.
If the probe itself returns structured quota evidence, admission honors that
response's primary reset or secondary Retry-After and logs its headers. Its
core response headers cannot be mistaken for GraphQL primary capacity.

Reviewer identity is pinned through `GITHUB_REVIEWER_TOKEN_ENV`. A 401 refresh
uses that selected reviewer's broker role and refuses identity drift; it cannot
fall through to watcher refresh. Existing verified installation bindings remain
in use: roles sharing an actual installation truthfully share its real quota.
Isolated reviewer and watcher identities cannot contaminate each other's keys.
Every limited observation logs raw limit/remaining/used/reset/resource,
retry-after, status, request category and consumer, without token values or
response content.

These timings follow [GitHub's rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api):
secondary limits honor retry-after or wait at least a minute with exponential
backoff; `/rate_limit` does not consume primary quota (it can consume secondary
capacity). Probes are bounded and only performed for long proposed holds.

## Fleet inventory

Repository-relative paths below are implementation locations, not host paths.
Line numbers identify the audited function/trigger in this change. `AR` means
adversarial-review; `AO` means agent-os. Diagnostic-only matches are separated
from shared scheduling decisions.

| Site | Trigger / evidence | Blast radius and untrusted reachability | Disposition |
| --- | --- | --- | --- |
| AR `src/rate-limit-throttle.mjs:147` | Former free-text rate-limit regex | Credential/resource across all repositories; PR stdout/stderr reachable | Structured central classifier, distinct secondary state, live confirmation |
| AR `src/metered-gh.mjs:27`, `bin/metered-gh.mjs` | Former prose and GraphQL message matching | Shared budget, async and sync CLI consumers; diffs reachable | Parse private response envelopes; stdout cannot establish a limit; sync confirmation bridge |
| AR `src/conditional-request.mjs:136` | Central classifier → recorder | Watcher polling and conditional REST/Octokit; API body reachable | Structured observation and request category |
| AR `src/github-adapter-client.mjs:569` | Parent adapter failure handling | Scoped label reads/writes and lane deferral | Central structured predicate; no output-message inference |
| AR `src/follow-up-merge-agent.mjs:1976`, `src/posted-review-row.mjs:1244`, `src/watcher-poll-fairness.mjs:590`, `src/watcher-github-budget.mjs:17` | Central predicate | Closure, no-progress lanes and poll scheduling | Inherit corrected predicate; watcher whole-poll shortcut confirms long holds |
| AR `src/gh-cli.mjs:67`, `src/reviewer.mjs:1350`, `src/review-cycle-cap-actions.mjs:35` | Former rate-limit prose retry | Bounded request retry; PR/error output reachable | Typed rate evidence replaces rate prose |
| AR `src/branch-protection.mjs:62`, `src/closeout-scraper.mjs:126`, `src/reviewer-reattach.mjs:173`, `src/remediation-workflow-push-capability.mjs:128` | Former rate-limit prose retry | Per-operation retry/recovery; CLI output reachable | Typed rate evidence replaces rate prose |
| AR `src/{fast-merge-github-io,daemon-clean-merge,duplicate-family-workflow-cli}.mjs`, `src/adapters/subject/github-pr/duplicate-content.mjs` | Former rate/429/abuse prose | Fast-merge live-review reads and duplicate-content retries; CLI/API content reachable | Shared structured predicate replaces rate prose |
| AR `src/reviewer-context-auth.mjs`, `src/gh-cli.mjs` | 401 refresh selected watcher role | Reviewer could write watcher budget | Selected reviewer-role refresh, tested identity refusal |
| AR `src/ama/{dispatch-closer,daemon-merge,closure-gate-read,history-read-policy,labels,orphan-watchdog}.mjs` | Former rate-limit/429/retry-after prose | Closer retries, merge parking and recovery waits; command output reachable | Shared typed predicate replaces rate prose; structured history backoff and bounded closure wait |
| AR `bin/hammer-{merge,publish,verify-head,shell-helpers}.sh` | Rate-limit and retry-after grep alternatives | Bounded hammer gate retries; stderr/content reachable | Remove prose rate authority; metered transport owns admission and observations |
| AO `modules/worker-pool/lib/{hq-worker-provision,hq-agent-tree-provision,hq-adjudicate-merge,hq-adjudicate-review,hq-pr-attest,hq-app}.sh`, `adapters/merge-agent.sh` | Rate-limit/429 patterns and final merge stderr receipt classification | Provision/admission retry and merge failure receipt; command output reachable | Remove rate prose authority; authoritative exit results retain refusal behavior |
| AO `modules/github-adapter/src/agent_os_github_adapter/{rate_limit,api_usage,transport,retry}.py` | Former substring failure classification and output header regex | `hq github`, entitlement runner, hammer/rescue callers; content reachable | Shared structured parser; raw six-header attribution; secondary minute backoff |
| AO `modules/worker-pool/lib/hq-gh.sh` | Identity rate-limit glob; GraphQL stderr fallback | Worker identity admission and shared credential fallback; CLI output reachable | Private structured parser; rate-limit probe for fallback; no phrase authority |
| AO `modules/worker-pool/lib/python/cwp_helm/{merge_agent_rescue,merge_agent_rescue_loop}.py` | Primary/secondary prose and reset regex | Rescue/hammer retries and deferrals | Transport metadata only; return for later pass instead of early secondary retry |
| AO `cwp_dispatch/{dag_reconcile,worker_run_reconcile,hardening_github_query,decision_reconcile,dag_frontier,prove,admit_pass,ama_coexistence,pr_provenance_refresh,drain_credential_probe,daemon,recover_stranded,podium_hq_adapter}.py`, `cwp_helm/autowalk.py` (under `modules/worker-pool/lib/python`) | Rate-limit/429 prose in transient patterns | Bounded retry and DAG/admission deferrals; GitHub output reachable | Remove free-text rate authority; adapter-backed calls retain typed failure envelopes |
| AO `scripts/{pack-census,submodule-pointer-gate}.py`, `scripts/pipeline-health-diagnostic-tick.sh`, `scripts/ci-mirror/run-cfg-parity-gate.sh`, `cwp_dispatch/pr_disposition.py:66`, `platform/session-ledger/src/session_ledger/worker_outcome.py:21` | Former rate/429 prose | Local GitHub/git retries, reconciliation refresh and health reads; subprocess output reachable | Remove prose rate authority; bounded non-rate transport retries retained |
| AO `modules/github-adapter/src/agent_os_github_adapter/auth.py:762` | 403 remaining=0 or retry-after headers | Broker validation refusal/retry | Already structured; retained |
| AO `cwp_dispatch/incident_monitor.py:59` | Former `rate limit`/`too many requests` | Source retry, no shared budget; CLI output reachable | Typed rate marker only |
| AO `runtime/github-auth/bin/gh`, `modules/worker-pool/lib/hq-github.sh` | No independent prose quota classifier | Auth wrapper / delegates adapter | Audited; no duplicate quota writer |
| AR `src/ama/stacked-base.mjs:35`, `src/pr-terminal-reconcile.mjs:133`; AO `modules/agent-observability/runtime/scripts/close-pipeline-health-exporter.mjs:155`; AO `cwp_dispatch/{teardown_pr_check,pr_lifecycle,session_resume_proof_diagnostics}.py` | `rate limit`, `429`, `abuse` diagnostic labels | Display/attribution only; output reachable | No budget/latch decision; retained as diagnostics |
| AR `src/quota-exhaustion.mjs:24`, `src/adapters/reviewer-runtime/cli-direct/index.mjs:79`, `classification.mjs:112` | `hit your usage limit`, `weekly limit`, `out of credits`, `resource_exhausted`, `quota exceeded` | Reviewer failure/quota fallback; combined model/tool output can reach classifiers despite some event filtering | Follow-up PROVIDERSIGNAL-01 |
| AR `src/reviewer-harness.mjs:2405,3088` | `429`, `resource_exhausted`, `quota`, `rate limit` over concatenated exception/stdout/stderr | Gemini credential cooldown and reviewer availability; untrusted model/tool content reachable | PROVIDERSIGNAL-01 |
| AR `src/reviewer-quota-signal.mjs:28,227`, `src/review-pipeline-health.mjs:1280`, `src/reviewer-spawn-settle.mjs:492`, `src/argus-reviewer-failures.mjs:35`, `src/ama/dead-hammer-rearm.mjs:37` | Quota/reset prose, usage cap, account limit, 429 marker | Settlement, reviewer fallback/rearm and health classification; reachability depends on upstream diagnostic filtering | PROVIDERSIGNAL-01 |
| AO `modules/worker-pool/lib/python/cwp_dispatch/worker_killed_cause.py:60,69,126,583,1051`, `quota_recovery.py:329` | `insufficient_quota`, `quota_exceeded`, `429`, `RateLimitError`, usage-cap text | Provider/auth-path holds and worker suspension; output tails and assistant error context reachable; some attribution paths disable prose | PROVIDERSIGNAL-02 |
| AO `platform/session-ledger/src/session_ledger/worker_rate_limit_failure.py:22,83` | Complete `Request rejected (429)…account…rate limit` | Broker-OAuth provider hold; typed terminal/synthetic events preferred, but plain final line/stderr fallback remains reachable | PROVIDERSIGNAL-02 |
| AO `platform/session-ledger/src/session_ledger/worker_exit_cause.py:257`; AO `cwp_dispatch/{worker_outcome,provider_errors}.py:56,323` | 429/rate-limit labels, usage-limit and quota substrings | Worker outcome/error attribution feeding recovery; raw output reachable | PROVIDERSIGNAL-02 |
| AO `cwp_quota_probe/{prober,observation}.py:147,23`, `cwp_dispatch/provider_errors.py:41`, `cwp_quota_probe/gemini_quota.py:146`, `cwp_quota_probe/hard_stop.py:43` (under worker-pool Python) | Probe quota/429 signatures; `RESOURCE_EXHAUSTED`+429+reset | Provider/auth-path shared holds; fixed diagnostic probes reduce PR-content reachability, worker-derived Gemini observations reintroduce it; hard_stop consumes metadata | PROVIDERSIGNAL-02 |
| AO `cwp_dispatch/grok_adapter.py:280`, `grok_quota.py:241` | Exact terminal typed `errors` list + failing exit, auth kind and source-backed copy | Account/model cooldown | Structured terminal provenance already required; preserve negative tool-output tests in PROVIDERSIGNAL-02 audit |
| AO `modules/agent-runtime/modelclient/client.go:384`, `modules/agent-runtime/runtime/executor.go:148` | HTTP status 429 → typed ErrRateLimit | Per-route/provider cooldown; model text is not the rate-limit authority | Already structured; retained |
| AO `modules/worker-pool/lib/python/cwp_dispatch/op_adapter.py:363,1215`; `scripts/lib/op-resolve-with-rate-limit-backoff.{mjs,sh}:46,132`, `modules/worker-pool/lib/hq-common-secrets.sh:319` | `too many requests`, `rate limit`, bare 429; wrapper markers | Shared 1Password service-account circuit and secret resolution; direct `op read` errors are provider-side, `op run` child stderr can be untrusted | SECRETQUOTASIGNAL-01 |
| AO `modules/model-routing-budget-control/runtime/scripts/litellm-drift-watch.mjs:453,1062,1175,1244,1292` | 429/rate/usage-limit prose in spend-log and metric evidence | Per-alias fallback-alert suppression, not routing quota; provider messages and model labels reachable | PROVIDERSIGNAL-02 must include this telemetry consumer |
| AR `src/codex-per-worker-auth.mjs:71`, `src/remediation-quota-evidence.mjs:5`; AO `cwp_dispatch/model_proxy_recovery.py:47`, `platform/app-sdk/python/src/agent_os_app_sdk/host.py:553` | HTTP 429/prose markers, terminal account rejection | Auth recovery, remediation holds and broker error attribution; tool/model output reachability varies by source | PROVIDERSIGNAL-01 / PROVIDERSIGNAL-02 |
| AO `modules/agent-ops/src/agent_ops/{identity_reconcile,service_control}.py:17,114,3017`, `modules/agent-gateway/lib/{resident-reply-stream,outbox-delivery-adapters}.mjs:30,1045`, `modules/agent-gateway/scripts/run-rcd-g3-cognitive-cron.mjs:77`, `modules/media-generation/media_gen.py:82`, `modules/worker-pool/lib/python/cwp_pmo/adapters/linear.py:678` | Rate/429/retry-after text in errors or subprocess output | Identity/service retries, Telegram edit pacing, outbox/crons and Linear delivery retry; error/content mixing varies, no GitHub budget writer | TRANSPORTSIGNAL-01 |
| AO `cwp_dispatch/node_hydration.py:34`; `scripts/alert-delivery.mjs` | HTTP 429/package-manager or delivery diagnostics | Local bounded hydration/delivery retry; no provider budget writer | Diagnostic/local retry; separate from fleet quota latch |

Paths abbreviated as `cwp_dispatch`, `cwp_helm` and `cwp_quota_probe` in the
last rows are below `modules/worker-pool/lib/python/`.
Inventory method: recursive source searches for rate/quota/exhaustion patterns,
then inspection of producers and consumers to distinguish display labels,
bounded local retry, structured quota state and shared holds. A supplemental
Go/JavaScript/TypeScript/Rust search checked typed runtime cooldowns and display
consumers; no additional GitHub prose budget writer was found there. Tests, generated
inventories and vendored dependencies were excluded from implementation hits.
No claim is made that provider text matching is safe simply because it is narrow.

### Named follow-ups for SRE dispatch

**PROVIDERSIGNAL-01 — reviewer provider evidence.** Replace reviewer quota and
Gemini cooldown inference from combined output with typed, transport-owned
terminal evidence. Preserve reset-aware fallback and credential selection;
prove successful answers, quoted fixtures, tool errors and PR text cannot
suspend a reviewer class or cool a credential. Audit every pipeline-health,
Argus and dead-hammer consumer of the normalized signal. This spans several
harness protocols and is larger than a safe local parser substitution.

**PROVIDERSIGNAL-02 — dispatch and ledger provider holds.** Trace every producer
of `hardQuotaStop` and quota recovery metadata through worker-killed-cause,
provider-error observation, Gemini reset episodes, probes and ledger reapers.
Require terminal provider provenance before provider/auth-path suspension;
remove raw-tail/plain-output fallbacks and retain legitimate hard-cap recovery.
Include model-proxy recovery, app-SDK broker attribution and LiteLLM drift-watch
per-alias alert suppression: distinguish observability holds from routing holds.
Add cross-consumer tests proving quoted tool output cannot ground the provider,
while fixed probes and exact Grok terminal events still work. Coordinate the
ledger and dispatch contract rather than changing one classifier in isolation.

**SECRETQUOTASIGNAL-01 — secret-provider circuit provenance.** Separate 1Password
transport failures from `op run` child stderr before opening the service-account
circuit. Replace bare 429 and quota prose authority with source-bound operation
results, maintain the existing live-read budget, and prove child output cannot
hold secret resolution fleet-wide. Include both shell and Node wrappers and
the Python adapter; inspect redaction without logging secret material.

**TRANSPORTSIGNAL-01 — other transport retry provenance.** Audit identity/service
control, gateway edit/outbox/crons, media credential resolution and Linear
transport exception classification. Replace prose quota inference with typed
provider status and source-owned retry metadata, retaining bounded local retries
where no shared latch exists. Prove quoted output and application payloads cannot
set a shared hold or misclassify credential availability. These protocols have
separate retry contracts and should not be rewritten by one GitHub parser patch.

## Validation and merge order

Synthetic tests cover 401/404/500 content, failed `gh pr diff`, secondary
403 with 4,000 remaining and retry-after 60, primary zero, contradictory live
5,032 reading, bounded failed confirmation, synchronous admission, and reviewer
versus watcher credential isolation. Existing scoped throttle, auth, conditional,
watcher and CLI suites are run individually under network denial. Exact commands
and observed results are recorded in `docs/changes/GHFALSEZERO-01.md`.
No new CI check, gate, label, daemon activation or live repair is part of this PR.

Merge adversarial-review first to repair the shared observation writer and
reviewer refresh. Merge the independent agent-os companion next to remove its
remaining GitHub prose classifiers and correct bounded retries. Neither PR
requires deploying live state edits or a superproject gitlink bump here.
