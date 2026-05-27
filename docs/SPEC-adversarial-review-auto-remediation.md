# SPEC - Adversarial Review Auto-Remediation

_Status: Living contract_
_Related: `SPEC.md`, `docs/follow-up-runbook.md`_

## Kernel Contract Surface

`src/kernel/contracts.d.ts` defines the target kernel contract surface for
the review/remediation boundary. Today only the verdict, remediation-reply,
and prompt-stage shapes are bound directly from runtime `.mjs` modules via
JSDoc; the adapter interfaces remain the intended steady-state shape for the
in-flight kernel split and are exercised by `test/fixtures/kernel/contracts-check.ts`.

This split is intentional. When the runtime grows a concrete kernel adapter
boundary, those modules should bind to these interfaces rather than fork new
shapes. Until then, updates to the declaration file must keep the fixture and
the runtime-bound JSDoc consumers in sync.

## Default Agent Routing Overrides

The GitHub-PR adapter preserves opposite-agent review routing when no override
is configured:

- `[codex]` PRs route first-pass review to Claude and use
  `GH_CLAUDE_REVIEWER_TOKEN`.
- `[claude-code]` and `[clio-agent]` PRs route first-pass review to Codex and
  use `GH_CODEX_REVIEWER_TOKEN`.

Operators may deliberately pin the reviewer with
`ADVERSARIAL_REVIEW_DEFAULT_REVIEWER=codex|claude`. A non-empty override wins
over the title-prefix route for every supported builder class and also selects
the matching reviewer bot token. The alias `claude-code` is accepted for the
Claude reviewer, but the canonical runtime reviewer model remains `claude`.
Watcher startup validates this override once and exits non-zero on invalid
values instead of discovering the typo mid-poll. When the override intentionally
pins the same reviewer family as the builder, the posted review body carries an
explicit cross-model-waiver note so the audit trail shows the guarantee was
deliberately suspended.

Follow-up remediation defaults to the `codex` worker class while the LAC-358
codex override remains active. Operators may pin remediation with
`ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR=codex|claude-code`; aliases
`claude`, `codex-remediation`, and `claude-code-remediation` are accepted and
normalized to the worker classes that the dispatcher can spawn. The follow-up
daemon validates the override during startup and exits before claiming work if
the value is invalid. Consume-time worker selection also runs inside the
claimed-job failure handler so direct/helper callers cannot strand a job in
`in-progress/` on a bad override.

Invalid non-empty override values are configuration errors. The runtime must
not silently fall back from an invalid value because that can route work to an
expensive, unavailable, or intentionally locked-out agent.

## Remediation Reply Contract

The durable remediation reply schema is the public contract between the worker,
the validator, reconciliation, and the PR-comment renderer. `schemaVersion: 1`
supports four accountability lanes:

- `addressed[]` for blocking review findings that were fixed. Workers may also
  include additionally-fixed non-blocking findings here when they copy the
  exact title from the review's `## Non-blocking issues` section; those extras
  render publicly but do not satisfy blocking-finding coverage.
- `pushback[]` for blocking review findings the worker deliberately left unchanged.
- `blockers[]` for blocking review findings that hard-stop on required human input.
- `operationalBlockers[]` for git/process failures that are not themselves review
  findings, such as `branch-contamination`, `stale-pr-head`,
  `push-lease-rejected`, `missing-auth`, `fetch-failed`, or `rebase-conflict`.

Remote PR-head movement is an optimistic-concurrency event, not an immediate
hard stop. A remediation worker must capture the clean post-base-rebase head
before editing, commit its remediation, then publish with `--force-with-lease`
against the freshly observed PR head. If that lease fails or Git reports a
non-fast-forward push, the worker must replay only its own remediation patch
onto the fresh PR head, re-run the contamination audit and relevant validation,
and retry the lease-guarded push with a fresh expected SHA. This replay is
bounded to three stale-head attempts.

`stale-pr-head` specifically means that bounded replay was exhausted or became
unsafe: unresolved `git am --3way` conflicts, ambiguous force-rewritten PR
history where the worker cannot identify its own patch, repeated lease misses
after three fresh-head replays, or post-replay validation/audit failure. The
worker still must not blindly rebase the entire in-progress worktree onto
`origin/<pr-branch>` because that can resurrect commits another writer
intentionally removed; safe recovery replays only the worker's patch series onto
the newly fetched PR head.

`operationalBlockers[]` does not count toward per-finding coverage. A worker may
therefore emit `addressed=[]`, `pushback=[]`, `blockers=[]`, and a non-empty
`operationalBlockers[]` when the round stops before any remediation work begins,
for example when the mandatory branch-contamination audit fails immediately after
rebase. That early-exit shape must validate cleanly and render as an operational
stop, not as a missing-per-finding-accountability error.

Validation keeps three invariants load-bearing:

- Per-finding coverage is enforced only across blocking review findings
  recorded in `addressed[]`, `pushback[]`, and `blockers[]`, with
  operational-only early exits exempt because no review finding was processed
  yet. `addressed[]` entries whose titles match only the review's
  `## Non-blocking issues` section are allowed as extras and are excluded from
  the blocking-coverage count.
- Cross-field contradictions (`reReview.requested=true` while blockers remain,
  `outcome="blocked"` without blockers, `outcome="completed"` with blockers)
  apply only to structured-schema replies so legacy persisted string-blocker
  artifacts remain readable under `schemaVersion: 1`.
- Known operational blocker titles misplaced in `blockers[]` are normalized into
  `operationalBlockers[]` as a worker-safety hatch, but title collisions with an
  actual blocking review finding must fail loudly instead of being silently
  relocated.

## Remediation Workspace Contract

Remediation worker clones live under a canonical workspace root that is resolved
in this precedence order:

1. `ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT`
2. `HQ_ROOT/adversarial-review/follow-up-workspaces`
3. Legacy in-source fallback: `<tool-root>/data/follow-up-jobs/workspaces`

When the daemon is running from the production deploy checkout
`/Users/airlock/agent-os`, it must refuse to create mutable remediation clones
under the live source tree unless either `ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT`
or `HQ_ROOT` points the worker at an external workspace root. An explicitly
configured workspace root must also be rejected if it resolves inside the deploy
checkout.

