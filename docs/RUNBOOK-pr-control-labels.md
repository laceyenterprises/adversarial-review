# PR Control Labels Runbook

This table is the operator-facing source of truth for labels that change the
adversarial-review, remediation, AMA, or merge-agent control flow.

| Label | Scope | Authority / Audit | Effect |
|---|---|---|---|
| `operator-approved` | Current PR head SHA | Attributable scoped label event with event id/node id and timestamp. Single-operator deployments may use same-login evidence; freshness and head scope remain mandatory. | Bypasses adversarial review/remediation state for merge-agent and gate decisions, while preserving open-PR, hard-skip, mergeability, and green-check gates. |
| `operator-approved: advisory-only-review` | Current PR head SHA reviewed by the reviewer process | Attributable non-author scoped `LabeledEvent` with event id/node id, timestamp, and current-head scope. Author self-application, `unknown` actor, missing event id, stale head scope, or reviewer/live-head mismatch fails closed to enforcement mode. | Posts the review with an advisory-only header and skips automatic follow-up remediation job creation. The posted review row still exists; a `Request changes` advisory review can still block the adversarial gate until an operator handles it manually or removes/replaces the label and triggers a normal review. |
| `adversarial-merge-requested` | Current PR head SHA | Attributable non-author scoped label event. | AMA-only request to evaluate closure for otherwise risk-class-blocked PRs. It does not trigger merge-agent fallback. |
| `adversarial-merge-blocked` | Current PR head SHA | Raw label presence is a hard stop unless attributable current-head evidence proves the latest block event is stale or unapplied. | AMA-only block label. Authors may apply it to block their own PR. |
| `merge-agent-requested` | Current PR head SHA | Attributable scoped label event with event id/node id and timestamp. | Requests a merge-agent pass for the current head, preserving open-PR, hard-skip, active-remediation, and duplicate-dispatch guards. |
| `merge-agent-skip`, `do-not-merge`, `no-merge-hold` | PR-wide while present | Raw label presence. | Hard skips that operator-approved and merge-agent-requested do not bypass. |
| `merge-agent-stuck` | PR-wide while present, with current-head recovery exception | Raw label presence blocks by default; scoped `merge-agent-requested` may bypass for explicit recovery. | Marks PRs that need operator attention after merge-agent or watcher convergence stalls. |
