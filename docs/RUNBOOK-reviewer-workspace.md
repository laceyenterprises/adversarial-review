# Reviewer workspace snapshots and audit

Each one-shot `reviewer.mjs` process gives its model a read-only `git archive` snapshot of the repository's current default checkout HEAD. The PR diff is supplied separately. This snapshot is **not** the PR head or necessarily its merge base. The prompt names it accordingly.

`prepareReviewerSnapshot` rejects a symbolic link that resolves outside that snapshot. Such a link is in the **base checkout**, so the reviewer queues an operator alert, exits with an infrastructure error, and posts no verdict about the PR. Repair the base checkout through its normal PR and deploy path, then retrigger the review. Do not ask the PR author to remove a link they did not introduce. Archive failures and validation failures also leave the PR without a synthetic review.

The state directory contains:

- `reviewer-snapshots/<repo-key>/<checkout-head>/`: immutable cached archive and `.reviewer-snapshot.json` marker. The cache may be deleted when no reviewer is using it; it will be rebuilt. Old entries are collected after seven days. A failed cleanup is logged and does not block a review.
- `reviewer-workspace-audit/live-<pid>`: an in-flight reviewer marker, removed after its subprocess settles. Inspect the PID before removing a stale marker.
- `reviewer-workspace-audit/reviewer-workspace-escapes.jsonl`: advisory before/after checkout differences during a model subprocess. Each event records checkout HEADs; `ambiguous: true` and `attribution: checkout-head-moved` mean main-catchup or another checkout advance could explain it. Even `unattributed` is evidence to investigate, not proof the model wrote the path. Concurrent reviewers and operators can also change the shared tree.
- `reviewer-workspace-audit/reviewer-workspace-audit-errors.jsonl`: failed pre/post probes. A failed probe never becomes a synthetic escape event.

For dirty or untracked files larger than 8 MiB, the audit compares size, mode, mtime, and ctime instead of reading the whole file into memory. The audit context is process-local mutable state because `reviewer.mjs` handles exactly one PR per process. If the reviewer is ever reused for multiple PRs in one process, pass context explicitly to each spawn before enabling that mode.