Spawn persists both the resolved `workspaceRoot` and the per-job `workspaceDir`
on the durable worker record. Reconciliation validates stored absolute artifact
paths against that persisted workspace root rather than re-resolving the current
process environment, so operator changes to `HQ_ROOT` or
`ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT` do not orphan in-flight jobs that were
spawned under an earlier root.

Before reconciliation trusts a persisted absolute `workspaceRoot`, that stored
root must itself resolve inside one of the legitimate remediation workspace
trees for the current process: the configured
`ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT`, `HQ_ROOT/adversarial-review/follow-up-workspaces`,
or the legacy in-source `data/follow-up-jobs/workspaces/` fallback. Stored roots
outside that union are ignored and reconciliation falls back to the current
resolved workspace root instead of treating an arbitrary absolute path as the
containment anchor for worker artifacts.

When a durable worker record is missing `workspaceDir`, reconciliation falls
back to `<persisted workspaceRoot>/<jobId>` before reading legacy workspace
artifacts or running the branch-contamination audit. This preserves the
pre-relocation invariant that the audit has a deterministic per-job workspace
path even for legacy or partially-written records.

Operational ownership expectation: if `HQ_ROOT` is used, the runtime user must
have read/write access under `HQ_ROOT/adversarial-review/` and
`HQ_ROOT/dispatch/remediation-replies/`. LaunchAgent templates that are kept for
operator revival or diagnostic bounces must carry the same `HQ_ROOT` value as
the live daemon so a temporary bounce cannot consume jobs into an unwritable or
mis-resolved workspace tree. Workspace-root provisioning failures must surface a
structured error that names both `HQ_ROOT` and the runtime user so first-deploy
permission drift is diagnosable without reading a raw stack trace.

## Follow-Up Stop Codes

Queue stop codes are operator-facing state. The durable stop surface currently
includes:

- `operator-stop` — human explicitly stopped the job.
- `no-progress` — worker exited without a durable `reReview.requested=true`.
- `max-rounds-reached` — another round would exceed the stored cap.
- `operator-merged-pr` — the PR merged before consume or reconcile could
  advance the loop.
- `operator-closed-pr` — the PR closed unmerged before consume or reconcile
  could advance the loop.
- `stale-review-head` — consume-only guard: the job was created for an older PR
  head and a newer head is already live, so this stale job must not spawn.

`stale-review-head` is intentionally a pre-spawn stale-job signal, not a
post-spawn invariant. Reconcile must not emit it merely because the remediation
worker pushed commits and moved the PR head away from `job.revisionRef`; that
head movement is the normal success path before rereview is requested.

The operator `follow-up:stop` command is the terminal ledger transition for
manual intervention. When it targets an in-progress job whose
`remediationWorker.state` is `spawned`, it must first try to signal the
persisted worker process group using the same identity verification as
`follow-up:cancel-worker`. Stale worker handles are not allowed to strand the
operator stop: `process-group-not-found`, `identity-unconfirmed`, and
`missing-worker-process-handle` mean no signal was delivered to a verified live
worker, so the command may proceed to the `operator-stop` transition while
surfacing the cancellation result. Unexpected cancellation failures remain hard
errors and must name the `--no-cancel-worker` escape hatch.

Signal delivery is not the same thing as worker termination. After a successful
signal, `follow-up:stop` must record whether a bounded post-signal liveness
probe observed the process group exiting before moving the job to `stopped/`.
Operators can use `--signal SIGKILL` for urgent termination and
`--no-cancel-worker` only after independently proving the worker can no longer
mutate the PR branch. A benign race with the follow-up daemon reconciling the
job between the stop command's initial read and cancellation attempt must be
treated as "nothing left to cancel"; the command should re-locate the current
job record and continue the operator stop instead of failing.

## Adversarial Gate Commit Status

The watcher projects the durable adversarial-review ledger onto the PR head SHA as a GitHub commit status with context `agent-os/adversarial-gate` by default.

Operators must require `agent-os/adversarial-gate` in branch protection before relying on GitHub-native merge or auto-merge for adversarial-review-gated branches. Without the required context, GitHub can merge while review, remediation, or operator handling is still pending. Deployments may opt into a different context with `ADV_GATE_STATUS_CONTEXT`, but that override must be applied consistently anywhere the watcher posts or probes the gate. Overrides must match `[A-Za-z0-9._/-]+` and be at most 100 characters so structured diagnostics remain log-safe.

The watcher verifies that policy in process: on a cached interval it checks watched repositories' branch protection and logs `branch-protection-warning` when the configured gate context is missing, when the protection endpoint cannot be read, or when `ADV_GATE_STATUS_CONTEXT` is invalid. Operators can run the same probe with `npm run check-branch-protection`.

Status-context migrations are explicit operator work, not an in-place default flip: update branch protection to require the new context and roll the same `ADV_GATE_STATUS_CONTEXT` override to every watcher and branch-protection probe before depending on the renamed check.

State mapping:

| State | Meaning |
|---|---|
| `pending` | Review has not posted, review is queued/in progress, a posted review is waiting for the follow-up ledger to appear, remediation is queued/in progress, or a requested re-review has not posted yet. |
| `success` | The latest posted review settled as `Comment only` or `Approved` in its durable follow-up verdict carrier with no standing structured blocking findings, or a current scoped `operator-approved` label accepts the PR head regardless of review/remediation state and no explicit skip label is present. |
| `failure` | Review/remediation is malformed, failed, orphaned, stopped, missing a verdict, still blocked by `Request changes`, explicitly skip-labeled, or in an unknown state. |

Reason mapping:

| Reason | State | Meaning |
|---|---|---|
| `review-not-posted` | `pending` | No durable adversarial review row has posted yet. |
| `review-queued` | `pending` | The watcher has queued the adversarial review. |
| `review-in-progress` | `pending` | The reviewer subprocess is currently in flight. |
| `rereview-queued` | `pending` | A completed remediation round requested a fresh adversarial review that has not posted yet. |
| `review-retry-pending` | `pending` | A reviewer failure is retryable, but no more specific transient class is known. |
| `reviewer-timeout-retry-pending` | `pending` | The reviewer timed out and is waiting for retry/backoff. |
| `reviewer-bootstrap-retry-pending` | `pending` | The Claude launchctl/bootstrap path failed and is waiting for retry/backoff. |
| `reviewer-cascade-retry-pending` | `pending` | The reviewer hit a LiteLLM/upstream cascade and is waiting for retry/backoff. |
| `awaiting-ledger` | `pending` | A review was posted, but the follow-up job ledger has not appeared yet. |
| `remediation-queued` | `pending` | Follow-up remediation is queued. |
| `remediation-in-progress` | `pending` | Follow-up remediation is currently in progress. |
| `review-settled` | `success` | The latest review verdict is non-blocking. |
| `operator-approved` | `success` | A scoped operator approval accepts the current PR head regardless of review/remediation state. |
| `review-malformed` | `failure` | The durable review row is in a malformed terminal state, including but not limited to malformed-title. |
| `reviewer-timeout` | `success` | The reviewer timed out before posting after retry handling; the gate must not imply a substantive review passed. The watcher must make the operator action visible and, when the timeout follows a completed remediation that requested re-review, hand the PR to the merge-agent decision path. |
| `reviewer-launchctl-bootstrap` | `failure` | The Claude launchctl/bootstrap path failed before posting. |
| `reviewer-cascade` | `failure` | The reviewer hit a LiteLLM/upstream cascade before posting. |
| `review-failed` | `failure` | The adversarial review failed before posting and no more specific class is known. |
| `review-failed-orphan` | `failure` | The watcher needs operator verification for a possible orphan review post. |
| `review-state-unknown` | `failure` | The durable review row contains an unexpected state. |
| `blocking-review` | `failure` | The latest review verdict still requests changes. |
| `missing-verdict` | `failure` | The latest review body does not contain a usable verdict. |
| `unknown-verdict` | `failure` | The latest review body contains a malformed or unsupported verdict. |
| `remediation-failed` | `failure` | Follow-up remediation failed and needs operator action. |
| `remediation-stopped` | `failure` | Follow-up remediation stopped and needs operator action. |

Clean review verdicts still create follow-up jobs for auditability and gate projection. When the consumer sees a `Comment only` or `Approved` verdict with no standing structured blocking findings, it moves that job to `stopped` with `review-settled` instead of spawning a remediation worker. If a clean verdict body still contains a structured `## Blocking issues` section with any standing item other than `- None.`, merge-agent dispatch parks at `skip-blockers-present` rather than treating the verdict as settled-success.

Within the review body's `## Verdict` section, the authoritative verdict is the last recognized verdict line. If the section contains both a blocking `Request changes` verdict line, including clause forms such as `Request changes: ...` or `Request changes -- ... must be fixed`, and a permissive `Comment only` or `Approved` line, the parser resolves conservatively to `Request changes`; explanatory prior-round resolution prose only avoids this override when the request-changes clause is explicitly in a resolved state, such as `Request changes ... are now resolved` or `Request changes ... have been addressed`. Any negated, current, or future blocking phrase on the same line (`not fixed`, `still`, `remains`, `must be fixed`, `needs to be addressed`, etc.) keeps the line classified as blocking even if it quotes or mentions resolved-state language. If no line is recognized, the verdict remains malformed and the gate fails closed.

The watcher must project the gate on terminal early-exit paths, including already-posted review rows. A settled PR must not stay frozen at an earlier `pending` projection after the durable review verdict is available.

## Operator Retrigger Contracts

`retrigger-review` and `retrigger-remediation` are separate operator surfaces:

- `retrigger-review` resets the watcher delivery row to `review_status='pending'` so the watcher can post another adversarial review.
- `retrigger-remediation` bumps the remediation budget and requeues the latest eligible terminal follow-up job. It does not reset `reviews.db` first; the next fresh adversarial review must come from the requeued worker's durable `reReview.requested=true` reply during normal reconciliation. Eligible terminal jobs are `failed`, `completed` with `reReview.requested=true`, or `stopped` with one of `max-rounds-reached`, `round-budget-exhausted`, `daemon-bounce-safety`, or `review-settled`. `stopped:review-settled` is retriggerable because the automatic loop has settled the review as non-blocking, but an explicit operator action can still request a worker pass over the remaining findings. That retrigger is carried durably on `remediationPlan.nextAction={type:'consume-pending-round', operatorOverride:true, requestedAt, requestedBy, operatorVisibility:'explicit'}`; `claimNextFollowUpJob` must suppress the claim-time `review-settled` early-stop for that one claim, then consume the override by rewriting `nextAction` to `worker-spawn`. While the requeued job is `pending` or `inProgress`, the adversarial gate must stay pending rather than projecting the stored Comment-only verdict as settled. `stopped:operator-stop` and `stopped:rereview-blocked` are intentionally not retriggerable through this surface because those states encode operator intent or a watcher refusal that needs human handling.

For PR-side `retrigger-remediation` labels, a successful budget bump is the durable consumption boundary. Once the bump lands, the watcher must write the label-consumption record and operator-mutation audit before attempting the queue rearm. If requeue then fails, the watcher still removes the label and posts a failure-flavored acknowledgement that names the partial-success state; the same GitHub label event must not authorize another budget bump on retry.

The watcher must not run a fresh adversarial review while the latest follow-up job for the same PR is `pending` or `inProgress`. This guard is load-bearing for the PR #48 race: if an operator requeues remediation while the watcher row is already `pending`, the pending follow-up job wins and reviewer dispatch is deferred until the worker reaches a terminal state.

Re-review resets are also gated on branch cleanliness, not just `reReview.requested=true`. Before `requestReviewRereview` is allowed to move the watcher row back to `pending`, reconcile must have a proven PR base branch, fetch `origin/<baseBranch>`, and run `git cherry origin/<baseBranch> HEAD`. Legacy jobs without `baseBranch` are lazily hydrated from GitHub and persisted before any worker spawn or reconcile audit; if the real base cannot be proven, the job fails before defaulting to `main`. Any `-` marker means the remediation branch still contains a patch-equivalent copy of a commit already merged on the base branch, so reconcile must route that round to durable `failed:branch-contamination`, preserve the suspect commits on the failed job record, and post the normal reconcile-time remediation outcome comment instead of fabricating a new review pass. Operators recover by cleaning the branch and using `retrigger-remediation`; the stale `Request changes` review remains authoritative until a later clean round requests another pass.

