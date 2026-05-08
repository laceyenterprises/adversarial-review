# SPEC - Adversarial Review Auto-Remediation

_Status: Living contract_
_Related: `SPEC.md`, `docs/follow-up-runbook.md`_

## Adversarial Gate Commit Status

The watcher projects the durable adversarial-review ledger onto the PR head SHA as a GitHub commit status with context `agent-os/adversarial-gate`.

Operators must require `agent-os/adversarial-gate` in branch protection before relying on GitHub-native merge or auto-merge for adversarial-review-gated branches. Without the required context, GitHub can merge while review, remediation, or operator handling is still pending.

The watcher verifies that policy in process: on a cached interval it checks watched repositories' branch protection and logs `branch-protection-warning` when `agent-os/adversarial-gate` is missing or the protection endpoint cannot be read. Operators can run the same probe with `npm run check-branch-protection`.

State mapping:

| State | Meaning |
|---|---|
| `pending` | Review has not posted, review is queued/in progress, a posted review is waiting for the follow-up ledger to appear, remediation is queued/in progress, or a requested re-review has not posted yet. |
| `success` | The latest posted review settled as `Comment only` or `Approved`, or a current scoped `operator-approved` label accepts a final-round `Request changes` verdict after remediation rounds are exhausted. |
| `failure` | Review/remediation is malformed, failed, orphaned, stopped, missing a verdict, still blocked by `Request changes`, or in an unknown state. |

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
| `operator-approved` | `success` | A scoped operator approval accepts a final-round `Request changes` verdict after remediation rounds are exhausted. |
| `review-malformed` | `failure` | The review ledger is in a malformed-title terminal state. |
| `reviewer-timeout` | `failure` | The reviewer timed out before posting. |
| `reviewer-launchctl-bootstrap` | `failure` | The Claude launchctl/bootstrap path failed before posting. |
| `reviewer-cascade` | `failure` | The reviewer hit a LiteLLM/upstream cascade before posting. |
| `review-failed` | `failure` | The adversarial review failed before posting and no more specific class is known. |
| `review-failed-orphan` | `failure` | The watcher needs operator verification for a possible orphan review post. |
| `review-state-unknown` | `failure` | The durable review row contains an unexpected state. |
| `blocking-review` | `failure` | The latest review verdict still requests changes. |
| `override-remediation-claimable` | `failure` | A scoped operator override is present, but remediation rounds remain claimable. |
| `missing-verdict` | `failure` | The latest review body does not contain a usable verdict. |
| `unknown-verdict` | `failure` | The latest review body contains a malformed or unsupported verdict. |
| `remediation-failed` | `failure` | Follow-up remediation failed and needs operator action. |
| `remediation-stopped` | `failure` | Follow-up remediation stopped and needs operator action. |

The watcher must project the gate on terminal early-exit paths, including already-posted review rows. A settled PR must not stay frozen at an earlier `pending` projection after the durable review verdict is available.
