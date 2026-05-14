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

## Adversarial Gate Commit Status

The watcher projects the durable adversarial-review ledger onto the PR head SHA as a GitHub commit status with context `agent-os/adversarial-gate`.

Operators must require `agent-os/adversarial-gate` in branch protection before relying on GitHub-native merge or auto-merge for adversarial-review-gated branches. Without the required context, GitHub can merge while review, remediation, or operator handling is still pending.

The watcher verifies that policy in process: on a cached interval it checks watched repositories' branch protection and logs `branch-protection-warning` when `agent-os/adversarial-gate` is missing or the protection endpoint cannot be read. Operators can run the same probe with `npm run check-branch-protection`.

State mapping:

| State | Meaning |
|---|---|
| `pending` | Review has not posted, review is queued/in progress, a posted review is waiting for the follow-up ledger to appear, remediation is queued/in progress, or a requested re-review has not posted yet. |
| `success` | The latest posted review settled as `Comment only` or `Approved` in its durable follow-up verdict carrier, or a current scoped `operator-approved` label accepts the PR head regardless of review/remediation state and no explicit skip label is present. |
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
| `reviewer-timeout` | `failure` | The reviewer timed out before posting. |
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

Clean review verdicts still create follow-up jobs for auditability and gate projection. When the consumer sees a `Comment only` or `Approved` verdict, it moves that job to `stopped` with `review-settled` instead of spawning a remediation worker.

The watcher must project the gate on terminal early-exit paths, including already-posted review rows. A settled PR must not stay frozen at an earlier `pending` projection after the durable review verdict is available.

## Operator Retrigger Contracts

`retrigger-review` and `retrigger-remediation` are separate operator surfaces:

- `retrigger-review` resets the watcher delivery row to `review_status='pending'` so the watcher can post another adversarial review.
- `retrigger-remediation` bumps the remediation budget and requeues the latest eligible terminal follow-up job. It does not reset `reviews.db` first; the next fresh adversarial review must come from the requeued worker's durable `reReview.requested=true` reply during normal reconciliation. Eligible terminal jobs are `failed`, `completed` with `reReview.requested=true`, or `stopped` with one of `max-rounds-reached`, `round-budget-exhausted`, `daemon-bounce-safety`, or `review-settled`. `stopped:review-settled` is retriggerable because the automatic loop has settled the review as non-blocking, but an explicit operator action can still request a worker pass over the remaining findings. That retrigger is carried durably on `remediationPlan.nextAction={type:'consume-pending-round', operatorOverride:true, requestedAt, requestedBy, operatorVisibility:'explicit'}`; `claimNextFollowUpJob` must suppress the claim-time `review-settled` early-stop for that one claim, then consume the override by rewriting `nextAction` to `worker-spawn`. While the requeued job is `pending` or `inProgress`, the adversarial gate must stay pending rather than projecting the stored Comment-only verdict as settled. `stopped:operator-stop` and `stopped:rereview-blocked` are intentionally not retriggerable through this surface because those states encode operator intent or a watcher refusal that needs human handling.

For PR-side `retrigger-remediation` labels, a successful budget bump is the durable consumption boundary. Once the bump lands, the watcher must write the label-consumption record and operator-mutation audit before attempting the queue rearm. If requeue then fails, the watcher still removes the label and posts a failure-flavored acknowledgement that names the partial-success state; the same GitHub label event must not authorize another budget bump on retry.

The watcher must not run a fresh adversarial review while the latest follow-up job for the same PR is `pending` or `inProgress`. This guard is load-bearing for the PR #48 race: if an operator requeues remediation while the watcher row is already `pending`, the pending follow-up job wins and reviewer dispatch is deferred until the worker reaches a terminal state.

## Reviewer Runtime Recovery Contract

The watcher's reviewer subprocess lifecycle is split across two durable ledgers:

- `data/reviews.db` keeps the review-delivery row for each PR, including `review_status='reviewing'` as the durable claim that a reviewer launch is in flight.
- `data/reviewer-runs/<sessionUuid>.json` keeps the runtime session record for that launch, including the adapter runtime id, process-group metadata, and the most recent lifecycle state observed by the runtime adapter.

`src/adapters/reviewer-runtime/cli-direct/index.mjs` is the canonical OAuth-first runtime today. When it advertises `oauthStripEnforced: true`, it must strip the full canonical OAuth fallback env set before spawning the reviewer subprocess: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, and `GEMINI_API_KEY`. Partial stripping is a contract violation because downstream code trusts the adapter capability bit.