## Reviewer Runtime Recovery Contract

The watcher's reviewer subprocess lifecycle is split across two durable ledgers:

- `data/reviews.db` keeps the review-delivery row for each PR, including `review_status='reviewing'` as the durable claim that a reviewer launch is in flight.
- `data/reviewer-runs/<sessionUuid>.json` keeps the runtime session record for that launch, including the adapter runtime id, process-group metadata, and the most recent lifecycle state observed by the runtime adapter.

`src/adapters/reviewer-runtime/cli-direct/index.mjs` is the canonical OAuth-first runtime today. When it advertises `oauthStripEnforced: true`, it must strip the full canonical OAuth fallback env set before spawning the reviewer subprocess: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, and `GEMINI_API_KEY`. Partial stripping is a contract violation because downstream code trusts the adapter capability bit.

The cli-direct reviewer subprocesses are non-streaming. Claude `--print` and Codex `exec --json --output-last-message` can spend a healthy full review turn without writing stdout or stderr, so cli-direct disables the no-output progress watchdog and relies on the hard reviewer timeout for bounding runtime. `ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS` remains the default for streaming subprocess helpers, but it does not apply to cli-direct reviewer launches.

Reviewer and follow-up worker children are bounce survivors. They must be spawned as detached session/process-group leaders (`setsid` semantics; Node `detached: true` on supported POSIX hosts) with durable stdout/stderr side channels and without parent-exit cleanup hooks that reap the child on routine watcher or follow-up daemon exit. A routine `launchctl kickstart -k`, SIGTERM, poll-deadline respawn, or SQLite-orphan respawn preserves in-flight work; the restarted daemon reconciles the durable claim rather than cancelling the child.

On watcher startup, `reconcileReviewerSessions` and `recoverReviewerRunRecords` must reconcile every recoverable reviewer-run record before any new reviewer claim can be admitted. Records in `spawned`, `heartbeating`, or `cancelled` state are all recoverable. For a live reviewer, adoption requires the durable `reviews.db` `reviewing` claim plus the recorded PGID and identity verification: the runtime run record's spawn token (`reviewer_session_uuid` / `reattachToken`) must still identify the process, and the PGID start time must match the recorded `spawnedAt` within the existing `verifyPgidIdentity` tolerance. A verified live child remains `reviewing` and must not be double-spawned or killed. A dead child with no posted review may be requeued through the existing retry path; ambiguous identity remains sticky rather than signalling an unrelated PGID.

Follow-up remediation workers use the same lifecycle shape through their job JSON: `remediationWorker.processGroupId`, `processId`, `spawnedAt`, and worker artifacts are the durable adoption/cancel handles. The follow-up daemon's ordinary SIGTERM path stops the daemon loop only; it does not stop spawned workers. Reconcile adopts by reading the in-progress job record and worker artifacts, and operator cancellation uses `src/follow-up-stop.mjs` / `src/follow-up-worker-cancel.mjs` with PGID plus start-time identity checks.

Intentional teardown is a separate operator surface: `npm run hard-shutdown -- [reason]` runs `src/adversarial-hard-shutdown.mjs`, cancels every `review_status='reviewing'` reviewer and every in-progress spawned follow-up worker, waits for signalled process groups, and returns non-zero if any live worker could not be signalled or remained alive through the wait window. This command is the only normal lifecycle path that cancels children before the daemons drop; routine bounces are survive-and-reattach.

## Round-Budget Derivation

Every fresh follow-up job derives its default cap from the PR's current risk class: `low=1`, `medium=2`, `high=3`, and `critical=4`. The PR-wide completed-round count is carried into each new job, so the cap bounds the full PR cycle instead of resetting per job.

Carry-forward of ordinary persisted caps is intentionally removed: if the latest stored cap is equal to or below the current risk-class tier, the next job lets `createFollowUpJob` derive the current tier cap again. This keeps stale queue JSON from permanently lifting or lowering the remediation budget after the PR's governing risk class changes.

The migration guard is deliberately narrow. If the latest PR ledger cap is higher than the current risk-class tier, the reviewer carries that elevated value into the next job. That preserves legacy in-flight PRs and operator-raised escape hatches that would otherwise be silently truncated after they have already consumed more rounds than the new tier allows.

The sanctioned operator override is `npm run retrigger-remediation` or the PR-side `retrigger-remediation` label. Both paths record an explicit operator mutation; hand-editing queue JSON is not the supported way to raise the cap.

## Auto-Merge Convergence Loop

The pipeline closes the loop on a PR by handing it to a merge-agent once the adversarial review converges. The merge-agent runs in the host agent-os worker-pool, not in adversarial-review itself; adversarial-review's responsibility is to (a) decide when to dispatch, (b) build the dispatch prompt, (c) record the dispatch, and (d) clean up consumed trigger labels.

Every durable dispatch record under `data/follow-up-jobs/merge-agent-dispatches/` persists the dispatch `trigger`, the resolved worker-pool `priority`, and `priorityFlagSupported`. On fully rolled-out hosts `priorityFlagSupported` is `true` and `hq dispatch` received `--priority <lane>`; on mixed-version hosts the watcher retries once without `--priority`, records `priorityFlagSupported: false`, and still preserves the resolved priority selection for auditability.

## Fast-Merge Close Path

The follow-up daemon also owns a narrow fast-merge close path for PRs whose first-pass review was intentionally skipped into `reviewed_prs.pr_state='fast_merge_skipped'`. This path is active only for rows that already carry a proven `fast_merge_authorized_head_sha`; the label alone is never sufficient authority.

Each poll makes up to `DEFAULT_FML_MERGE_AGENT_PER_POLL_CAP = 5` terminal fast-merge transitions unless operators override the cap with `FML_MERGE_AGENT_PER_POLL_CAP`. Rows that are still pending may be scanned past the cap, within a bounded over-read, so a few old pending PRs cannot starve newer mergeable rows.

For each row the daemon must:

- Re-fetch the PR view and refuse the bypass if the live head no longer matches `fast_merge_authorized_head_sha`.
- Requeue normal first-pass review instead of merging when the head changed, `fast-merge-veto` is present, or the live fast-merge authorization label is absent.
- Validate CI with `gh pr checks --json name,state,bucket,workflow,link`, treating CLI exits `8` (pending) and `1` (failed) as data-bearing results when stdout contains parseable JSON rather than as transport failures, and treating the real `gh` "no checks reported" diagnostic as an empty check set.
- Re-fetch and re-summarize CI in the immediate pre-merge window, after the head/veto/authorization-label re-check and before the admin merge.
- Merge only with `gh pr merge --squash --admin --delete-branch --match-head-commit <authorizedHeadSha>` so GitHub rejects the merge if the head moved after the last verification step.

The `--admin` flag is an intentional branch-protection bypass for this lane. The safety floor is therefore explicit and cumulative: the row must already be in the watcher-authorized fast-merge state, the live head must still equal the authorized SHA, CI must summarize as successful, an allowlisted `fast-merge:*` label must still be present, and `fast-merge-veto` must remain absent. If any of those predicates stop being true, the daemon must fail closed to the normal adversarial-review path or leave the row in `fast_merge_skipped` for a later poll; it must not broaden merge authority.

Fast-merge state transitions are audit-bearing. Successful merges persist `fast_merge_merged`; closed-unmerged PRs persist `fast_merge_closed`; deterministic refusals while the PR is provably still open persist `fast_merge_blocked`. Merge CLI errors are not authoritative on their own: before recording `fast_merge_blocked`, the daemon must re-fetch PR state and treat an already-merged PR as `fast_merge_merged` so a server-side merge followed by client timeout or branch-delete failure does not strand the row in a false blocked state. Merge audits should capture the real merge commit SHA from `gh pr view --json mergeCommit` when available rather than regex-scraping CLI output. Fast-merge audit JSON belongs under `data/fast-merge-audits/` rather than the reviewer runtime state directory, uses an explicit audit type to distinguish skip vs. close records, and must leave a pending retry marker on the row if a terminal close-path audit write fails.

### Dispatch trigger

`src/follow-up-merge-agent.mjs::pickMergeAgentDispatchDetail` evaluates dispatch in layers instead of applying one universal gate matrix to every trigger:

1. **Universal hard gates:** every dispatch path first requires `prState === 'open'` and `merged === false`, and refuses dispatch when `do-not-merge`, `no-merge-hold`, or `merge-agent-skip` is present. `merge-agent-stuck` is also a skip label by default, but a scoped current-head `merge-agent-requested` label is allowed to bypass that one marker for explicit operator recovery after the watcher exhausts its same-head retry budget. Duplicate dispatches for the same `(repo, prNumber, headSha)` are also blocked unless the watcher proves the recorded dispatch reached a watcher-owned retry state described below.
2. **`operator-approved` override:** a scoped `operator-approved` label is checked before the active-remediation gate. It can bypass review-verdict and remediation-round state for the current head, including a `request-changes` verdict or in-flight remediation, but it still requires `mergeable === 'MERGEABLE'` and a checks rollup of `SUCCESS`. That rollup excludes only the adversarial-review pipeline's own gate commit status (`agent-os/adversarial-gate` by default, resolved through `resolveGateStatusContext()`), because that status merely mirrors the already-known review verdict and would otherwise create a circular wait. Missing or malformed rollups remain unknown and still block this path; real external CI check runs and other status contexts continue to gate normally.
3. **Normal verdict path:** without a live override label, the latest follow-up job for the current head SHA must NOT be `pending` or `in-progress` (`in_progress` in the durable queue is normalized to `in-progress` at the merge-agent boundary). Older-head follow-up jobs do not block convergence for a newer reviewed head. Before any normal-verdict dispatch, the watcher reads the latest structured `## Blocking issues` section. Any known standing blocker (`blockingFindingCount > 0`) parks the dispatch at `skip-blockers-present` for every verdict, including `comment-only` and `approved`, unless a scoped operator override applies. Recovery is a fresh structured review whose blockers are `- None.`, a scoped `operator-approved` label that explicitly accepts the blockers, or a scoped `merge-agent-requested` label for that head. A clean `comment-only` verdict with no standing blockers dispatches immediately. That clean-verdict dispatch now carries the same converge-and-merge prompt contract as the budget-exhausted final pass: run `comment_only_followups.py`, apply actionable in-scope findings inline, wait only for real external CI on the pushed head, ignore the adversarial-review gate status as a merge blocker, and request another adversarial pass only for major in-PR refactors. A `request-changes` verdict dispatches only when the remediation budget is exhausted; if more rounds are claimable, the merge-agent waits for current-head remediation instead of racing it.
4. **`merge-agent-requested` override:** a scoped `merge-agent-requested` label is the explicit "run the merge-agent now" escape hatch. It still respects the universal hard gates and the active-remediation guard, but it can bypass mergeability, checks, verdict parsing, and remediation-round exhaustion so the merge-agent can rebase or clean the branch on demand.
5. **Final-pass-on-budget-exhausted:** when `MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES=1` is set in the per-call env (set on the follow-up daemon LaunchAgent in this repo) AND `remediationCurrentRound >= remediationMaxRounds` AND the verdict is still `request-changes` AND no scoped `operator-approved` label is present, the watcher first inspects the latest structured `## Blocking issues` section. A section with any standing blocker produces `skip-blockers-present`; a legacy or malformed `Request changes` review with no structured blocking section produces `skip-blocking-findings-unknown`. Both states fail closed, write a durable skipped-dispatch record under `data/follow-up-jobs/merge-agent-skips/`, and do not apply a sticky label. Recovery is one of: remediate and obtain a fresh structured review whose blockers are `- None.`, apply a scoped `operator-approved` label to explicitly accept the blockers, or apply a scoped `merge-agent-requested` label when the operator intentionally wants the merge-agent escape hatch for that head. Only when blocker state is known and the blocking count is zero is the merge-agent dispatched with the trigger `final-pass-on-budget-exhausted`. The merge-agent's own `comment_only_followups.py` sub-worker is then responsible for the final substance triage: **apply every actionable in-scope reviewer finding inline (trivial polish and substantive non-trivial work alike), merge after light-to-medium fixes, and request a fresh review pass only for major in-PR refactors**. The previous policy of "apply trivial, defer non-trivial" is gone — see the "Apply, don't defer" subsection below. The merge-agent hard-refuses (`merge-rejected`) when the sub-worker surfaces a non-empty `blockers_observed` list (data corruption, secret leakage, security regression, broken external contract); blocker receipts/log summaries include only blocker count and normalized kinds, while detailed payloads stay in `.adversarial-follow-up/followups-reply.json` so secret-leakage findings are not echoed back into public surfaces. Items the sub-worker records under `suggestions_unable_to_apply` (multi-PR scope, cross-module refactor, conflicts with PR intent) are not a handoff shortcut: the merge-agent must file Linear tickets for each follow-up refactor and proceed with the merge when no blocker remains. The dispatched worker receives the trigger via the `MERGE_AGENT_DISPATCH_TRIGGER` env var (machine-readable) AND in the rendered prompt's `{{DISPATCH_TRIGGER}}` placeholder, so the merge-agent's adapter and prompt can branch on dispatch mode without parsing markdown. The universal hard gates, the `mergeable === 'MERGEABLE'` requirement, and the `SUCCESS` check rollup requirement all still apply — failing CI or a conflicted PR still skips even with the flag enabled.

