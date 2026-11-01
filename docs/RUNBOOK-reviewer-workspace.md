# Reviewer workspace snapshots and audit

## Managed CLI resolution (HUP-05N)

The review service calls the trusted installed command through `HQ_BIN` (default
`hq` on the installation PATH), using an argv array:
`hq cli resolve --cli <registry-name> --consumer review --json`.
Claude Code uses `claude`; native Codex, Gemini and direct agy use their registry
names. Reviewer execution, cli-direct discovery, remediation OAuth preflight and
local remediation all consume protocol v1 through `src/review-cli-resolver.mjs`.
HQ-owner agy startup/readiness probes resolve through the same client, and their
success-cache identity includes that immutable executable path.
There is no local binary precedence or resolver-error fallback. The producer's
review profile owns existing explicit environment overrides, managed current,
and caller legacy fallbacks; an absent managed installation permits fallback
only when the producer returns it. Invalid explicit or managed selections refuse
launch. Missing hq, malformed/incomplete JSON, nonzero exit or the bounded
10-second resolver timeout produce `status: unknown`, never managed health.

Async reviewer launches, OAuth probes and cli-direct discovery await nonblocking
resolver subprocesses. Legacy synchronous path exports and local remediation
spawn contracts retain bounded synchronous resolution. Both clients validate and log the same protocol evidence
before helpers or execution. Discovery translates unknown resolution into
`CliDirectPreflightError` with `failureClass: oauth-broken` and the CLI's
`<name>-path` layer, retaining resolver evidence on the cause; the runtime adapter
returns its existing preflight failure result without spawning a reviewer.

Before any helper or exec, `[review-cli-resolution]` logs the validated
`schemaVersion`, registry `cli`, `consumer`, `status`, `source`, `selectedPath`,
immutable `realPath`, `version`, `binarySha256` and UTC `timestamp`. Service/worker
logs retain that pre-exec JSON even when auth, catalog preparation or spawn
fails. Unknown events retain the CLI, timestamp and bounded reason; arbitrary
resolver output is not logged. These records are version-scoped observations,
not a successful tool-event receipt. No review database shape or lifecycle state
changes. Exported legacy `*_CLI` constants identify registry names only; runtime
selection happens at the execution boundary.

Codex auth and model-catalog preparation use the same `realPath` as exec,
including after a managed-current or Homebrew symlink changes. A subsequent
launch resolves afresh. Catalog fallback remains governed by CODEXHOMEISO-02;
it never selects another executable. Added agy holders still use their existing
root-owned pinned-command boundary; this change does not alter privileged
commands, sudo policy or holder deployment.

HUP-09 must deploy the reviewed service and HUP-05 installed resolver together
through the normal administrator installation procedure, then refresh/restart
the review services and verify their loaded builds. Follow convergence review
and normal gate-keeper review/merge rules. Retain the next organic managed
review consumer record, its pre-exec source/path/version/digest observation,
and a real tool event tied to that launch/root outcome. Source merge and
synthetic tests alone do not establish activation or live acceptance. No worker
host install, service restart, Homebrew operation or live canary is authorized.

Offline evidence uses disposable synthetic resolver executables and fabricated
tool output. `test/review-cli-resolver.test.mjs` covers protocol validation,
managed/override/fallback responses, argv/environment forwarding, unknown errors
and timeout, sibling resolver routing, and Codex helper/exec immutability across
a version flip and spawn failure. Existing reviewer, discovery and remediation
spawn suites use a synthetic installed resolver.
Implementation validation ran under netguard through bounded
`cwp_dispatch.worker_validation`: 1,052/1,052 tests across the 13 scoped resolver,
reviewer, remediation, discovery, Codex-home and agy suites passed. `npm run lint`
had zero errors; `npm run typecheck:contracts` and
`bash demo/research-finding-walkthrough.sh` passed. Full platform suites and live
consumer verification are outside this source-validation evidence.

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
config or project-trust history is imported.

