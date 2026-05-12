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

## Round-Budget Derivation

Every fresh follow-up job derives its default cap from the PR's current risk class: `low=1`, `medium=2`, `high=3`, and `critical=4`. The PR-wide completed-round count is carried into each new job, so the cap bounds the full PR cycle instead of resetting per job.

Carry-forward of ordinary persisted caps is intentionally removed: if the latest stored cap is equal to or below the current risk-class tier, the next job lets `createFollowUpJob` derive the current tier cap again. This keeps stale queue JSON from permanently lifting or lowering the remediation budget after the PR's governing risk class changes.

The migration guard is deliberately narrow. If the latest PR ledger cap is higher than the current risk-class tier, the reviewer carries that elevated value into the next job. That preserves legacy in-flight PRs and operator-raised escape hatches that would otherwise be silently truncated after they have already consumed more rounds than the new tier allows.

The sanctioned operator override is `npm run retrigger-remediation` or the PR-side `retrigger-remediation` label. Both paths record an explicit operator mutation; hand-editing queue JSON is not the supported way to raise the cap.