On watcher startup, `recoverReviewerRunRecords` must reconcile every recoverable reviewer-run record, not just records that still look actively heartbeating. Records in `spawned`, `heartbeating`, or `cancelled` state are all recoverable because a parent SIGTERM can cancel the child launch after the SQLite row has already moved to `review_status='reviewing'`. If reattach fails for one of those records, recovery must flip the matching SQLite row from `reviewing` to `failed` with a daemon-bounce message so the PR can be retried; it must not leave the row stuck waiting for a GitHub-side orphan reconciliation that may never exist.

The cli-direct runtime does not adopt a live process group after a daemon bounce unless reviewer identity verification exists for that process. When recovery finds the recorded process group still alive, it must read any side-channel tails best-effort, signal the whole process group with SIGTERM, escalate to SIGKILL after the configured grace period, mark the run record failed, and return a structured `daemon-bounce` result. That refusal always re-queues the review instead of treating a late original completion as authoritative, and it must not throw because of side-channel read errors or one bad record would block recovery of the remaining records.

## Round-Budget Derivation

Every fresh follow-up job derives its default cap from the PR's current risk class: `low=1`, `medium=2`, `high=3`, and `critical=4`. The PR-wide completed-round count is carried into each new job, so the cap bounds the full PR cycle instead of resetting per job.

Carry-forward of ordinary persisted caps is intentionally removed: if the latest stored cap is equal to or below the current risk-class tier, the next job lets `createFollowUpJob` derive the current tier cap again. This keeps stale queue JSON from permanently lifting or lowering the remediation budget after the PR's governing risk class changes.

The migration guard is deliberately narrow. If the latest PR ledger cap is higher than the current risk-class tier, the reviewer carries that elevated value into the next job. That preserves legacy in-flight PRs and operator-raised escape hatches that would otherwise be silently truncated after they have already consumed more rounds than the new tier allows.

The sanctioned operator override is `npm run retrigger-remediation` or the PR-side `retrigger-remediation` label. Both paths record an explicit operator mutation; hand-editing queue JSON is not the supported way to raise the cap.

## Auto-Merge Convergence Loop

The pipeline closes the loop on a PR by handing it to a merge-agent once the adversarial review converges. The merge-agent runs in the host agent-os worker-pool, not in adversarial-review itself; adversarial-review's responsibility is to (a) decide when to dispatch, (b) build the dispatch prompt, (c) record the dispatch, and (d) clean up consumed trigger labels.

### Dispatch trigger

`src/follow-up-merge-agent.mjs::pickMergeAgentDispatchDetail` evaluates dispatch in layers instead of applying one universal gate matrix to every trigger:

1. **Universal hard gates:** every dispatch path first requires `prState === 'open'` and `merged === false`, and refuses dispatch when `do-not-merge`, `merge-agent-skip`, or `merge-agent-stuck` is present. Duplicate dispatches for the same `(repo, prNumber, headSha)` are also blocked.
2. **`operator-approved` override:** a scoped `operator-approved` label is checked before the active-remediation gate. It can bypass review-verdict and remediation-round state for the current head, including a `request-changes` verdict or in-flight remediation, but it still requires `mergeable === 'MERGEABLE'` and a checks rollup of `SUCCESS`. Unknown, pending, or failed checks still block this path.
3. **Normal verdict path:** without a live override label, the latest follow-up job must NOT be `pending` or `in-progress`. A clean `comment-only` verdict dispatches immediately. A `request-changes` verdict dispatches only when the remediation budget is exhausted; if more rounds are claimable, the merge-agent waits for remediation instead of racing it.
4. **`merge-agent-requested` override:** a scoped `merge-agent-requested` label is the explicit "run the merge-agent now" escape hatch. It still respects the universal hard gates and the active-remediation guard, but it can bypass mergeability, checks, verdict parsing, and remediation-round exhaustion so the merge-agent can rebase or clean the branch on demand.
5. **Final-pass-on-budget-exhausted:** when `MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES=1` is set in the per-call env (set on the follow-up daemon LaunchAgent in this repo) AND `remediationCurrentRound >= remediationMaxRounds` AND the verdict is still `request-changes` AND no scoped `operator-approved` label is present, the merge-agent is dispatched with the trigger `final-pass-on-budget-exhausted`. The merge-agent's own `comment_only_followups.py` sub-worker is then responsible for the final substance triage: **apply every actionable in-scope reviewer finding inline (trivial polish and substantive non-trivial work alike) and request a fresh review pass** when anything substantive lands. The previous policy of "apply trivial, defer non-trivial" is gone — see the "Apply, don't defer" subsection below. The merge-agent hard-refuses (`merge-rejected`) when the sub-worker surfaces a non-empty `blockers_observed` list (data corruption, secret leakage, security regression, broken external contract); items the sub-worker records under `suggestions_unable_to_apply` (multi-PR scope, conflicts with PR intent) route through `awaiting-rereview` so the next reviewer pass evaluates whether the punt is acceptable. The dispatched worker receives the trigger via the `MERGE_AGENT_DISPATCH_TRIGGER` env var (machine-readable) AND in the rendered prompt's `{{DISPATCH_TRIGGER}}` placeholder, so the merge-agent's adapter and prompt can branch on dispatch mode without parsing markdown. The universal hard gates, the `mergeable === 'MERGEABLE'` requirement, and the `SUCCESS` check rollup requirement all still apply — failing CI or a conflicted PR still skips even with the flag enabled.