### Dispatch priority

Merge-agent priority is narrower than merge-agent triggering:

- Default behavior is `--priority normal` for clean-verdict dispatches, `operator-approved`, and `final-pass-on-budget-exhausted`.
- Only the scoped `merge-agent-requested` trigger uses `--priority critical`.

That split is intentional. `merge-agent-requested` is the operator's explicit stuck-branch escape hatch, and the observed 2026-05-19 outage was exactly that path getting wedged behind `refuse_admit_memory_pressure`. By contrast, clean-verdict and final-pass merge-agents can run for minutes, push commits, and wait on checks; sending every one of those to the single reserved critical lane would turn a PR-local admission problem into fleet-wide starvation of genuinely urgent critical work.

The worker-pool priority lane is governed by `HQ_PRIORITY_LANE_CAPACITY` (default `1`). When that env var is `0`, the reserved lane is disabled and a `critical` dispatch no longer bypasses memory-pressure refusal; it degrades to ordinary high-priority admission. Operators investigating contention should check `hq priority-lane status --root /Users/airlock/agent-os-hq` alongside the recorded dispatch JSON and the individual LRQ state from `hq dispatch status <dispatchId>`.

Because watcher and worker-pool can roll out independently, `src/follow-up-merge-agent.mjs::dispatchMergeAgentForPR` must treat an explicit CLI rejection of `--priority` as a compatibility downgrade, not a hard dispatch failure. The watcher first tries the flagged invocation, then retries once without `--priority` only for the specific unknown-argument / unrecognized-argument class of error. Any other `hq dispatch` failure still aborts the launch normally.

### Merge-agent original-worker preparation

Before `src/follow-up-merge-agent.mjs::dispatchMergeAgentForPR` launches `hq dispatch --worker-class merge-agent`, it runs `prepareOriginalWorkerForMergeAgent` to free the PR branch from the original builder worktree without reaching for `git worktree add --force`.

- The original worker id is derived from the PR branch prefix, then validated against the recognized worker-id shape before any filesystem probe or `hq` invocation. Human branches like `paul/my-feature` do not opt into teardown; suspicious or non-worker-shaped prefixes emit `merge_agent.tear_down_skipped` with reason `unrecognized-worker-id-shape`.
- If the worker directory is gone, or the recorded worktree path no longer exists on disk, prep returns `decision: 'ready'` with reason `original-worker-already-torn-down`. This is the idempotent "already gone" exit.
- If `HQ_ROOT/workers/<workerId>/workspace.json` is missing while the worker directory still exists, prep logs `merge_agent.workspace_missing` and returns `decision: 'deferred'` with reason `workspace-json-missing-but-worker-dir-present`. A missing marker file is not treated as proof that the branch is free.
- If the workspace file cannot be read for a reason other than `ENOENT` (for example permissions drift or malformed JSON), prep logs `merge_agent.workspace_read_failed` with the errno/detail and returns `decision: 'deferred'`. Read failures are not treated as proof that the branch is free.
- If `workspace.json` is present, prep validates both `workspace.workerId` and `workspace.branch` against the derived worker id and PR branch before any teardown. Mismatches emit `merge_agent.tear_down_skipped` and return `decision: 'ready'` without touching the worker.
- If the worker directory and worktree still exist, prep consults `worker_runs.status` from the session ledger, resolving the DB from `AGENT_OS_SESSION_LEDGER_DB_PATH`, `HQ_ROOT/.hq/config.json#ledgerDbPath`, the HQ-root owner's canonical `$HOME/.agent-os/session-ledger/ledger.db`, or the runtime user's canonical ledger path. When the row is missing but the worktree is still present, prep logs `merge_agent.dispatch_deferred` and returns `decision: 'deferred'` with reason `original-worker-run-row-missing-but-worktree-present`; ledger drift is not treated as branch freedom, and override-triggered dispatches do not bypass that fail-closed liveness check.
- Prep may tear down the original worker only when the current `worker_runs.status` is terminal according to the session-ledger contract (`succeeded`, `failed`, or `cancelled`). A non-terminal status logs `merge_agent.dispatch_deferred` with `reason: worker-run-status-<status>`.
- Operational lookup failures such as `missing-ledger-db`, `better-sqlite3-unavailable`, `worker-run-lookup-failed`, `worker-run-lookup-threw`, and `missing-launch-request-id` become explicit skipped-dispatch records instead of unbounded silent deferrals. `better-sqlite3-unavailable` also logs a loud dependency error. Convergence parks caused by standing blockers (`skip-blockers-present`) in any verdict path or legacy/unknown blocker state (`skip-blocking-findings-unknown`) in the final-pass path write the same durable skipped-dispatch record under `data/follow-up-jobs/merge-agent-skips/` with the blocker count/state.
- The mutating teardown call honors Agent OS ownership boundaries. If `HQ_ROOT` owner cannot be proven, the runtime user cannot be resolved, or the watcher user differs from the HQ owner, prep emits `merge_agent.tear_down_skipped` and returns `decision: 'deferred'` without attempting cross-user mutation. Successful teardown logs `merge_agent.original_worker_torn_down` with the PR number, original worker id, worker status, and launch request id.

The four stable prep outcomes are therefore:

- `ready` because no worker-authored branch was detected or the original worker was already gone.
- `deferred` because the original worktree is still present but not yet safely reclaimable.
- `torn-down` because prep reclaimed the branch successfully.
- `dispatch-deferred` at the caller boundary when `dispatchMergeAgentForPR` receives a prep `decision: 'deferred'` and skips the merge-agent launch for that watcher tick.

A clean (`comment-only`) verdict triggers the merge-agent immediately on the first review pass that returns clean — the dispatch path does NOT wait for the round budget to exhaust. Waiting for the budget cap on a clean verdict was the gate that left PR #90 stuck in May 2026 burning unused remediation rounds with nothing to remediate. Once dispatched on that clean verdict, the merge-agent follows the same merge-by-default convergence contract as the final-pass trigger, except without the budget-exhausted framing: it should finish bounded in-PR follow-ups, wait only for real external CI, and merge unless the work turns into a genuinely major in-PR refactor that merits re-review. Rounds-available remains a gate for `request-changes` verdicts so the merge-agent does not race an in-flight remediation cycle.

#### Why a fifth dispatch path exists

Without the final-pass path, every PR whose verdict never converges to `Comment only` halts at `max-rounds-reached` and waits for the operator. In practice the codex reviewer almost always returns `Request changes` because the reviewer prompt is adversarial by design; the lenient final-round addendum relaxes *categorization* but keeps the *verdict* at `Request changes` whenever any finding remains. Result: the auto-merge daemon never auto-merged a single PR in the observed window leading up to 2026-05-14. The final-pass dispatch path closes that loop by giving the merge-agent itself the responsibility for the final substance check — the merge-agent's `comment_only_followups.py` is the right place to decide whether reviewer findings warrant blocking a merge or warrant another review round on a freshly-pushed head.

This is a behavioral expansion of the merge contract, **enabled by default in code** as of 2026-05-16 (see `isFinalPassOnRequestChangesEnabled` in `src/follow-up-merge-agent.mjs`). The legacy halt-at-max-rounds behavior stranded every PR at the operator's desk — the remediation worker is not the right actor to decide whether a PR can merge on its final commit, and the merge-agent + `comment_only_followups.py` sub-worker are the right place for the final substance triage. The `MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES` env var stays as an explicit off-switch (`=0`, `=false`, or `=no`) for OSS deployments or forks that need the legacy halt behavior. The merge-agent decision happens in the **watcher** process, so any environment override must be set on the watcher LaunchAgent (not the follow-up daemon). The universal hard-skip labels (`do-not-merge`, `merge-agent-skip`, `merge-agent-stuck`) work as emergency brakes per-PR regardless. Re-tune risk-class budgets independently if needed.

#### Apply, don't defer

The previous final-pass contract instructed the `comment_only_followups.py` sub-worker to apply trivial findings inline and defer non-trivial findings to operator handoff (`fail_with_receipt 13 merge-rejected`). That gate fired on the dominant path — most non-trivial reviewer findings — and effectively meant the auto-merge loop never closed on its own. The current contract:

- The sub-worker **applies every actionable in-scope reviewer finding inline**, trivial or non-trivial. It edits the workspace, commits each logical adjustment, and reports the changed files in `files_changed`.
- If applying a finding would require more than one PR (multi-PR scope, schema-migration plan, cross-module refactor, refactor that changes PR intent), the sub-worker records it under `suggestions_unable_to_apply` with a concrete reasoning string and the merge-agent files Linear tickets for each follow-up. These tickets are the durable follow-up mechanism; they are not merely listed in a PR comment. The merge-agent then proceeds with the merge when no blocker remains.
- If a finding describes a **blocker-class** problem the sub-worker cannot safely fix in this PR — data corruption, secret leakage, security regression, broken external contract — the sub-worker records it under `blockers_observed`. The merge-agent hard-refuses (`merge-rejected`) when this list is non-empty even if other findings were applied successfully.
- Inline review comments (line-anchored review comments on the PR diff, head-filtered to the reviewer-bot logins) are pulled into the sub-worker's prompt via `{{REVIEWER_INLINE_COMMENTS}}` so the sub-worker treats them as findings on par with the review body.

In short: non-trivial work that fits in this PR is no longer an operator-handoff trigger. The merge-agent applies light-to-medium edits, force-pushes, waits for checks, and merges. It requests another review only for major in-PR refactors. Follow-up refactors outside the PR boundary become Linear tickets and do not strand the current PR.

### Convergence cycle

Each merge-agent invocation either MERGES the PR or exits with `awaiting-rereview` to hand control back to adversarial-review. The cycle then iterates:

1. Adversarial review pass returns a verdict.
2. If `comment-only` → merge-agent dispatches.
3. Merge-agent attempts the rebase / response / push flow.
4. If the merge-agent makes major in-PR refactor changes, it exits `awaiting-rereview` and force-pushes the new head. The watcher's next tick sees a new head SHA, schedules a fresh review pass, and the cycle continues from step 1. Suppress that stale-posted-review auto-refresh only while the merge-agent is provably still converging for the current head: a current-head scoped `merge-agent-requested` label or a live current-head dispatch state. Raw label presence by itself is not authoritative because cleanup lag and stale labels must not wedge the rereview handoff. Light-to-medium edits do not take this path; they are pushed, checked, and merged.
5. If the merge-agent makes no substantive changes (clean rebase, no follow-up code edits) AND the PR's checks remain green for the rebased SHA, it merges via `gh pr merge --merge`.

The cycle terminates when (a) the merge succeeds, (b) the operator applies a skip label, or (c) the merge-agent applies `merge-agent-stuck` after exhausting its retry policy, or the watcher applies `merge-agent-stuck` after a phantom-handoff escalation. The round budget caps the adversarial review side; the merge-agent's own retry policy caps the merge side. Neither bounds the OTHER side, so a worst-case cycle is `rounds × merge-attempts` — operators should keep the budgets aligned.

### OSS guard

