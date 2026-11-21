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
`CliDirectPreflightError` with `failureClass: cli-resolution-transient` and the CLI's
`<name>-path` layer, retaining resolver evidence on the cause; the runtime adapter
returns its existing preflight failure result without spawning a reviewer.

Protocol v1 optionally includes `launcher: { path, sha256, routeKey }`.
Both clients select that path for execution only after checking an absolute
path, a regular executable file without a final symlink, and a matching SHA-256
of the opened file at the launch boundary. The only accepted route keys are
`CLAUDE_CLI` and `CLAUDE_CODE_CLI_PATH`. Invalid launcher evidence fails closed
as `reviewer-configuration-error`, including through discovery and subprocess
failure classification; it never falls back to the underlying binary.
An omitted or explicitly null launcher uses `realPath`. Other malformed values
remain configuration errors. Changes to size, modification time or change time
during the file read fail closed with `launcher file modified concurrently`,
distinct from `launcher digest mismatch` for a stable file with the wrong hash.

Both synchronous and asynchronous clients retry resolution once, sizing each
nominal ten-second attempt through the shared load-aware timeout helper. The
first failed attempt emits no terminal resolution event; only retry exhaustion
logs an unknown outcome. A recovered retry logs only its resolved outcome. Protocol
v1 field validation remains mandatory. Pretty-printed JSON remains supported;
line-oriented output permits one valid protocol response alongside empty lines,
non-JSON banners or non-object JSON chatter (numbers, booleans, strings, null
and arrays). Multiple JSON objects, including two valid responses, are
refused. Invalid JSON records only stdout byte length, line count and whether a
single line validated as protocol v1, never the raw stdout.

Resolution failures do not isolate reviewer identities or contribute to
credential-outage accounting. The watcher records `cli-resolution-transient`
backoff (initially one minute), releases the claim to `pending` without charging
review or infrastructure recovery attempts below the existing five-consecutive
transient threshold, then uses bounded `pending-upstream` infrastructure
recovery. A successful review clears the backoff. Genuine reviewer OAuth
failures retain their authentication classification. Pipeline health/readyz and
Prometheus expose the resolution class separately from authentication failures.
Runtime readyz adds informational `reviewerFailures24h` with separate
`cli-resolution-transient` and `oauth-broken` counts from failed reviewer passes.
Missing/unreadable history is reported as unavailable, not zero. These counts
are diagnostics only and do not change readiness signals or `overallReady`.
Attribution and failure counts share one read-only database connection per
readyz invocation; query failures remain independently reported.

Before any helper or exec, `[review-cli-resolution]` logs the validated
`schemaVersion`, registry `cli`, `consumer`, `status`, `source`, `selectedPath`,
immutable `realPath`, `version`, `binarySha256` and UTC `timestamp`. Service/worker
logs also retain the optional validated `launcher`; the binary fields always
describe the underlying CLI, even when execution uses a launcher. Service/worker
logs retain that pre-exec JSON even when auth, catalog preparation or spawn
fails. Unknown events retain the CLI, timestamp and bounded reason; arbitrary
resolver output is not logged. Failure classification reads the latest resolution
event even when a worker or timestamp prefix precedes its marker, so a resolved
outcome supersedes an earlier unknown outcome. These records are version-scoped observations,
not a successful tool-event receipt. No review database schema or durable status additions. Exported legacy `*_CLI` constants identify registry names only; runtime
selection happens at the execution boundary.

Codex auth and model-catalog preparation use the same selected execution path as exec,
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
spawn suites use a synthetic installed resolver. Usage probes, portable-install
checks, account routing, remediation replies and conflict/fallback replay suites
also install that fixture; their mocked HQ dispatch accepts the fixture's absolute
path. These offline tests must never depend on an `hq` executable on the host.
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

Cli-direct discovery awaits `prepareServiceCodexHomeAsync` for credential
validation and catalog seeding; execution keeps the synchronous helper. Both
drive the same staging and cleanup protocol. The default async transport closes
probe stdin immediately and buffers stdout/stderr within the existing timeout
and output limits. Login recognition checks both streams; catalog stderr is
discarded after collection. Authentication failures and catalog warnings never
include raw subprocess output.

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

After auth is staged, service-home seeding runs the spawn's own Codex binary
with `debug models`, its isolated home and the same auth environment
(30-second timeout). Reviewer execution and discovery pin
`model-catalog.json` with the returned metadata intact, including `tool_mode`,
`supports_search_tool` and `experimental_supported_tools`. Missing capability
fields stay absent, and the reviewer uses the governed model with the existing
OAuth provider routing and Code Mode configuration. Local remediation
retains the CODEXHOMEISO-02 `model-catalog.direct-tools.json` policy, which
removes `tool_mode` and `supports_search_tool` for its direct-tool launch.
The private catalog must contain the exact resolved model slug.
Seeding writes the catalog before atomically setting the root
`model_catalog_json` in `config.toml`; reviewers also pass that pin through
`--config` because they retain `--ignore-user-config`. Probes share their seeded
home across compatibility checks. No interactive catalog/cache is read.