A clean (`comment-only`) verdict triggers the merge-agent immediately on the first review pass that returns clean — the dispatch path does NOT wait for the round budget to exhaust. Waiting for the budget cap on a clean verdict was the gate that left PR #90 stuck in May 2026 burning unused remediation rounds with nothing to remediate. Rounds-available remains a gate for `request-changes` verdicts so the merge-agent does not race an in-flight remediation cycle.

#### Why a fifth dispatch path exists

Without the final-pass path, every PR whose verdict never converges to `Comment only` halts at `max-rounds-reached` and waits for the operator. In practice the codex reviewer almost always returns `Request changes` because the reviewer prompt is adversarial by design; the lenient final-round addendum relaxes *categorization* but keeps the *verdict* at `Request changes` whenever any finding remains. Result: the auto-merge daemon never auto-merged a single PR in the observed window leading up to 2026-05-14. The final-pass dispatch path closes that loop by giving the merge-agent itself the responsibility for the final substance check — the merge-agent's `comment_only_followups.py` is the right place to decide whether reviewer findings warrant blocking a merge or warrant another review round on a freshly-pushed head.

This is a behavioral expansion of the merge contract, **enabled by default on this deployment** via `MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES=1` on `launchd/ai.laceyenterprises.adversarial-follow-up.{airlock,placey}.plist`. OSS deployments and forks that have not flipped that env stay on the legacy "halt at max-rounds-reached" behavior. Operators can flip it off again with a one-line plist edit + `launchctl bootout && bootstrap` of the daemon; the universal hard-skip labels (`do-not-merge`, `merge-agent-skip`, `merge-agent-stuck`) work as emergency brakes per-PR even with the flag on. Re-tune risk-class budgets independently if needed.

#### Apply, don't defer

The previous final-pass contract instructed the `comment_only_followups.py` sub-worker to apply trivial findings inline and defer non-trivial findings to operator handoff (`fail_with_receipt 13 merge-rejected`). That gate fired on the dominant path — most non-trivial reviewer findings — and effectively meant the auto-merge loop never closed on its own. The current contract:

- The sub-worker **applies every actionable in-scope reviewer finding inline**, trivial or non-trivial. It edits the workspace, commits each logical adjustment, and reports the changed files in `files_changed`.
- If applying a finding would require more than one PR (multi-PR scope, schema-migration plan, refactor that changes PR intent), the sub-worker records it under `suggestions_unable_to_apply` with a concrete reasoning string and does NOT auto-reject. The merge-agent routes that to `awaiting-rereview` so the next reviewer pass evaluates whether the punt is acceptable.
- If a finding describes a **blocker-class** problem the sub-worker cannot safely fix in this PR — data corruption, secret leakage, security regression, broken external contract — the sub-worker records it under `blockers_observed`. The merge-agent hard-refuses (`merge-rejected`) when this list is non-empty even if other findings were applied successfully.
- Inline review comments (line-anchored review comments on the PR diff, head-filtered to the reviewer-bot logins) are pulled into the sub-worker's prompt via `{{REVIEWER_INLINE_COMMENTS}}` so the sub-worker treats them as findings on par with the review body.

In short: non-trivial work that fits in this PR is no longer an operator-handoff trigger. The merge-agent applies it, force-pushes, and lets the next reviewer pass be the judge.

