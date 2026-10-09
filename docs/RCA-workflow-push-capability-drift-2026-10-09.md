# WFDRIFT-01: workflow permission drift after remediation starts

Incident: [LAC-1899](https://linear.app/laceyenterprises/issue/LAC-1899) (SEV3).
Example: [Agent OS PR #7922](https://github.com/laceyenterprises/agent-os/pull/7922).

## Failure

The original reviewed PR did not change a workflow. Pre-spawn capability detection therefore selected the physical Codex App's contents-only transport. CI remediation subsequently added `.github/workflows/repo-guards.yml`. The worker completed the review fixes and CI repair, but GitHub refused the push because that App lacks workflows permission. Re-minting its same entitlement did not change permission. Local commits remained unpublished through `8c1423b2f173d61bff22b05334277765fdd6b9f5`, and the normal 2/2 round cap stopped further model work.

This is a publication capability change during execution, separate from LIVEEMIT-02's missing mid-turn usage defect. The reviewed file snapshot cannot predict changes a remediator will add later. Native GitHub-auth recovery also classified an explicit workflow-permission denial as terminal, preventing its existing preserved-commit publisher from using the already supported scoped workflow transport.

## Narrow repair

Only an explicit workflow scope/permission denial becomes a recovery candidate. Revoked entitlements, inaccessible installations and contents authorization failures remain terminal. Before publication, native reconcile preserves and verifies a Git bundle. The workflow candidate publisher proves paths in the actual outgoing commit history against the recorded remote-head lease; a workflow edit reverted in the final tree still counts. Unknown, truncated, empty or non-workflow evidence does not authorize escalation.

For proven workflow history, the existing merge-agent broker capability probe provides a fresh App token in an isolated transport environment. The same provider/pin wiring used by workflow-aware remediation spawns applies. Operator/PAT fallback is disabled for this invocation. The physical worker's model, commit author and provenance trailers are preserved. The workflow escalation kill switch remains effective, as do budgets and remediation caps.

The publisher reads the live PR head before its exact-lease push. If another owner already published the target, it records `already-published` without claiming a new recovery push. Publication uses one explicit HTTPS destination with the broker credential, so an inherited SSH or second pushurl cannot substitute another identity. After publication, including an ambiguous multi-transport push error, an actual Git update transcript and a fresh exact-target head read are required. Uncertain evidence never claims success.

A native publication receipt can resolve only the corresponding historical workflow permission blocker, after the existing independent worker/trailer/patch-equivalence push proof and exact-head pending/green CI proof. The original reply remains immutable and completion records the projection's audit disposition. Operator publication, missing or mismatched proof, failed recovery, red/unknown CI and unrelated blockers remain blocked. This change does not manufacture worker completion, bypass CI/review, reset a cap, or grant merge authority.

## Offline proof

The original seven-case fixture failed deterministically in six cases on unfixed source; ordinary auth recovery passed. The expanded final 31-case fixture failed 15 cases on the original source, with all 16 original completion tests passing. The fixed suite adds native Git history, actual scoped push-shell execution and native bundle/reconcile coverage. Fixture tokens are inert and no GitHub, broker, provider or live host mutation is used.

The native bundle test preserves the 2/2 plan and suppresses comment-only re-review. Existing auth expiry, shim, remote-head lease and rebase tests verify physical entitlement behavior is unchanged. Full repository lint, tests, contract typecheck and research walkthrough are required before publication.

## Rollout proof

Source review/merge, submodule-pointer deployment and loaded daemon ancestry must be verified separately. Do not re-run PR #7922's stopped model worker or change its cap to validate this fix. A naturally occurring late workflow repair and reconcile's exact-head publication evidence are production proof; offline fixtures are regression proof only.