Catalog fetch, parse or pin failures warn and keep the server catalog so the
authenticated spawn proceeds. Authentication failure is never a catalog fallback.
Each spawn logs `model_catalog_json=<path>` (or `server` on
fallback) with its home and final config digest. Existing tool-host timeout
classification and bounded infrastructure refunds are unchanged.

On a nonzero native reviewer exec, the subprocess exit summary and bounded,
redacted terminal diagnostics reach the caller. Error stream events support
both nested `error.message` and flat `message` payloads, preferring a nonempty
nested message. Logger prefixes before the native exec failure marker do not
change its classification. The adapter applies the
existing auth, quota and upstream classifiers to that evidence. A generic
native exec failure uses the existing `reviewer-command-failed` recovery path,
including its posted-review probe and bounded retry budget. The Code Mode
capability and unstable-feature startup warnings do not establish the cause
of an exec failure.

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

Each one-shot `reviewer.mjs` process archives the reviewed commit SHA from a
local worktree whose GitHub `origin` matches the full target repository name.
It checks the service checkout, the superproject two levels up, and
`<ADVERSARIAL_REVIEWER_CLONE_ROOT>/<owner>/<repo>` in that order. Set
`ADVERSARIAL_REVIEWER_CLONE_ROOT` to an absolute path to make additional
checkouts available. An entry can point to a clone or an initialized submodule.
Argus uses the same checkout resolver for local dependency evidence.
Use the repository's original owner and name spelling on case-sensitive
filesystems. The resolver also tries the legacy lower-case clone path. It
canonicalizes the candidate and the Git-reported root with native realpaths
and compares the repository name case-insensitively.

Use a canonical `github.com` fetch origin in both the clone configuration and
the effective Git URL after `insteadOf` rewrites. Supported forms include HTTPS
with optional userinfo, `ssh://git@github.com/owner/repo`,
`ssh://github.com/owner/repo`, and `git@github.com:owner/repo`. A `.git` suffix
and trailing slashes are accepted. SSH aliases, alternate hosts and explicit
ports are unsupported. When configuring a clone, verify the configured and
effective origins against the intended repository locally. Report only the
host and owner/repository name and keep userinfo out of diagnostics. Review
logs and alerts use classified causes and never include the remote URL.

When the commit is absent, the reviewer attempts a bounded fetch of that SHA
from the matching origin without switching branches or updating the worktree.
Fetch disables auto-maintenance and retries transient transport failures up to
three attempts, sharing the archive retry classifier and caller Git environment.
Full 40- and 64-hex commit IDs are supported.
When no source matches, the fetch cannot materialize the commit, or Git cannot
archive it, the model gets an empty read-only cwd and the review body records
diff-only mode. The same repository identity rule applies to private, public,
and unknown-visibility targets. Preserved review bodies are eligible for
redelivery only when their workspace mode matches this run.

Production review context separately includes a file inventory fetched from the
requested full commit SHA through the Git trees API. Linked-document reads and
head-scoped context use that requested review head even if PR metadata advances.
The inventory prioritizes changed
paths within a 16 KiB path-line budget and repeats the same evidence in every
chunk. Capped, API-truncated, submodule-containing or unavailable inventories
cannot establish absence by omission. A complete inventory supports literal
path membership checks; it does not prove file contents or validator policy.
An empty workspace, partial diffs, rename records,
and historical PR scope prose cannot prove PR-head absence. Reviewers must
verify absence and app validator contracts at the exact reviewed head before
reporting them, while retaining independently actionable findings. The offline
fixture and separate deployment acceptance procedure are recorded in
[`changes/LAC-2215.md`](changes/LAC-2215.md).

`prepareReviewerSnapshot` rejects a symbolic link that resolves outside the
snapshot and discards the build. For a PR-head workspace, the reviewer recovers
with an empty diff-only cwd. The review can still produce a verdict. The
reviewer records the bounded causes `no-checkout`, `origin-unverified`,
`head-fetch-failed`, `archive-unavailable`, and `escaping-link` and keeps
per-repository counts. A snapshot-to-diff-only transition emits
`reviewer_workspace_degraded`. Operational transitions queue a
`reviewer.workspace_degraded` digest notice through the existing alert bus at
most once per repository per 24 hours. An escaping PR-authored link contributes
to the log and counter and does not queue a notice. A successful snapshot
allows a subsequent operational degradation to be reported.

