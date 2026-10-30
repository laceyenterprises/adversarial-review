# Reviewer workspace snapshots and audit

CODEXHOMEISO-01: every native Codex launch owned by the review service uses a
fresh mode-0700 service directory as `CODEX_HOME`. Local remediation uses
`spawnCodexRemediationWorker`; reviewer execution uses `spawnCodexReview`;
reviewer discovery uses `probeCodexCli` for `--version`, `sessions list`, the
`login status` compatibility fallback, and optional `mcp list`. HQ dispatch
delegates process creation to the orchestrator's existing isolated worker home.

`src/codex-service-config.toml` is the reviewed tooling template. Model and effort
come from the existing service resolver. Approval and sandbox values match the
existing bypass flags. The template pins shell/unified execution and code mode,
disables app/plugin loading and hooks, and declares no MCP servers, marketplaces
or desktop configuration. Each home trusts only its job workspace. No interactive
config or project-trust history is imported. An explicit per-worker auth path
remains `CODEX_AUTH_PATH`; config isolation never copies credentials. Existing
credential materialization, broker selection and OAuth-only rules still apply.
The reviewer retains `--ignore-user-config` and passes the same reviewed tooling
pins as CLI overrides. Reviewer/probe homes are removed after use; remediation
homes remain temporary job artifacts for session evidence. Spawn failures remove
their config home. Logs include `CODEX_HOME` and `config_sha256` without auth data.

After ordinary deployment, SRE should retain the next organic Codex remediation
receipt showing shell execution, a re-review request, and the isolated home and
digest in its spawn log. Publication and offline tests do not establish that live
receipt. This change requires no config flip or new smoke command.

Each one-shot `reviewer.mjs` process gives its model a read-only `git archive` snapshot of the repository's current default checkout HEAD. The PR diff is supplied separately. This snapshot is **not** the PR head or necessarily its merge base. The prompt names it accordingly.

`prepareReviewerSnapshot` rejects a symbolic link that resolves outside that snapshot. Such a link is in the **base checkout**, so the reviewer queues an operator alert, exits with an infrastructure error, and posts no verdict about the PR. Repair the base checkout through its normal PR and deploy path, then retrigger the review. Do not ask the PR author to remove a link they did not introduce. Archive failures and validation failures also leave the PR without a synthetic review.

Reviewer snapshots and workspace audits use `ADVERSARIAL_REVIEW_WORKSPACE_STATE_DIR` when set. If the normal `ADVERSARIAL_REVIEW_STATE_DIR` is already outside the source checkout, they use it. Otherwise they use `$HQ_ROOT/adversarial-review/reviewer-workspace`, falling back to `~/.agent-os/adversarial-review/reviewer-workspace` when `HQ_ROOT` is unset. The review ledger and fence state keep their existing location. The reviewer refuses a workspace state directory inside the source checkout.

The workspace state directory contains:

- `reviewer-snapshots/<repo-key>/<checkout-head>/`: immutable cached archive and `.reviewer-snapshot.json` marker. The cache may be deleted when no reviewer is using it; it will be rebuilt. Old entries are collected after seven days. A failed cleanup is logged and does not block a review.
- `reviewer-workspace-audit/live-<pid>`: an in-flight reviewer marker, removed after its subprocess settles. Inspect the PID before removing a stale marker.
- `reviewer-workspace-audit/reviewer-workspace-escapes.jsonl`: advisory before/after checkout differences during a model subprocess. Each event records checkout HEADs. When HEAD moves, the audit subtracts paths changed by the commit range only if their index and working-tree state match the new HEAD. Any remaining paths use `ambiguous: false` and `attribution: unattributed`. If the commit diff or new-HEAD comparison fails, the full changed set retains `ambiguous: true` and `attribution: checkout-head-moved`. Even `unattributed` is evidence to investigate, not proof the model wrote the path. Concurrent reviewers and operators can also change the shared tree.
- `reviewer_workspace_head_moved`: a log-only record when all observed changes are explained by the checkout advance, including both HEADs and `explainedPathCount`. These reviews do not append to the escape ledger.
- `reviewer-workspace-audit/reviewer-workspace-audit-errors.jsonl`: failed pre/post probes. A failed probe never becomes a synthetic escape event.

For dirty or untracked files larger than 8 MiB, the audit compares size, mode, mtime, and ctime instead of reading the whole file into memory. The audit context is process-local mutable state because `reviewer.mjs` handles exactly one PR per process. If the reviewer is ever reused for multiple PRs in one process, pass context explicitly to each spawn before enabling that mode.

The commit-range diff includes submodule pointer changes so a checkout advance can explain them. The new-HEAD working-tree comparison ignores submodules, matching the status probe: an un-updated submodule checkout or local submodule build noise does not prevent attribution to the deploy. Each diff probe retries recognized transient Git failures up to three total attempts with 100/200 ms backoff. Permanent failures and exhausted retries retain the conservative ambiguous escape record described above.