### Convergence cycle

Each merge-agent invocation either MERGES the PR or exits with `awaiting-rereview` to hand control back to adversarial-review. The cycle then iterates:

1. Adversarial review pass returns a verdict.
2. If `comment-only` → merge-agent dispatches.
3. Merge-agent attempts the rebase / response / push flow.
4. If the merge-agent makes substantive changes (non-trivial conflict resolution, comment-only-followup edits that change behavior), it exits `awaiting-rereview` and force-pushes the new head. The watcher's next tick sees a new head SHA, schedules a fresh review pass, and the cycle continues from step 1.
5. If the merge-agent makes no substantive changes (clean rebase, no follow-up code edits) AND the PR's checks remain green for the rebased SHA, it merges via `gh pr merge --merge`.

The cycle terminates when (a) the merge succeeds, (b) the operator applies a skip label, or (c) the merge-agent applies `merge-agent-stuck` after exhausting its retry policy. The round budget caps the adversarial review side; the merge-agent's own retry policy caps the merge side. Neither bounds the OTHER side, so a worst-case cycle is `rounds × merge-attempts` — operators should keep the budgets aligned.

### OSS guard

`src/follow-up-merge-agent.mjs::detectAgentOsPresence` runs before every dispatch. If `hq` is not on PATH and `HQ_BIN` is unset and the operator has not set `ADV_REVIEW_MERGE_AGENT_AGENT_OS=1`, the dispatch path returns `{ decision: 'skip-no-agent-os' }` without invoking hq. This keeps OSS deployments and CI sandboxes usable: the watcher, reviewer, remediation, and verdict pipeline continue working; auto-merge becomes a manual operator step. Detection merges any per-call environment override over `process.env` before probing or launching, so sparse overrides do not drop PATH, HOME, auth, or other runtime state. An explicit `hqPath` argument takes precedence over ambient `HQ_BIN`; `HQ_BIN` and PATH resolution are fallbacks only when the caller did not supply a non-default binary path.

The operator can also force-disable merge-agent on a host that DOES have agent-os installed by setting `ADV_REVIEW_MERGE_AGENT_DISABLED=1`. This is the supported way to pause auto-merge during a release freeze without touching the source. A skipped launch writes an explicit record under `data/follow-up-jobs/merge-agent-skips/<repo>-pr-<n>-<headSha>.json` so operators can distinguish an intentional OSS/disabled-mode skip from an unobserved watcher tick.

### Trigger labels

- `operator-approved` — scoped operator override for the current head SHA. It bypasses review/remediation-state gates, including an active remediation job, but does NOT bypass open-PR, hard-skip, mergeability, or green-check requirements. Consumed (removed from the PR) after a successful dispatch, or after an acknowledged `skip-no-agent-os` when agent-os is missing or merge-agent dispatch is force-disabled.
- `merge-agent-requested` — explicit scoped request to fire a merge-agent pass for the current head SHA even when the standard verdict gate would skip. It still respects open-PR, hard-skip, active-remediation, and duplicate-dispatch guards, but it can bypass mergeability, checks, verdict parsing, and remediation-round exhaustion. Consumed after a successful dispatch, or after an acknowledged `skip-no-agent-os` when agent-os is missing or merge-agent dispatch is force-disabled.
- `merge-agent-skip`, `merge-agent-stuck`, `do-not-merge` — hard skips that even an operator-approved label does not bypass.

The `final-pass-on-budget-exhausted` trigger is **not** a label — it is selected automatically by the dispatch decision tree when the env flag is set and the round budget is consumed. There is no GitHub-visible label for it; the audit trail is the dispatch record (`data/follow-up-jobs/merge-agent-dispatches/<repo>-pr-<n>-<headSha>.json`, `trigger` field) plus the `MERGE_AGENT_DISPATCH_TRIGGER` env var passed to the worker.

### Dispatch state

Successful dispatches write a record under `data/follow-up-jobs/merge-agent-dispatches/<repo>-pr-<n>-<headSha>.json`. Each record carries the dispatch timestamp, the trigger label (or null for the standard verdict path), the resulting `dispatchId` and `launchRequestId` from the hq invocation, and the label-removal attempt result. Pre-existing dispatches with the same `(repo, prNumber, headSha)` triple short-circuit a second dispatch via the `skip-already-dispatched` decision, and the consumed-label removal is retried best-effort each tick until the label is observed gone from the PR.