The model subprocess always starts in a separate empty read-only directory.
When available, the read-only PR-head archive is supplied as an absolute evidence
path in the prompt. PR-authored `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, project
settings and hooks therefore cannot be discovered through the harness cwd.
Repository files remain untrusted evidence, including any instructions they contain.
Argus also starts its harness in an empty owned directory and keeps evidence
assembly in its separate scratch area. The dedicated Antigravity OS identity
uses a traversable, per-UID launcher directory under `/private/tmp` because
`sudo` retains the caller's cwd across the user switch. Its `--add-dir` points
to a copy of the empty workspace. The private snapshot path does not grant the
separate OS identity access to the owner-only archive. That identity can use
the supplied exact-head review evidence and diff.

Reviewer snapshots and workspace audits use `ADVERSARIAL_REVIEW_WORKSPACE_STATE_DIR` when set. If the normal `ADVERSARIAL_REVIEW_STATE_DIR` is already outside the target checkout, service checkout and detected service superproject, they use it. Otherwise they use `$HQ_ROOT/adversarial-review/reviewer-workspace`, falling back to `~/.agent-os/adversarial-review/reviewer-workspace` when `HQ_ROOT` is unset. The review ledger and fence state keep their existing location. The reviewer refuses a workspace state directory inside any of those source checkouts.
The state fence also checks canonical paths for Git worktree ancestry.
Harness startup refuses project instructions, settings, and MCP configuration
in the cwd's ancestry. The harnesses retain their trusted user-level settings.

A cache miss runs `git archive` and tar extraction for the entire exportable
tree at the reviewed commit, validates symlinks, and removes write permissions.
Each distinct head pays that CPU, disk and I/O cost once per cached build.
The cache records byte totals during link validation so collection can account
for warm entries using their markers. Legacy or invalid byte totals fall back
to a symlink-safe walk. An archive restricted to changed paths would omit
unchanged callers, validators and linked files. Review evidence must preserve
that context, and even a full Git archive can omit submodules and paths marked
`export-ignore`. Use the separately reported inventory completeness for
absence claims.

The workspace state directory contains:

- `reviewer-snapshots/<repo-key>/<reviewed-sha>/`: immutable cached archive and `.reviewer-snapshot.json` marker. The cache may be deleted when no reviewer is using it and will be rebuilt. Collection retains active reviewer and subprocess-group pins and applies the age, count and byte limits. Defaults are seven days, eight entries and 4 GiB per repository. A failed cleanup is logged and does not block a review.
- `reviewer-harness-cwds/run-<pid>-<nonce>/cwd`: empty read-only startup directory. The next workspace allocation reclaims residue only after the owner and registered subprocess groups are dead. Positive or unknown liveness, including an interrupted spawn with no confirmed group, holds the directory. The dedicated Antigravity launcher uses the same rule in its UID-owned root.
- `reviewer-workspace-audit/modes/<repo-key>.json`: last mode, bounded cause counts and operational-notice debounce state. [Record format](data-model/reviewer-workspace-state.md)
- `reviewer-workspace-audit/live-<pid>`: an in-flight reviewer marker, removed after its subprocess settles. Inspect the PID before removing a stale marker.
- `reviewer-workspace-audit/reviewer-workspace-escapes.jsonl`: advisory before/after checkout differences during a model subprocess. Each event records checkout HEADs. When HEAD moves, the audit subtracts paths changed by the commit range only if their index and working-tree state match the new HEAD. Any remaining paths use `ambiguous: false` and `attribution: unattributed`. If the commit diff or new-HEAD comparison fails, the full changed set retains `ambiguous: true` and `attribution: checkout-head-moved`. Even `unattributed` is evidence to investigate, not proof the model wrote the path. Concurrent reviewers and operators can also change the shared tree.
- `reviewer_workspace_head_moved`: a log-only record when all observed changes are explained by the checkout advance, including both HEADs and `explainedPathCount`. These reviews do not append to the escape ledger.
- `reviewer-workspace-audit/reviewer-workspace-audit-errors.jsonl`: failed pre/post probes. A failed probe never becomes a synthetic escape event.

For dirty or untracked files larger than 8 MiB, the audit compares size, mode, mtime, and ctime instead of reading the whole file into memory. The audit context is process-local mutable state because `reviewer.mjs` handles exactly one PR per process. If the reviewer is ever reused for multiple PRs in one process, pass context explicitly to each spawn before enabling that mode.

The commit-range diff includes submodule pointer changes so a checkout advance can explain them. The new-HEAD working-tree comparison ignores submodules, matching the status probe: an un-updated submodule checkout or local submodule build noise does not prevent attribution to the deploy. Each diff probe retries recognized transient Git failures up to three total attempts with 100/200 ms backoff. Permanent failures and exhausted retries retain the conservative ambiguous escape record described above.

The oversized-review summarisation callback keeps the reviewed checkout as its
Git-only content source (`git diff`/`git show`). It does not select a model cwd:
normal, retry and chunk model paths receive the separately allocated empty
`reviewerSubprocessCwd`. Trusted home-level `.mcp.json`, like the existing
`.claude`, `.codex` and `.gemini` user settings, is exempt from project-ancestor
rejection; the same file in a PR or another ancestor remains refused. Repository
identity verifies the first configured origin URL and Git's effective fetch URL,
not additional configured URLs that Git does not fetch.