`src/follow-up-merge-agent.mjs::detectAgentOsPresence` runs before every dispatch. If `hq` is not on PATH and `HQ_BIN` is unset and the operator has not set `ADV_REVIEW_MERGE_AGENT_AGENT_OS=1`, the dispatch path returns `{ decision: 'skip-no-agent-os' }` without invoking hq. This keeps OSS deployments and CI sandboxes usable: the watcher, reviewer, remediation, and verdict pipeline continue working; auto-merge becomes a manual operator step. Detection merges any per-call environment override over `process.env` before probing or launching, so sparse overrides do not drop PATH, HOME, auth, or other runtime state. An explicit `hqPath` argument takes precedence over ambient `HQ_BIN`; `HQ_BIN` and PATH resolution are fallbacks only when the caller did not supply a non-default binary path.

The operator can also force-disable merge-agent on a host that DOES have agent-os installed by setting `ADV_REVIEW_MERGE_AGENT_DISABLED=1`. This is the supported way to pause auto-merge during a release freeze without touching the source. A skipped launch writes an explicit record under `data/follow-up-jobs/merge-agent-skips/<repo>-pr-<n>-<headSha>.json` so operators can distinguish an intentional OSS/disabled-mode skip from an unobserved watcher tick.

### Trigger labels

- `operator-approved` — scoped operator override for the current head SHA. It bypasses review/remediation-state gates, including an active remediation job, but does NOT bypass open-PR, hard-skip, mergeability, or green-check requirements. Consumed (removed from the PR) after a successful dispatch, or after an acknowledged `skip-no-agent-os` when agent-os is missing or merge-agent dispatch is force-disabled.
- `merge-agent-requested` — explicit scoped request to fire a merge-agent pass for the current head SHA even when the standard verdict gate would skip. It still respects open-PR, hard-skip, active-remediation, and duplicate-dispatch guards, but it can bypass mergeability, checks, verdict parsing, and remediation-round exhaustion. Consumed after a successful dispatch, or after an acknowledged `skip-no-agent-os` when agent-os is missing or merge-agent dispatch is force-disabled.
- `merge-agent-skip`, `do-not-merge`, `no-merge-hold` — hard skips that even an operator-approved or merge-agent-requested label does not bypass. `merge-agent-stuck` is a hard skip by default, but a scoped current-head `merge-agent-requested` label may bypass it for explicit operator recovery.

The `final-pass-on-budget-exhausted` trigger is **not** a label — it is selected automatically by the dispatch decision tree when the env flag is set and the round budget is consumed. There is no GitHub-visible label for it; the audit trail is the dispatch record (`data/follow-up-jobs/merge-agent-dispatches/<repo>-pr-<n>-<headSha>.json`, `trigger`, `priority`, and `priorityFlagSupported` fields) plus the `MERGE_AGENT_DISPATCH_TRIGGER` env var passed to the worker.

Repeated reviewer no-output timeouts are infrastructure failures, not substantive review rounds. They must not increment the remediation round counter or make the next reviewer pass "final" by themselves. After two timeout-class failures for the same PR head, the watcher may switch to the alternate reviewer model for the next retry (`ADVERSARIAL_REVIEW_TIMEOUT_FALLBACK_MODEL=auto`, or explicitly `claude`/`codex`; `off` disables the switch). If the timeout budget is exhausted after a remediation round completed with `reReview.requested=true`, the watcher must not strand the PR behind a green-ish timeout gate: it routes the head through the merge-agent decision path with trigger `reviewer-timeout-exhausted`. A mergeable PR with green external checks can then be cleaned/merged by merge-agent policy; a non-mergeable or checks-blocked PR records a durable skip under `data/follow-up-jobs/merge-agent-skips/` with the timeout trigger so operators see a concrete mergeability/check blocker instead of an ambiguous stalled review.

### Dispatch state

Successful dispatches write a record under `data/follow-up-jobs/merge-agent-dispatches/<repo>-pr-<n>-<headSha>.json`. Each record carries the dispatch timestamp, the trigger label (or null for the standard verdict path), the resolved priority selection, whether the host actually supported `--priority`, the resulting `dispatchId` and `launchRequestId` from the hq invocation, and the label-removal attempt result. The same record is also the durable watcher-side handoff ledger: when a terminal-failed dispatch clears `merge-agent-dispatched` without establishing recovery, the watcher stamps `phantomHandoffObservedAt` on the first tick that proves the gap and starts the 60-minute grace from that timestamp, not from the original dispatch creation time. That detection is proactive and keyed to the current PR head, not just the normal merge-agent revisit set, so a label-cleared orphan can still enter the grace/escalation state machine. If the grace expires with no recovery ownership, the watcher first persists pending phantom-handoff comment-delivery state on the dispatch record, then converges the `merge-agent-stuck` label and owed operator comment from that ledger. Later ticks replay whichever side effect is still missing, so a partial failure after the label transition cannot permanently lose the human-facing explanation. Pre-existing dispatches with the same `(repo, prNumber, headSha)` triple normally short-circuit a second dispatch via the `skip-already-dispatched` decision, and the consumed-label removal is retried best-effort each tick until the label is observed gone from the PR.

The watcher now also owns a bounded retry path for same-head merge-agent failures. If the recorded LRQ is terminal `failed`, `superseded`, or authoritative `not-found`, the watcher may clear the duplicate-dispatch guard and launch one replacement worker for the same head, bounded by `watcherReDispatchCount` in the dispatch record. `cancelled` / `canceled` are deliberately excluded from this autonomous path; reviving an intentionally cancelled merge-agent still requires an explicit scoped `merge-agent-requested` label. The public `merge-agent-dispatched` label is not the only handoff oracle: an unresolved `data/follow-up-jobs/merge-agent-lifecycle-cleanups/<repo>-pr-<n>.json` record with `transition: "dispatched-label-add"` keeps the dispatch in watcher-owned state even when the label never landed on GitHub, so a failed label add cannot wedge the PR on `skip-already-dispatched` forever. Once the label is cleared and the worker is terminal-failed, the watcher switches from retry ownership to phantom-handoff grace tracking via `phantomHandoffObservedAt`; that conservative clock prevents long-running original dispatches from being escalated immediately when the missing-handoff state is only newly observed.

`not-found` is authoritative only when the watcher definitely proved cross-account visibility by passing `--as-owner <hq owner>` to `hq dispatch status`. If `.hq/config.json` cannot be read, is malformed, or lacks `ownerUser`, the watcher logs the degraded owner-visibility state, refuses to classify the LRQ as gone, and leaves duplicate-dispatch protection in force for that tick.