LAC-2131: `CODEX_AUTH_PATH` selects the AR credential source; the deployed Codex
CLI does not consume that variable. Before replacing the incoming `CODEX_HOME`,
the shared service-home helper selects explicit `CODEX_AUTH_PATH`, otherwise
`auth.json` in incoming `CODEX_HOME`, otherwise `~/.codex` under incoming `HOME`.
Existing personal/corporate materialization and broker routing still own source
selection and refresh. Corporate staging remains mandatory, including when the
personal per-worker kill switch is disabled.

The service writes an independent mode-0600 OAuth snapshot under its mode-0700
`CODEX_HOME/auth.json`, with `cli_auth_credentials_store = "file"` in the reviewed
template. It allowlists ChatGPT access/ID/account fields and replaces the refresh
token with the existing per-worker non-rotating sentinel; no shared refresh
token, embedded API key, source metadata or interactive config is copied. The
deployed CLI's legacy token-bearing files without `auth_mode` are normalized
to explicit ChatGPT mode; explicit non-ChatGPT modes are refused. The
snapshot is never linked or written back to its source. `CODEX_AUTH_PATH` in the
child names this effective file for AR evidence, but CLI authentication depends
on the supported home/file-store boundary. OAuth fallback environment variables
are stripped. The selected binary must pass offline `login status` as ChatGPT
using that effective home before `debug models`, output descriptors or paid
`exec` requests. Missing/unreadable/malformed auth or a rejected CLI boundary
raises the existing `OAuthError` before those side effects; diagnostics omit raw
auth/parser output. This proves local credential consumption, not remote token
validity. Broker refresh/recovery retains its existing owner.

The reviewer retains `--ignore-user-config` and passes the same reviewed tooling
pins (including the file-store setting) as CLI overrides. Reviewer/probe homes are removed after use; remediation
homes retain sessions under `<codexHome>/sessions` without `--ephemeral`,
regardless of per-worker credential materialization. Preparation and spawn
failures remove their service home and any staging owned by that caller.
Direct remediation releases its owned staging after the independent snapshot
passes preflight, and removes only its service credential on child exit.
A persisted `codexAuthOwnerId` matches `.service-auth-owner` in that exact
temporary home so terminal reconciliation after a daemon restart can remove
the same credential while retaining sessions. Legacy or mismatched receipts
are no-ops; source credentials and other workers' homes are never cleanup targets.
Reviewer/discovery adapter owners retain responsibility for their own staging.
Logs include `CODEX_HOME` and `config_sha256` without auth data.

CODEXHOMEISO-02: after auth is staged, shared service-home seeding runs the
spawn's own Codex binary with `debug models`, its isolated home and the same
auth environment (30-second timeout). It removes `tool_mode` and
`supports_search_tool` from every model, preserving other metadata including
`experimental_supported_tools`. Omitted search support defaults to false, so
direct MCP tools remain available without advertising unsupported tool discovery.
The private `model-catalog.direct-tools.json` must include the resolved model.
Seeding writes the catalog before atomically setting the root
`model_catalog_json` in `config.toml`; reviewers also pass that pin through
`--config` because they retain `--ignore-user-config`. Probes share their seeded
home across compatibility checks. No interactive catalog/cache is read.

Catalog fetch, parse or pin failures warn and keep the server catalog so the
authenticated spawn proceeds. Authentication failure is never a catalog fallback.
Each spawn logs `model_catalog_json=<path>` (or `server` on
fallback) with its home and final config digest. Existing tool-host timeout
classification and bounded infrastructure refunds are unchanged.

After ordinary deployment, SRE should retain the next organic Codex remediation
receipt showing shell execution, a re-review request, and the isolated home and
digest in its spawn log. Also confirm that home contains the pinned catalog,
the log names its path, and the round has no code-mode host errors.
Publication and offline tests do not establish that live receipt. Recovery
requires separate proofs: settled cross-model review and merge of the source
PR; parent submodule pointer advancement; ordinary deployment of those source
bytes; and organic successful authenticated remediation followed by re-review.
Do not re-login, rotate shared tokens, alter provider routing, cancel healthy
rescue/closer workers or bypass gates to obtain those proofs. This change
requires no config flip or new smoke command. See the
[SEV2 RCA](postmortems/SEV2-LAC-2131-codex-service-home-auth-2026-10-30.md).

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
